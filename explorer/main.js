'use strict';
// MediaExplorer - a browser for media on any disk, built to stay fast at the
// scale of whole drives.
//
// Three processes do the work, and this one mostly introduces them:
//   * the indexer (utility process): the in-memory index, the scanning
//     threads, folder watchers and the index file. The window talks to it over
//     a MessagePort of its own, so listings and searches never pass through
//     here.
//   * the window: a virtualised grid that only ever builds the cells on
//     screen.
//   * hidden thumbnail windows: decode images in worker threads and call the
//     OS thumbnailer, so neither this process nor the window's thread does.
// What stays here: the thumb:// protocol (served from the disk cache), menus,
// drag-out, and handing files to MediaInspector_Pro.

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu, protocol, utilityProcess, MessageChannelMain, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { ThumbService } = require('./thumbs/service');

// Thumbnails, the index and Chromium's own caches are machine-local and can be
// large: on Windows they belong in Local, not in a roaming profile.
app.setName('MediaExplorer');
if (process.env.MX_DATA) app.setPath('userData', process.env.MX_DATA);
else if (process.platform === 'win32' && process.env.LOCALAPPDATA) app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'MediaExplorer'));

protocol.registerSchemesAsPrivileged([
  { scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const DATA = app.getPath('userData');
const STATE_FILE = path.join(DATA, 'window.json');
const ARGS = process.argv.slice(app.isPackaged ? 1 : 2);
const argOf = (name) => {
  const a = ARGS.find((x) => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : null;
};

let win = null;
let indexer = null;
let indexerReady = false;
let thumbs = null;
const thumbWins = [];
let quitting = false;

// ---------------------------------------------------------------- project

// The player lives in the same project. Walk up from wherever this is running
// to find it, the same way the player finds its own config.
function projectRoot() {
  const starts = [path.dirname(app.getPath('exe')), __dirname];
  for (const s of starts) {
    let dir = s;
    for (let i = 0; i < 6 && dir; i++) {
      if (fs.existsSync(path.join(dir, 'config', 'scripts', 'mediainspector.lua'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

const ROOT = projectRoot();

function findPlayer() {
  if (process.platform !== 'win32' || !ROOT) return null;
  const packaged = path.join(ROOT, 'dist', 'MediaInspector_Pro-win32-x64', 'MediaInspector_Pro.exe');
  if (fs.existsSync(packaged)) return { cmd: packaged, args: [] };
  const electron = path.join(ROOT, 'app', 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(electron)) return { cmd: electron, args: [path.join(ROOT, 'app')] };
  return null;
}

// The player keeps a single window and loads a second launch's file into it,
// so this is cheap after the first time.
function openInPlayer(file) {
  const p = findPlayer();
  if (!p) return shell.openPath(file).then((err) => !err);
  const child = spawn(p.cmd, [...p.args, file], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => shell.openPath(file));
  child.unref();
  return Promise.resolve(true);
}

// ---------------------------------------------------------------- state

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}

function writeState(s) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch (e) { /* not worth failing a quit over */ }
}

// ---------------------------------------------------------------- indexer

function startIndexer() {
  indexer = utilityProcess.fork(path.join(__dirname, 'indexer', 'main.js'), [], {
    serviceName: 'MediaExplorer Indexer',
    stdio: 'inherit',
  });
  indexer.on('message', onIndexerMessage);
  indexer.on('exit', () => {
    indexer = null;
    indexerReady = false;
    // The page keeps running; it gets a port to the new indexer when ready.
    if (win && !win.isDestroyed()) wantsPort = true;
    // Never leave the window without an index: start again and reconnect.
    if (!quitting) setTimeout(() => { startIndexer(); }, 500);
  });
  indexer.postMessage({ type: 'init', dataDir: path.join(DATA, 'index'), threads: +argOf('threads') || 0 });
}

const indexerCalls = new Map();
let indexerSeq = 0;
let flushed = null;

function onIndexerMessage(msg) {
  if (msg.type === 'ready') {
    indexerReady = true;
    connectWindow();
  } else if (msg.type === 'reply') {
    const cb = indexerCalls.get(msg.rid);
    indexerCalls.delete(msg.rid);
    if (cb) cb(msg);
  } else if (msg.type === 'flushed' && flushed) {
    flushed();
  }
}

function callIndexer(op, args) {
  if (!indexer) return Promise.reject(new Error('indexer not running'));
  const rid = ++indexerSeq;
  return new Promise((resolve, reject) => {
    indexerCalls.set(rid, (m) => (m.error ? reject(new Error(m.error)) : resolve(m.result)));
    indexer.postMessage({ type: 'call', rid, op, args });
  });
}

// One end to the indexer, the other to the page. Done again whenever either
// side is new (a reload, an indexer restart).
// The page asks for a port once its preload is listening (want-port), so a port
// is never posted into a page that is still loading and lost.
let wantsPort = false;
function connectWindow() {
  if (!win || win.isDestroyed() || !indexer || !indexerReady || !wantsPort) return;
  wantsPort = false;
  const { port1, port2 } = new MessageChannelMain();
  indexer.postMessage({ type: 'port' }, [port1]);
  win.webContents.postMessage('index-port', null, [port2]);
}

// ---------------------------------------------------------------- thumbnails

// The pool of hidden windows that make thumbnails. Each takes a few jobs at
// once: its workers decode in parallel, and OS thumbnails run one at a time
// on its own thread.
const tw = {
  jobs: new Map(),
  seq: 0,
  shell: false,
  canShell() { return this.shell; },
  call(kind, args) {
    const live = thumbWins.filter((t) => t.ready && !t.win.isDestroyed());
    if (!live.length) return Promise.reject(new Error('no thumbnailer'));
    const t = live.reduce((a, b) => (b.load < a.load ? b : a));
    const jid = ++this.seq;
    t.load++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(jid);
        t.load--;
        reject(new Error('timeout'));
      }, 30000);
      this.jobs.set(jid, { resolve, reject, t, timer });
      t.win.webContents.send('job', { jid, kind, ...args });
    });
  },
};

ipcMain.on('thumb-done', (e, { jid, data, err }) => {
  const j = tw.jobs.get(jid);
  if (!j) return;
  tw.jobs.delete(jid);
  clearTimeout(j.timer);
  j.t.load--;
  if (err || !data || !data.length) j.reject(new Error(err || 'empty'));
  else j.resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
});

ipcMain.on('thumb-ready', (e, info) => {
  const t = thumbWins.find((x) => !x.win.isDestroyed() && x.win.webContents === e.sender);
  if (t) t.ready = true;
  tw.shell = tw.shell || !!info.canShell;
});

function startThumbnailers() {
  // Windows' shell thumbnailer is synchronous per call, so two windows give
  // it two threads; elsewhere one window's workers are the parallelism.
  const count = process.platform === 'win32' ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const w = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'thumbs', 'thumb-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    const t = { win: w, ready: false, load: 0 };
    thumbWins.push(t);
    w.loadFile(path.join(__dirname, 'thumbs', 'thumbnailer.html'));
    w.webContents.on('render-process-gone', () => {
      thumbWins.splice(thumbWins.indexOf(t), 1);
      for (const [jid, j] of tw.jobs) if (j.t === t) { tw.jobs.delete(jid); clearTimeout(j.timer); j.reject(new Error('crashed')); }
      if (!quitting) setTimeout(startThumbnailers, 1000);
      try { w.destroy(); } catch (e) { /* gone */ }
    });
  }
}

function startThumbs() {
  const toolDirs = ROOT ? [path.join(ROOT, 'tools')] : [];
  thumbs = new ThumbService({
    dir: path.join(DATA, 'thumbs'),
    renderers: tw,
    toolDirs,
    // Only if the hidden window cannot reach the OS thumbnailer itself.
    shellInMain: process.platform === 'win32' || process.platform === 'darwin'
      ? async (p, w) => {
        const img = await nativeImage.createThumbnailFromPath(p, { width: w, height: w });
        return img.isEmpty() ? null : img.toJPEG(82);
      }
      : null,
  });
  protocol.handle('thumb', (req) => thumbs.handle(req));
  startThumbnailers();
}

// ---------------------------------------------------------------- places

async function drives() {
  const out = [];
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
    // Probed in parallel, each with a deadline: an empty card reader or a
    // dead network mapping must not hold up the sidebar.
    const probe = (l) => new Promise((resolve) => {
      const p = l + ':\\';
      const t = setTimeout(() => resolve(null), 1500);
      fs.promises.statfs(p).then((s) => {
        clearTimeout(t);
        resolve({ path: p, name: l + ':', total: s.blocks * s.bsize, free: s.bavail * s.bsize });
      }).catch(() => { clearTimeout(t); resolve(null); });
    });
    for (const d of await Promise.all(letters.map(probe))) if (d) out.push(d);
    return out;
  }
  const roots = ['/'];
  const user = os.userInfo().username;
  const mountDirs = process.platform === 'darwin' ? ['/Volumes'] : ['/media/' + user, '/run/media/' + user, '/mnt', '/media'];
  for (const m of mountDirs) {
    try {
      for (const n of fs.readdirSync(m)) {
        const p = path.join(m, n);
        if (n === user && m === '/media') continue;
        try { if (fs.statSync(p).isDirectory()) roots.push(p); } catch (e) { /* unreadable */ }
      }
    } catch (e) { /* no such mount dir */ }
  }
  for (const p of roots) {
    try {
      const s = await fs.promises.statfs(p);
      out.push({ path: p, name: p === '/' ? 'File system' : path.basename(p), total: s.blocks * s.bsize, free: s.bavail * s.bsize });
    } catch (e) { /* gone */ }
  }
  return out;
}

function places() {
  const list = [];
  const add = (name, key) => {
    try {
      const p = app.getPath(key);
      if (p && fs.existsSync(p)) list.push({ name, path: p, icon: key });
    } catch (e) { /* not on this platform */ }
  };
  add('Home', 'home');
  add('Desktop', 'desktop');
  add('Pictures', 'pictures');
  add('Videos', 'videos');
  add('Music', 'music');
  add('Downloads', 'downloads');
  if (ROOT && fs.existsSync(path.join(ROOT, 'Exports'))) list.push({ name: 'Exports', path: path.join(ROOT, 'Exports'), icon: 'exports' });
  return list;
}

// ---------------------------------------------------------------- window

function createWindow() {
  nativeTheme.themeSource = 'dark';
  const st = readState();
  const b = st.win || {};
  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width || 1400,
    height: b.height || 900,
    minWidth: 720,
    minHeight: 420,
    backgroundColor: '#0d0d11',
    title: 'MediaExplorer',
    icon: ROOT && fs.existsSync(path.join(ROOT, 'app.ico')) ? path.join(ROOT, 'app.ico') : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  if (b.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => maybeShot());
  win.on('close', () => {
    const nb = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    writeState({ ...readState(), win: { ...nb, maximized: win.isMaximized() } });
  });
  // The hidden thumbnail windows would otherwise keep the app alive.
  win.on('closed', () => { win = null; app.quit(); });
  // Mouse back/forward buttons.
  win.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward') win.webContents.send('nav', 'back');
    if (cmd === 'browser-forward') win.webContents.send('nav', 'forward');
  });
}

// --shot=<png> renders the window off-screen, saves it and exits: a layout
// check that needs no display. --open=<path> picks the folder it shows.
function maybeShot() {
  const out = argOf('shot');
  if (!out) return;
  const delay = +argOf('shot-delay') || 2500;
  // --eval=<file.js> runs in the page first: a scripted walk through the UI.
  win.webContents.on('console-message', (e, level, message, line, source) => {
    if (level >= 2) console.log('[page]', message, source ? `(${path.basename(source)}:${line})` : '');
  });
  const script = argOf('eval');
  if (script) setTimeout(() => win.webContents.executeJavaScript(fs.readFileSync(script, 'utf8')).catch((e) => console.error('eval:', e.message)), 800);
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      const info = await win.webContents.executeJavaScript('window.__mxDebug ? window.__mxDebug() : null').catch(() => null);
      if (info) console.log(JSON.stringify(info));
    } catch (e) {
      console.error('shot failed:', e.message);
    }
    app.quit();
  }, delay);
}

// ---------------------------------------------------------------- ipc

ipcMain.handle('mx', async (e, name, payload) => {
  switch (name) {
    case 'boot': {
      const st = readState();
      return {
        platform: process.platform,
        sep: path.sep,
        home: os.homedir(),
        open: argOf('open') || startPathArg(ARGS),
        index: argOf('index'),
        player: !!findPlayer(),
        playerName: findPlayer() ? 'MediaInspector_Pro' : 'default app',
        prefs: st.prefs || null,
      };
    }
    case 'places': return { places: places(), drives: await drives() };
    case 'open': return openInPlayer(payload);
    case 'open-default': return shell.openPath(payload).then((err) => !err);
    case 'reveal': shell.showItemInFolder(payload); return true;
    case 'copy': clipboard.writeText(String(payload)); return true;
    case 'pick-folder': {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    }
    case 'menu': return popupMenu(e.sender, payload);
    case 'prewarm': return thumbs ? thumbs.prewarm(payload.items, payload.w, payload.replace !== false) : 0;
    case 'prewarm-dir': {
      // Everything in the folder just opened, not only what is on screen.
      const items = await callIndexer('mediaUnder', { path: payload.path, deep: false, limit: 20000 }).catch(() => []);
      return thumbs ? thumbs.prewarm(items, payload.w, true) : 0;
    }
    case 'prebuild': {
      // Thumbnails for a whole indexed location, in the background.
      const items = await callIndexer('mediaUnder', { path: payload.path });
      return thumbs ? thumbs.prewarm(items, payload.w, false) : 0;
    }
    case 'thumb-stats': return thumbs ? thumbs.stats() : null;
    case 'thumb-disk': return thumbs ? thumbs.diskUsage() : null;
    case 'thumb-clear': if (thumbs) await thumbs.clear(); return true;
    case 'save-prefs': writeState({ ...readState(), prefs: payload }); return true;
    case 'title': if (win) win.setTitle(payload ? payload + ' - MediaExplorer' : 'MediaExplorer'); return true;
    default: return null;
  }
});

ipcMain.on('want-port', (e) => {
  if (win && e.sender === win.webContents) { wantsPort = true; connectWindow(); }
});

ipcMain.on('drag', (e, files) => {
  if (!Array.isArray(files) || !files.length) return;
  e.sender.startDrag({ files, file: files[0], icon: path.join(__dirname, 'assets', 'drag.png') });
});

// The page describes the menu; the click comes back as the item's id.
function popupMenu(sender, items) {
  return new Promise((resolve) => {
    let picked = null;
    const build = (list) => list.map((it) => {
      if (it.type === 'separator') return { type: 'separator' };
      const m = { label: it.label, enabled: it.enabled !== false, accelerator: it.accel, registerAccelerator: false };
      if (it.type === 'checkbox') { m.type = 'checkbox'; m.checked = !!it.checked; }
      if (it.submenu) m.submenu = build(it.submenu);
      else m.click = () => { picked = it.id; };
      return m;
    });
    const menu = Menu.buildFromTemplate(build(items));
    menu.popup({ window: BrowserWindow.fromWebContents(sender), callback: () => setTimeout(() => resolve(picked), 0) });
  });
}

// A folder (or a file, whose folder is opened) given on the command line.
function startPathArg(args) {
  for (const a of args) {
    if (a.startsWith('-')) continue;
    try {
      const st = fs.statSync(a);
      return st.isDirectory() ? path.resolve(a) : path.dirname(path.resolve(a));
    } catch (e) { /* not a path */ }
  }
  return null;
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock() && !argOf('shot')) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    const p = startPathArg(argv.slice(1));
    if (win) {
      if (p) win.webContents.send('nav', { go: p });
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    startIndexer();
    startThumbs();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());

  // Give the indexer a moment to write the index; a crawl in progress is
  // resumed from what was saved.
  app.on('before-quit', (e) => {
    if (quitting || !indexer) return;
    quitting = true;
    e.preventDefault();
    for (const t of thumbWins) { try { t.win.destroy(); } catch (err) { /* gone */ } }
    const done = () => { flushed = null; app.exit(0); };
    flushed = done;
    setTimeout(done, 4000);
    indexer.postMessage({ type: 'flush' });
  });
}
