'use strict';
// MediaInspector2 - the shell around the player.
//
// Playback is unchanged from the WinForms version and deliberately so: mpv,
// driven by config/ and config/scripts/mediainspector.lua, drawing into a
// window this process hands it. What is new is everything around the picture -
// an HTML control panel that reflows instead of a fixed card grid, and a push
// connection to the player instead of a twice-a-second poll.

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

// Must be set before the app is ready, which is why it sits above the requires
// that do work of their own.
app.commandLine.appendSwitch('disable-gpu-compositing');

const MpvIpc = require('./mpv-ipc');
const native = require('./native');
const { Player, findMpv, PIPE_NAME } = require('./player');
const { State, lastFileFrom } = require('./state');

// Where the project lives: config/, Exports/ and the player's own state file,
// all shared with the WinForms shell. In development that is the parent of
// app/. Packaged, the exe sits in dist/MediaInspector2-win32-x64/, so the
// project is found by walking up from the exe instead - and a copy of config/
// ships inside the package as the last resort, which is what lets a folder
// that has been moved elsewhere still run.
function hasConfig(dir) {
  try {
    return !!dir && fs.existsSync(path.join(dir, 'config', 'scripts', 'mediainspector.lua'));
  } catch (e) {
    return false;
  }
}

function walkUpFor(start) {
  let dir = start;
  for (let i = 0; i < 6 && dir; i++) {
    if (hasConfig(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function resolveRoot() {
  if (hasConfig(process.env.MI_ROOT)) return process.env.MI_ROOT;
  return walkUpFor(path.dirname(app.getPath('exe')))
    || walkUpFor(__dirname)
    || (hasConfig(process.resourcesPath) ? process.resourcesPath : path.resolve(__dirname, '..'));
}

const ROOT = resolveRoot();
const CONFIG_DIR = path.join(ROOT, 'config');
const SHADER_DIR = path.join(CONFIG_DIR, 'shaders');
const EXPORT_DIR = path.join(ROOT, 'Exports');

const state = new State(path.join(ROOT, 'state_panel2.json'));
const ipc = new MpvIpc(PIPE_NAME);
const player = new Player(CONFIG_DIR);

let win = null;
let videoWin = null;
let videoHwnd = 0n;
let stageRect = null;     // last rect the renderer reported, in content coords
let gpuName = 'GPU';

// Properties the panel reflects. mpv pushes these as they change, so nothing
// here polls; time-pos alone would be sixty messages a second, hence the
// coalescing send below.
const WATCH = [
  'pause', 'time-pos', 'duration', 'speed', 'play-direction', 'mute', 'volume',
  'filename', 'path', 'width', 'height', 'dwidth', 'dheight', 'hwdec-current',
  'video-params/gamma', 'target-colorspace-hint', 'video-zoom', 'video-rotate',
  'estimated-frame-number', 'container-fps', 'video-format', 'audio-codec-name',
  'loop-file', 'ab-loop-a', 'deband',
  'video-params/rotate',
  'user-data/mi/tier', 'user-data/mi/kind', 'user-data/mi/crop',
  'user-data/mi/crop_editing', 'user-data/mi/crop_ratio',
  'user-data/mi/set_browse_all', 'user-data/mi/ui_scale',
];

// ---------------------------------------------------------------- windows

function createWindows() {
  nativeTheme.themeSource = 'dark';

  const saved = state.get('win') || {};
  win = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: saved.width || 1600,
    height: saved.height || 1000,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#12121a',
    title: 'MediaInspector2',
    icon: hasIcon() ? path.join(ROOT, 'app.ico') : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => {
    win.show();
    startPlayer();
    maybeShot();
  });

  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, () => positionVideo());
  }
  win.on('minimize', () => { if (videoWin) videoWin.hide(); });
  win.on('restore', () => { if (videoWin) { videoWin.show(); positionVideo(); } });
  win.on('close', () => {
    if (!win.isDestroyed()) {
      const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
      state.merge({ win: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() } });
      state.save();
    }
  });
  win.on('closed', () => { win = null; });

  // The picture is a native window of its own: mpv paints into it, and it sits
  // above the page, so the HTML lays out around it rather than under it.
  videoWin = new BrowserWindow({
    parent: win,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    backgroundColor: '#000000',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // Nothing is ever drawn in this window by us: it exists to give mpv an HWND
  // to paint into, and anything painted here would sit under the picture.
  videoWin.loadURL('data:text/html,<body style="margin:0;background:#000"></body>');
  videoHwnd = native.handleOf(videoWin);
}

function hasIcon() {
  try {
    return fs.existsSync(path.join(ROOT, 'app.ico'));
  } catch (e) {
    return false;
  }
}

// mpv reads render.conf for the one setting that cannot change on a running
// player. It is written here at startup as well as by the panel's Apply, so the
// file on disk always says what the panel says - they had drifted apart, with
// render.conf left reading "vulkan" from a session long past.
function ensureRenderConf() {
  const vulkan = state.get('renderApi') === 'Vulkan';
  const body = vulkan ? 'gpu-api=vulkan\r\ngpu-context=winvk\r\n'
                      : 'gpu-api=d3d11\r\ngpu-context=d3d11\r\n';
  try {
    const file = path.join(CONFIG_DIR, 'render.conf');
    if (fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body, 'utf8');
  } catch (e) {
    try { fs.writeFileSync(path.join(CONFIG_DIR, 'render.conf'), body, 'utf8'); } catch (e2) { /* read-only config */ }
  }
}

function positionVideo() {
  if (!win || !videoWin || win.isDestroyed() || videoWin.isDestroyed()) return;
  if (!stageRect || win.isMinimized()) return;
  const cb = win.getContentBounds();
  const w = Math.max(1, Math.round(stageRect.width));
  const h = Math.max(1, Math.round(stageRect.height));
  videoWin.setBounds({
    x: Math.round(cb.x + stageRect.x),
    y: Math.round(cb.y + stageRect.y),
    width: w,
    height: h,
  });
  if (!videoWin.isVisible()) videoWin.show();
  // mpv does not follow the window it was given; its child has to be told - in
  // physical pixels, which is not what setBounds above works in. On a 150%
  // display the two differ by half again, and passing DIP would have left the
  // picture filling two thirds of its window.
  const { screen } = require('electron');
  const sf = screen.getDisplayMatching(videoWin.getBounds()).scaleFactor || 1;
  native.resizeChild(videoHwnd, w * sf, h * sf);
}

// --shot=<file> renders the panel, saves a PNG of it and exits. The picture is
// a native window of its own and does not appear in it: this checks the panel's
// own layout, the way --dump-layout did for the WinForms card grid.
function maybeShot() {
  const arg = process.argv.find((a) => a.startsWith('--shot='));
  if (!arg) return;
  const out = arg.slice('--shot='.length);
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      // Geometry, so the embedding can be checked without a screen grab: the
      // picture is a native window and never appears in a page capture.
      const osd = await ipc.get('osd-dimensions').catch(() => null);
      console.log('stage rect   :', JSON.stringify(stageRect));
      console.log('video window :', JSON.stringify(videoWin.getBounds()));
      console.log('mpv osd      :', JSON.stringify(osd));
      console.log('mpv child    :', native.mpvChild(videoHwnd).toString());
      // Enough to tell whether the picture is embedded, decoded on the GPU and
      // laid out at the shape it is actually being displayed at.
      const shape = displayShape();
      console.log('file         :', await ipc.get('filename').catch(() => '(none loaded)'));
      console.log('display shape:', shape[0] + 'x' + shape[1],
        '| decoder:', await ipc.get('hwdec-current').catch(() => '?'),
        '| vo:', await ipc.get('current-vo').catch(() => '?'));
    } catch (e) {
      console.error('shot failed:', e.message);
    }
    await player.quit(ipc);
    app.exit(0);
  }, 6000);
}

// ---------------------------------------------------------------- player

function startFile() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const a of args) {
    if (a.startsWith('-')) continue;
    try {
      if (fs.existsSync(a) && fs.statSync(a).isFile()) return path.resolve(a);
    } catch (e) { /* not a path */ }
  }
  return lastFileFrom(path.join(ROOT, 'state_player.json'));
}

function startPlayer() {
  ensureRenderConf();
  if (!videoHwnd) videoHwnd = native.handleOf(videoWin);
  if (!player.start(videoHwnd, startFile())) {
    dialog.showMessageBox(win, {
      type: 'error',
      title: 'MediaInspector2',
      message: 'mpv.exe not found.',
      detail: 'Install it with:\n\nwinget install --id shinchiro.mpv -e',
    }).then(() => app.quit());
    return;
  }
  ipc.connectWithRetry();
}

ipc.on('connect', () => {
  ipc.stopRetry();
  ipc.observe(WATCH);
  pushAllSettings();
  send('connection', { connected: true, alive: true });
  // The picture is live now, so give it the keyboard: the player's own
  // bindings are the ones a viewer reaches for first, and clicking a control
  // takes focus back.
  // mpv's child window appears a moment after the process does, so the first
  // sizing attempts can land before there is anything to size.
  for (const delay of [200, 500, 900, 1500]) {
    setTimeout(() => { native.forgetChild(); positionVideo(); }, delay);
  }
  setTimeout(() => native.focusVideo(videoHwnd), 700);
});

ipc.on('disconnect', () => {
  send('connection', { connected: false, alive: player.alive });
  if (player.alive) ipc.connectWithRetry();
});

// mpv pushes changes as they happen; the renderer gets one coalesced snapshot
// rather than a message per property. time-pos alone fires once a frame, which
// is why this is throttled rather than forwarded straight through.
let sendTimer = null;
ipc.on('property', (name) => {
  if (name === 'dwidth' || name === 'dheight' || name === 'video-params/rotate') fitWindowToMedia();
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    send('status', ipc.props);
  }, 60);
});

// Size the WINDOW so the picture area lands at the media's own size. The panel
// keeps whatever width it has; the renderer decides that from the same shape,
// and the two agree because both work from the displayed size.
// The picture's shape as displayed: mpv reports every size unrotated, so a
// phone's portrait clip comes back as 3840x2160 with a rotate-90 flag.
function displayShape() {
  const w = ipc.props['dwidth'] || ipc.props['width'] || 0;
  const h = ipc.props['dheight'] || ipc.props['height'] || 0;
  const turn = ((((ipc.props['video-params/rotate'] || 0) + (ipc.props['video-rotate'] || 0)) % 180) + 180) % 180;
  return turn === 90 ? [h, w] : [w, h];
}

let fittedFor = '';
function fitWindowToMedia() {
  if (!win || win.isDestroyed() || !stageRect) return;
  if (!state.get('fitWindow')) return;
  if (win.isMaximized() || win.isFullScreen() || win.isMinimized()) return;

  const [w, h] = displayShape();
  if (!w || !h || w < 1 || h < 1) return;
  const key = w + 'x' + h + '@' + (ipc.props['path'] || '');
  if (key === fittedFor) return;
  fittedFor = key;

  const { screen } = require('electron');
  const area = screen.getDisplayMatching(win.getBounds()).workAreaSize;
  const [cw, chh] = win.getContentSize();
  const chromeW = cw - stageRect.width;
  const chromeH = chh - stageRect.height;

  const maxW = area.width * 0.96 - chromeW;
  const maxH = area.height * 0.94 - chromeH;
  if (maxW < 200 || maxH < 200) return;

  const scale = Math.min(1, maxW / w, maxH / h);
  win.setContentSize(
    Math.max(900, Math.round(w * scale + chromeW)),
    Math.max(560, Math.round(h * scale + chromeH))
  );
  positionVideo();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function log(text) {
  send('log', text);
  if (ipc.connected) ipc.send(['show-text', text, 2600]);
}

// ---------------------------------------------------------------- settings

function pushAllSettings() {
  const s = state.data;
  ipc.setting('export_dir', s.exportDir || EXPORT_DIR);
  ipc.setting('export_format', s.exportFormat);
  ipc.setting('export_scale', s.exportScale);
  ipc.setting('export_scaler', s.exportScaler);
  ipc.setting('fit_window', 'no');       // the shell owns window sizing
  ipc.userData('embedded', 'yes');
  ipc.set('scale', s.scaler);
  ipc.set('cscale', s.scaler);
  ipc.set('dscale', s.dscaler);
  pushUpscale();
  applyLook(s.look || {});
}

function pushUpscale() {
  const s = state.data;
  ipc.setting('upscale', s.upscaleMode === 'Off' ? 'off' : 'rtx');
  ipc.setting('upscale_factor', s.upscaleFactor);
  ipc.setting('rtx_hdr', s.rtxHdr ? 'yes' : 'no');
  ipc.setting('shaders', (s.shaders || []).join(','));
  ipc.binding('apply_upscale');
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const fmt = (v) => String(Math.round(v * 1000) / 1000);

// The colour controls are one lavfi graph plus mpv's own four. Ported from the
// WinForms panel, including the reason the whole graph is wrapped in lavfi[]:
// passing the filters bare lets mpv's vf parser eat the ':' separators, and one
// rejected stage silently kills every adjustment.
function applyLook(look) {
  if (!ipc.connected) return;
  const a = (k) => num(look[k]);
  ipc.set('brightness', a('brightness'));
  ipc.set('contrast', a('contrast'));
  ipc.set('saturation', a('saturation'));
  ipc.set('gamma', a('gamma'));
  ipc.set('hue', a('hue'));

  const f = [];
  if (a('temp')) f.push('colortemperature=temperature=' + (6500 - a('temp') * 30));
  if (a('tint')) f.push('colorbalance=gm=' + fmt(a('tint') / 200));
  if (a('vibrance')) f.push('vibrance=intensity=' + fmt(a('vibrance') / 100));
  if (a('shadows') || a('highlights')) {
    const sh = Math.max(0.02, Math.min(0.25 + a('shadows') / 500, 0.48));
    const hi = Math.max(0.52, Math.min(0.75 + a('highlights') / 500, 0.98));
    f.push("curves=all='0/0 0.25/" + fmt(sh) + " 0.75/" + fmt(hi) + " 1/1'");
  }
  if (a('sharpness') > 0) f.push('unsharp=5:5:' + fmt(a('sharpness') / 50) + ':5:5:0');
  else if (a('sharpness') < 0) f.push('gblur=sigma=' + fmt(Math.abs(a('sharpness')) / 50));
  if (a('vignette') > 0) f.push('vignette=angle=' + fmt((Math.PI / 5) * (a('vignette') / 100)));

  ipc.send(['vf', 'remove', '@milook']);
  if (f.length) {
    ipc.command(['vf', 'add', '@milook:lavfi=[' + f.join(',') + ']'])
      .catch(() => log('Filter rejected: ' + f.join(',')));
  }
}

// ---------------------------------------------------------------- helpers

function shaderList() {
  try {
    return fs.readdirSync(SHADER_DIR)
      .filter((f) => f.toLowerCase().endsWith('.glsl'))
      .map((f) => ({ name: f, path: path.join(SHADER_DIR, f) }));
  } catch (e) {
    return [];
  }
}

function readGpuName() {
  execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)'],
    { windowsHide: true, timeout: 8000 },
    (err, stdout) => {
      if (!err && stdout && stdout.trim()) {
        gpuName = stdout.trim();
        send('gpu', gpuName);
      }
    });
}

function exportTrim(opts) {
  const src = ipc.props['path'];
  if (!src) { log('Nothing loaded to trim'); return; }
  const mpv = findMpv();
  if (!mpv) { log('mpv.exe not found'); return; }

  const outDir = state.get('exportDir') || EXPORT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const outFile = path.join(outDir, path.parse(src).name + '_trim_' + stamp + '.mp4');

  const args = ['--start=' + (opts.trimIn || '0')];
  if (opts.trimOut) args.push('--end=' + opts.trimOut);

  const vf = [];
  const crop = ipc.props['user-data/mi/crop'];
  if (crop && crop.split(':').length === 4) vf.push('crop=' + crop);
  const sc = parseInt(state.get('exportScale'), 10);
  if (sc && sc !== 100 && sc > 0) {
    const f = fmt(sc / 100);
    vf.push('scale=w=iw*' + f + ':h=ih*' + f + ':flags=' + state.get('exportScaler') + '+accurate_rnd');
  }
  if (vf.length) args.push('--vf=' + vf.join(','));
  args.push('--ovc=libx264', '--oac=aac', '--no-config', '-o=' + outFile, src);

  spawn(mpv, args, { windowsHide: true, stdio: 'ignore', detached: false });
  log('Encoding clip -> ' + path.basename(outFile));
}

// gpu-api cannot change on a running player, so the player is restarted in
// place: the window and every control stay exactly where they are.
async function applyRenderApi(api) {
  const vulkan = api === 'Vulkan';
  const conf = vulkan ? 'gpu-api=vulkan\r\ngpu-context=winvk\r\n' : 'gpu-api=d3d11\r\ngpu-context=d3d11\r\n';
  try {
    fs.writeFileSync(path.join(CONFIG_DIR, 'render.conf'), conf, 'utf8');
  } catch (e) {
    log('Could not write render.conf: ' + e.message);
    return;
  }
  const current = ipc.props['path'] || null;
  log('Renderer -> ' + api + ', restarting player');
  await player.quit(ipc);
  ipc.disconnect();
  native.forgetChild();
  setTimeout(() => {
    player.start(videoHwnd, current);
    ipc.connectWithRetry();
  }, 600);
}

const MEDIA_FILTERS = [
  { name: 'All media', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', 'mts', 'ts', 'gif', 'jpg', 'jpeg', 'png', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'avif', 'jxl', 'exr', 'hdr', 'dng', 'cr2', 'nef', 'arw', 'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff', 'ape', 'mka'] },
  { name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', 'mts', 'ts', 'gif'] },
  { name: 'Photos', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'avif', 'jxl', 'exr', 'hdr', 'dng', 'cr2', 'nef', 'arw'] },
  { name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff', 'ape', 'mka'] },
  { name: 'All files', extensions: ['*'] },
];

// ---------------------------------------------------------------- bridge

ipcMain.on('video-rect', (e, r) => {
  stageRect = r;
  positionVideo();
});

ipcMain.on('mpv', (e, msg) => {
  if (!ipc.connected) return;
  switch (msg.kind) {
    case 'command': ipc.send(msg.args); break;
    case 'set': ipc.set(msg.prop, msg.value); break;
    case 'setting': ipc.setting(msg.name, msg.value); break;
    case 'binding': ipc.binding(msg.name); break;
    case 'script-message': ipc.scriptMessage(...msg.args); break;
    case 'keypress': ipc.send(['keypress', msg.key]); break;
  }
});

ipcMain.on('focus-video', () => native.focusVideo(videoHwnd));

ipcMain.handle('invoke', async (e, name, payload) => {
  switch (name) {
    case 'init':
      readGpuName();
      return {
        state: state.data,
        shaders: shaderList(),
        gpu: gpuName,
        root: ROOT,
        exportDir: state.get('exportDir') || EXPORT_DIR,
      };

    case 'state':
      state.merge(payload || {});
      return true;

    case 'push-settings':
      pushAllSettings();
      return true;

    case 'push-upscale':
      pushUpscale();
      return true;

    case 'look':
      state.set('look', payload || {});
      applyLook(payload || {});
      return true;

    case 'open-media': {
      const r = await dialog.showOpenDialog(win, {
        title: 'Open media',
        properties: ['openFile'],
        filters: MEDIA_FILTERS,
      });
      if (!r.canceled && r.filePaths[0]) ipc.send(['loadfile', r.filePaths[0], 'replace']);
      return true;
    }

    case 'pick-folder': {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
      return (!r.canceled && r.filePaths[0]) ? r.filePaths[0] : null;
    }

    case 'open-folder': {
      const dir = payload || state.get('exportDir') || EXPORT_DIR;
      fs.mkdirSync(dir, { recursive: true });
      shell.openPath(dir);
      return true;
    }

    case 'open-shaders':
      fs.mkdirSync(SHADER_DIR, { recursive: true });
      shell.openPath(SHADER_DIR);
      return true;

    case 'shaders':
      return shaderList();

    case 'trim':
      exportTrim(payload || {});
      return true;

    case 'render-api':
      state.set('renderApi', payload);
      await applyRenderApi(payload);
      return true;

    case 'fullscreen':
      win.setFullScreen(!win.isFullScreen());
      positionVideo();
      return win.isFullScreen();

    case 'always-on-top': {
      const on = !win.isAlwaysOnTop();
      win.setAlwaysOnTop(on);
      return on;
    }

    case 'load-file':
      if (payload) ipc.send(['loadfile', payload, 'replace']);
      return true;

    case 'log':
      log(String(payload));
      return true;

    case 'quit':
      app.quit();
      return true;

    default:
      return null;
  }
});

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // "Open with" from Explorer reuses this window instead of starting a second
  // player that would fight over the same IPC pipe.
  app.on('second-instance', (e, argv) => {
    const file = argv.slice(1).find((a) => !a.startsWith('-') && fs.existsSync(a));
    if (file && ipc.connected) ipc.send(['loadfile', file, 'replace']);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(createWindows);

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', async (e) => {
    ipc.stopRetry();
    if (player.alive) {
      e.preventDefault();
      state.save();
      await player.quit(ipc);
      app.exit(0);
    }
  });
}
