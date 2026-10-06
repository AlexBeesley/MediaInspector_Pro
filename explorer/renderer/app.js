'use strict';
// The window. Everything it shows comes from the indexer over a MessagePort,
// and every list is a typed array of ids: rows (name, size, path...) are
// fetched only for what is on screen, plus a little ahead, and cached by id.

const $ = (id) => document.getElementById(id);

const DEFAULT_PREFS = {
  mode: 'grid',
  thumb: 180,
  show: 'media',
  sort: 'name',
  desc: false,
  ssort: 'relevance',
  sdesc: false,
  hidden: false,
  preview: true,
  scope: 'all',
  autoIndex: true,     // opening a folder indexes it
  sideW: 220,
  prevW: 340,
  last: null,
};

const S = {
  boot: null,
  prefs: { ...DEFAULT_PREFS },
  path: null,
  dirId: -1,
  listing: null,
  searching: false,
  lastSearch: null,
  hist: [],
  fwd: [],
  roots: [],
  progress: null,
  error: null,
};

const rows = new Map();   // id -> row
let rowVer = 0;

// ---------------------------------------------------------------- indexer link

let port = null;
let portGen = 0;
const calls = new Map();
let callSeq = 0;
const waitingForPort = [];

window.addEventListener('message', (e) => {
  if (e.data !== 'mx-index-port' || !e.ports || !e.ports[0]) return;
  const first = !port;
  port = e.ports[0];
  portGen++;
  port.onmessage = (ev) => onIndexMessage(ev.data);
  for (const fn of waitingForPort.splice(0)) fn();
  // A second port means the indexer restarted: every id we hold is void.
  if (!first) {
    rows.clear();
    for (const [, c] of calls) c.reject(new Error('indexer restarted'));
    calls.clear();
    if (S.path) go(S.path, { push: false, keep: true });
  }
});

function ix(op, args) {
  if (!port) return new Promise((resolve) => waitingForPort.push(resolve)).then(() => ix(op, args));
  const rid = ++callSeq;
  return new Promise((resolve, reject) => {
    calls.set(rid, { resolve, reject });
    port.postMessage({ rid, op, args });
  });
}

function onIndexMessage(m) {
  if (m.event) { onIndexEvent(m.event, m.data); return; }
  const c = calls.get(m.rid);
  if (!c) return;
  calls.delete(m.rid);
  if (m.error) c.reject(new Error(m.error)); else c.resolve(m.result);
}

function keepRows(list) {
  if (!list) return;
  for (const r of list) { r.v = ++rowVer; rows.set(r.id, r); }
}

// Rows for ids the view has come to: batched per frame, never asked twice.
const asked = new Set();
let needBuf = [];
let needTimer = 0;
function needRows(ids) {
  for (const id of ids) if (!asked.has(id)) { asked.add(id); needBuf.push(id); }
  if (needTimer || !needBuf.length) return;
  needTimer = requestAnimationFrame(() => {
    needTimer = 0;
    const batch = needBuf;
    needBuf = [];
    const gen = portGen;
    ix('rows', { ids: batch }).then((list) => {
      if (gen !== portGen) return;
      keepRows(list);
      for (const id of batch) asked.delete(id);
      view.schedule();
    }).catch(() => { for (const id of batch) asked.delete(id); });
  });
}

function onIndexEvent(ev, data) {
  if (ev === 'changed') {
    if (S.searching) { rerunSearchSoon(); return; }
    if (S.dirId >= 0 && (data.all || data.dirs.includes(S.dirId))) relist();
    // A folder's item count shows on its tile; refresh those quietly.
    else if (data.dirs) { let hit = false; for (const d of data.dirs) if (rows.has(d)) { rows.delete(d); hit = true; } if (hit) view.refresh(); }
  } else if (ev === 'progress') {
    S.progress = data;
    renderIndexStatus();
  } else if (ev === 'roots') {
    S.roots = data;
    renderRoots();
    renderIndexStatus();
    renderIndexButton();
  }
}

// ---------------------------------------------------------------- paths

function sep() { return S.boot ? S.boot.sep : '/'; }
const isWin = () => S.boot && S.boot.platform === 'win32';

function splitCrumbs(p) {
  if (!p) return [];
  if (isWin()) {
    const out = [];
    let root;
    let rest;
    if (p.startsWith('\\\\')) {
      const parts = p.slice(2).split('\\').filter(Boolean);
      root = '\\\\' + parts.slice(0, 2).join('\\') + '\\';
      rest = parts.slice(2);
    } else {
      root = p.slice(0, 3);
      rest = p.slice(3).split('\\').filter(Boolean);
    }
    out.push({ name: root.replace(/\\$/, ''), path: root });
    let acc = root;
    for (const r of rest) { acc = acc.endsWith('\\') ? acc + r : acc + '\\' + r; out.push({ name: r, path: acc }); }
    return out;
  }
  const out = [{ name: '/', path: '/' }];
  let acc = '';
  for (const r of p.split('/').filter(Boolean)) { acc += '/' + r; out.push({ name: r, path: acc }); }
  return out;
}

function parentOf(p) {
  const c = splitCrumbs(p);
  return c.length > 1 ? c[c.length - 2].path : null;
}

function baseName(p) {
  const c = splitCrumbs(p);
  return c.length ? c[c.length - 1].name : p;
}

function fileURL(p) {
  let s = p.replace(/\\/g, '/');
  const enc = s.split('/').map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
  if (s.startsWith('//')) return 'file:' + enc;
  return isWin() ? 'file:///' + enc : 'file://' + enc;
}

function sameOrUnder(p, root) {
  const a = isWin() ? p.toLowerCase() : p;
  const b = isWin() ? root.toLowerCase() : root;
  return a === b || a.startsWith(b.endsWith(sep()) ? b : b + sep());
}

// ---------------------------------------------------------------- thumbnails

function bucket(px) {
  const d = px * (window.devicePixelRatio || 1);
  return d <= 140 ? 128 : d <= 270 ? 256 : d <= 400 ? 384 : 512;
}

function thumbURL(row, px) {
  let t = row;
  if (row.dir) { if (!row.cover) return null; t = row.cover; } else if (!row.kind) return null;
  return `thumb://t/?w=${bucket(px)}&k=${t.kind}&s=${t.size}&m=${Math.round(t.mtime)}${row.cloud ? '&c=1' : ''}&p=${encodeURIComponent(t.path)}`;
}

// ---------------------------------------------------------------- view

const view = new VirtualView($('scroller'), $('spacer'), $('listhead'), {
  row: (id) => rows.get(id),
  need: needRows,
  thumb: (row) => thumbURL(row, view.cellW || S.prefs.thumb),
  activate: (id) => activate(id),
  context: (id, e) => contextMenu(id, e),
  drag: (ids) => {
    const paths = ids.map((id) => rows.get(id)).filter(Boolean).map((r) => r.path);
    if (paths.length) mx.drag(paths);
  },
  focusChanged: (id) => { previewSoon(id); renderLeftStatus(); },
});

function listOpts() {
  const p = S.prefs;
  return { show: p.show, sort: p.sort, desc: p.desc, hidden: p.hidden, autoIndex: p.autoIndex };
}

let navSeq = 0;

async function go(path, opts = {}) {
  if (!path) return;
  const seq = ++navSeq;
  const prevPath = S.path;
  const prevScroll = $('scroller').scrollTop;
  const prevFocus = view.focus >= 0 ? view.ids[view.focus] : -1;
  setBusy(true);
  let r;
  try {
    r = await ix('list', { path, ...listOpts(), cached: !!opts.cached });
  } catch (e) {
    r = { error: e.message, path };
  }
  if (seq !== navSeq) return;
  setBusy(false);

  if (opts.push !== false && prevPath && (r.path || path) !== prevPath) {
    S.hist.push({ path: prevPath, scroll: prevScroll, focus: prevFocus });
    if (S.hist.length > 200) S.hist.shift();
    S.fwd = [];
  }
  if (S.searching && !opts.keepSearch) exitSearch(false);

  if (r.error) {
    S.error = r.error;
    S.path = r.path || path;
    S.dirId = -1;
    S.listing = null;
    view.setItems(new Int32Array(0));
  } else {
    S.error = null;
    S.path = r.path;
    S.dirId = r.dir;
    S.listing = r;
    keepRows(r.rows);
    let focusId = opts.focusId;
    if (focusId === undefined && opts.focusName) {
      const hit = r.rows.find((x) => x.name === opts.focusName);
      focusId = hit ? hit.id : -1;
    }
    view.setItems(r.ids, { keep: !!opts.keep, scrollTop: opts.scrollTop, focusId, reveal: true });
    prewarm();
  }
  S.prefs.last = S.path;
  savePrefs();
  renderCrumbs();
  renderEmpty();
  renderLeftStatus();
  renderSideActive();
  renderIndexButton();
  mx.invoke('title', baseName(S.path));
  previewSoon(view.focus >= 0 ? view.ids[view.focus] : -1);
}

// The folder changed on disk, or a filter did: same place, same scroll.
let relistTimer = 0;
function relist() {
  if (relistTimer) return;
  relistTimer = setTimeout(() => {
    relistTimer = 0;
    if (!S.path || S.searching) return;
    rows.clear();
    go(S.path, { push: false, keep: true, cached: true, scrollTop: $('scroller').scrollTop });
  }, 120);
}

function back() {
  const h = S.hist.pop();
  if (!h) return;
  S.fwd.push({ path: S.path, scroll: $('scroller').scrollTop, focus: view.focus >= 0 ? view.ids[view.focus] : -1 });
  go(h.path, { push: false, scrollTop: h.scroll, focusId: h.focus });
}

function forward() {
  const h = S.fwd.pop();
  if (!h) return;
  S.hist.push({ path: S.path, scroll: $('scroller').scrollTop, focus: view.focus >= 0 ? view.ids[view.focus] : -1 });
  go(h.path, { push: false, scrollTop: h.scroll, focusId: h.focus });
}

function up() {
  if (S.searching) { exitSearch(true); return; }
  const p = parentOf(S.path);
  if (p) go(p, { focusName: baseName(S.path) });
}

function prewarm() {
  if (!S.path || S.searching) return;
  mx.invoke('prewarm-dir', { path: S.path, w: bucket(view.cellW || S.prefs.thumb) });
}

function activate(id) {
  const r = rows.get(id);
  if (!r) return;
  if (r.dir) { go(r.path); return; }
  // Videos go to the inspector; photos and audio to whatever the OS opens
  // them with (Photos, on Windows).
  if (r.kind === 1) mx.invoke('open', r.path); else mx.invoke('open-default', r.path);
}

// ---------------------------------------------------------------- search

let searchSeq = 0;
let searchTimer = 0;

function searchOpts() {
  const p = S.prefs;
  return { show: p.show, sort: p.ssort, desc: p.sdesc, hidden: p.hidden, scope: p.scope === 'here' && S.path ? S.path : null };
}

function runSearch() {
  clearTimeout(searchTimer);
  const q = $('search').value.trim();
  if (!q) { if (S.searching) exitSearch(true); return; }
  const seq = ++searchSeq;
  ix('search', { q, ...searchOpts() }).then((r) => {
    if (seq !== searchSeq) return;
    S.searching = true;
    S.lastSearch = { q, ms: r.ms, n: r.ids.length, searched: r.searched };
    document.body.classList.add('searching');
    view.search = true;
    keepRows(r.rows);
    view.setItems(r.ids);
    renderSortUI();
    renderEmpty();
    renderLeftStatus();
    previewSoon(-1);
  }).catch(() => {});
}

function rerunSearchSoon() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = $('search').value.trim();
    if (!q) return;
    const seq = ++searchSeq;
    const scroll = $('scroller').scrollTop;
    ix('search', { q, ...searchOpts() }).then((r) => {
      if (seq !== searchSeq || !S.searching) return;
      S.lastSearch = { q, ms: r.ms, n: r.ids.length, searched: r.searched };
      keepRows(r.rows);
      view.setItems(r.ids, { keep: true, scrollTop: scroll });
      renderEmpty();
      renderLeftStatus();
    }).catch(() => {});
  }, 700);
}

function exitSearch(restore) {
  const was = S.searching;
  S.searching = false;
  searchSeq++;
  $('search').value = '';
  document.body.classList.remove('searching');
  view.search = false;
  renderSortUI();
  if (was && restore && S.path) go(S.path, { push: false, cached: true });
}

// ---------------------------------------------------------------- rendering

function setBusy(on) {
  document.body.classList.toggle('busy', on);
}

function renderCrumbs() {
  const el = $('crumbs');
  el.textContent = '';
  const parts = splitCrumbs(S.path);
  parts.forEach((c, i) => {
    if (i > 0) {
      const s = document.createElement('span');
      s.className = 'csep';
      s.textContent = '›';
      el.appendChild(s);
    }
    const b = document.createElement('button');
    b.className = 'crumb' + (i === parts.length - 1 ? ' last' : '');
    b.textContent = c.name;
    b.onclick = (e) => { e.stopPropagation(); go(c.path); };
    el.appendChild(b);
  });
  // Keep the deepest part in view when the path is long.
  el.scrollLeft = el.scrollWidth;
  $('back').disabled = !S.hist.length;
  $('fwd').disabled = !S.fwd.length;
  $('up').disabled = !parentOf(S.path);
}

function renderEmpty() {
  const el = $('empty');
  let html = '';
  if (S.searching && view.n === 0) {
    const indexed = S.roots.length;
    html = `<div class="big">No matches</div><div>for <b>${esc(S.lastSearch ? S.lastSearch.q : '')}</b> among ${esc(showLabel())}.</div>`;
    if (!indexed) html += `<div class="dim">Only folders you have opened are searchable until you index a location.</div><div><button class="btn key" data-act="index-here">Index this folder</button></div>`;
  } else if (!S.searching && S.error) {
    const msg = { missing: 'This folder is not there.', denied: 'Access denied.', 'bad-path': 'That is not a path.' }[S.error] || S.error;
    html = `<div class="big">${esc(msg)}</div><div class="dim">${esc(S.path || '')}</div>`;
  } else if (!S.searching && S.listing && view.n === 0) {
    html = `<div class="big">No ${esc(showLabel())} here</div>`;
  }
  el.innerHTML = html;
  el.hidden = !html;
}

function showLabel() {
  return { media: 'media', video: 'videos', photo: 'photos', audio: 'audio' }[S.prefs.show] || 'media';
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderLeftStatus() {
  const el = $('stLeft');
  let t = '';
  if (S.searching && S.lastSearch) {
    const s = S.lastSearch;
    t = `${s.n.toLocaleString()} result${s.n === 1 ? '' : 's'} · ${s.ms < 10 ? s.ms.toFixed(1) : Math.round(s.ms)} ms over ${s.searched.toLocaleString()} names`;
  } else if (S.listing) {
    t = `${view.n.toLocaleString()} item${view.n === 1 ? '' : 's'}`;
    if (S.listing.offline) t += ' · offline (from index)';
  }
  const sel = view.sel.size;
  if (sel > 1) {
    let bytes = 0;
    let known = true;
    for (const id of view.sel) { const r = rows.get(id); if (r && !r.dir && r.size > 0) bytes += r.size; else if (!r) known = false; }
    t += ` · ${sel.toLocaleString()} selected${bytes ? ' (' + (known ? '' : '≥ ') + fmtSize(bytes) + ')' : ''}`;
  }
  el.textContent = t;
}

function renderIndexStatus() {
  const el = $('stIndex');
  const p = S.progress;
  if (p && p.scanning && p.scanning.length) {
    const s = p.scanning[0];
    el.innerHTML = `<span class="spin"></span>Indexing ${esc(baseName(s.path))} · ${s.done.toLocaleString()} folders · ${s.rate.toLocaleString()}/s`;
    el.title = p.scanning.map((x) => x.path).join('\n');
  } else {
    const total = p ? p.entries : S.roots.reduce((a, r) => a + (r.files || 0) + (r.dirs || 0), 0);
    el.textContent = total ? `Index: ${total.toLocaleString()} items` : '';
    el.title = '';
  }
}

function renderIndexButton() {
  const b = $('indexHere');
  if (!S.path || S.searching) { b.hidden = true; return; }
  const root = S.roots.find((r) => sameOrUnder(S.path, r.path));
  b.hidden = false;
  if (root) {
    b.innerHTML = icon('index') + (root.status === 'scanning' ? 'Indexing…' : 'Indexed');
    b.classList.add('on');
    b.title = `Inside ${root.path}, which is indexed and watched`;
  } else {
    b.innerHTML = icon('index') + 'Index this folder';
    b.classList.remove('on');
    b.title = 'Crawl this folder and everything under it, keep it up to date, and make it searchable';
  }
}

// ---------------------------------------------------------------- sidebar

let placesData = { places: [], drives: [] };

async function loadPlaces() {
  placesData = await mx.invoke('places');
  renderPlaces();
}

function sideItem(name, path, iconName, extra) {
  const d = document.createElement('div');
  d.className = 'si';
  d.dataset.path = path;
  d.innerHTML = icon(iconName) + `<span class="sn">${esc(name)}</span>` + (extra || '');
  d.title = path;
  d.onclick = () => go(path);
  return d;
}

function renderPlaces() {
  const pl = $('places');
  pl.textContent = '';
  for (const p of placesData.places) pl.appendChild(sideItem(p.name, p.path, p.icon in ICON_PATHS ? p.icon : 'folder'));
  const dr = $('drives');
  dr.textContent = '';
  for (const d of placesData.drives) {
    const used = d.total ? 1 - d.free / d.total : 0;
    const el = sideItem(d.name, d.path, 'drive', `<span class="sx">${fmtSize(d.free)} free</span><span class="bar"><i style="width:${(used * 100).toFixed(1)}%"></i></span>`);
    el.classList.add('drive');
    el.oncontextmenu = async (e) => {
      e.preventDefault();
      const pick = await mx.invoke('menu', [
        { id: 'open', label: 'Open' },
        { id: 'index', label: 'Index this drive', enabled: !S.roots.some((r) => sameOrUnder(d.path, r.path)) },
      ]);
      if (pick === 'open') go(d.path);
      if (pick === 'index') addRoot(d.path);
    };
    dr.appendChild(el);
  }
  renderSideActive();
}

function renderRoots() {
  const el = $('roots');
  el.textContent = '';
  if (!S.roots.length) {
    const d = document.createElement('div');
    d.className = 'hintline';
    d.textContent = S.prefs.autoIndex ? 'Folders you open are indexed and searchable.' : 'Index a folder or drive to search all of it instantly.';
    el.appendChild(d);
  }
  for (const r of S.roots) {
    const status = r.status === 'scanning' ? '<span class="spin"></span>' : r.status === 'offline' ? icon('offline', 'off') : '';
    const count = r.media ? `${r.media.toLocaleString()}` : r.files ? `${r.files.toLocaleString()}` : '';
    const item = sideItem(baseName(r.path) || r.path, r.path, 'index', `${status}<span class="sx">${count}</span>`);
    item.title = `${r.path}\n${(r.files || 0).toLocaleString()} files, ${(r.media || 0).toLocaleString()} media, ${(r.dirs || 0).toLocaleString()} folders` +
      (r.lastScan ? `\nLast full scan ${new Date(r.lastScan).toLocaleString()} (${(r.ms / 1000).toFixed(1)} s)` : '') +
      (r.status === 'offline' ? '\nOffline - browsing and search use the saved index' : '');
    item.oncontextmenu = async (e) => {
      e.preventDefault();
      const pick = await mx.invoke('menu', [
        { id: 'open', label: 'Open' },
        { id: 'rescan', label: 'Rescan now' },
        { id: 'prebuild', label: 'Build all thumbnails now' },
        { type: 'separator' },
        { id: 'reveal', label: 'Show in system file manager' },
        { id: 'remove', label: 'Remove from index' },
      ]);
      if (pick === 'open') go(r.path);
      if (pick === 'rescan') ix('rescan', { path: r.path });
      if (pick === 'prebuild') prebuild(r.path);
      if (pick === 'reveal') mx.invoke('open-default', r.path);
      if (pick === 'remove') ix('removeRoot', { path: r.path }).then((x) => { S.roots = x; renderRoots(); renderIndexButton(); });
    };
    el.appendChild(item);
  }
  renderSideActive();
}

function renderSideActive() {
  let best = null;
  for (const el of document.querySelectorAll('#side .si')) {
    el.classList.remove('on');
    if (S.path && sameOrUnder(S.path, el.dataset.path) && (!best || el.dataset.path.length > best.dataset.path.length)) best = el;
  }
  if (best) best.classList.add('on');
}

async function addRoot(p) {
  if (!p) return;
  const r = await ix('addRoot', { path: p });
  if (r && r.error === 'inside') { toast(`Already indexed as part of ${r.root}`); return; }
  if (Array.isArray(r)) { S.roots = r; renderRoots(); renderIndexButton(); toast(`Indexing ${baseName(p) || p}`); }
}

async function prebuild(p) {
  const n = await mx.invoke('prebuild', { path: p, w: bucket(view.cellW || S.prefs.thumb) });
  toast(n ? `Building ${n.toLocaleString()} thumbnails in the background` : 'Thumbnails are already built');
}

// ---------------------------------------------------------------- context menu

async function contextMenu(id, e) {
  const r = id >= 0 ? rows.get(id) : null;
  const sel = view.selectedIds().map((x) => rows.get(x)).filter(Boolean);
  const player = S.boot.playerName;
  let items;
  if (!r) {
    items = [
      { id: 'reload', label: 'Refresh', accel: 'F5' },
      { id: 'index-here', label: 'Index this folder', enabled: !!S.path && !S.roots.some((x) => sameOrUnder(S.path, x.path)) },
      { type: 'separator' },
      { id: 'hidden', label: 'Show hidden files', type: 'checkbox', checked: S.prefs.hidden },
      { id: 'auto-index', label: 'Index folders when opened', type: 'checkbox', checked: S.prefs.autoIndex },
      { id: 'reveal-here', label: 'Open in system file manager', enabled: !!S.path },
      { id: 'copy-here', label: 'Copy folder path', enabled: !!S.path },
    ];
  } else if (r.dir) {
    items = [
      { id: 'open', label: 'Open' },
      { id: 'index', label: 'Index this folder', enabled: !S.roots.some((x) => sameOrUnder(r.path, x.path)) },
      { type: 'separator' },
      { id: 'reveal', label: 'Show in system file manager' },
      { id: 'copy', label: sel.length > 1 ? `Copy ${sel.length} paths` : 'Copy path', accel: 'Ctrl+C' },
    ];
  } else {
    items = r.kind === 1
      ? [{ id: 'open', label: `Open in ${player}`, accel: 'Enter' }, { id: 'open-default', label: 'Open with default app' }]
      : [{ id: 'open', label: 'Open', accel: 'Enter' }];
    if (r.kind !== 1 && S.boot.canPlayer) items.push({ id: 'open-player', label: `Open in ${player}` });
    if (S.searching) items.push({ id: 'goto', label: 'Go to containing folder' });
    items.push(
      { type: 'separator' },
      { id: 'reveal', label: 'Show in system file manager' },
      { id: 'copy', label: sel.length > 1 ? `Copy ${sel.length} paths` : 'Copy path', accel: 'Ctrl+C' },
    );
  }
  const pick = await mx.invoke('menu', items);
  switch (pick) {
    case 'reload': reload(); break;
    case 'index-here': addRoot(S.path); break;
    case 'hidden': S.prefs.hidden = !S.prefs.hidden; savePrefs(); refilter(); break;
    case 'auto-index':
      S.prefs.autoIndex = !S.prefs.autoIndex;
      savePrefs();
      toast(S.prefs.autoIndex ? 'Folders are indexed when opened' : 'Folders are indexed only when you ask');
      if (S.prefs.autoIndex && S.path) go(S.path, { push: false, keep: true, cached: true, scrollTop: $('scroller').scrollTop });
      break;
    case 'reveal-here': mx.invoke('open-default', S.path); break;
    case 'copy-here': mx.invoke('copy', S.path); break;
    case 'open': activate(id); break;
    case 'open-default': mx.invoke('open-default', r.path); break;
    case 'open-player': mx.invoke('open', r.path); break;
    case 'index': addRoot(r.path); break;
    case 'reveal': mx.invoke('reveal', r.path); break;
    case 'copy': copySelection(); break;
    case 'goto': go(parentOf(r.path), { focusName: r.name }); break;
    default: break;
  }
}

function copySelection() {
  const paths = view.selectedIds().map((x) => rows.get(x)).filter(Boolean).map((r) => r.path);
  if (paths.length) { mx.invoke('copy', paths.join('\n')); toast(paths.length > 1 ? `Copied ${paths.length} paths` : 'Copied path'); }
}

function reload() {
  if (S.searching) { rerunSearchSoon(); return; }
  if (S.path) { rows.clear(); go(S.path, { push: false, keep: true, scrollTop: $('scroller').scrollTop }); }
}

function refilter() {
  renderToolbar();
  if (S.searching) { runSearch(); return; }
  if (S.path) { rows.clear(); go(S.path, { push: false, keep: true, cached: true, scrollTop: 0 }); }
}

// ---------------------------------------------------------------- preview

let previewTimer = 0;
let previewId = -2;

function previewSoon(id) {
  if (!S.prefs.preview) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => renderPreview(id), 70);
}

function renderPreview(id) {
  const pv = $('pv');
  const sel = view.sel.size;
  if (sel > 1) {
    previewId = -3;
    let bytes = 0;
    let files = 0;
    let dirs = 0;
    for (const x of view.sel) { const r = rows.get(x); if (!r) continue; if (r.dir) dirs++; else { files++; bytes += Math.max(0, r.size); } }
    pv.innerHTML = `<div class="pvempty"><div class="big">${sel.toLocaleString()} selected</div><div>${files.toLocaleString()} files${dirs ? `, ${dirs} folders` : ''}</div><div>${fmtSize(bytes)}</div></div>`;
    return;
  }
  const r = id >= 0 ? rows.get(id) : null;
  if (!r) {
    previewId = -1;
    const here = S.path ? `<div class="big">${esc(baseName(S.path))}</div><div class="dim">${esc(S.path)}</div>` : '';
    pv.innerHTML = `<div class="pvempty">${S.searching ? '<div class="dim">Select a result</div>' : here + `<div>${view.n.toLocaleString()} items</div>`}</div>`;
    return;
  }
  if (previewId === id && pv.dataset.v === String(r.v)) return;
  previewId = id;
  pv.dataset.v = String(r.v);
  const ext = (r.name.split('.').pop() || '').toLowerCase();
  const thumb = thumbURL(r, 512);
  let media = '';
  if (r.dir) {
    media = thumb ? `<img class="pvimg" src="${thumb}">` : `<div class="pvicon">${icon('folder')}</div>`;
  } else if (r.kind === 2) {
    // The thumbnail first, at once; the full image replaces it once decoded.
    media = `<img class="pvimg" src="${thumb}">`;
  } else if (r.kind === 1 && PLAYABLE.has(ext) && !r.cloud) {
    // Never plays by itself: the controls are there for when you want it.
    media = `<video class="pvvid" playsinline controls preload="metadata" ${thumb ? `poster="${thumb}"` : ''} src="${fileURL(r.path)}"></video>`;
  } else if (r.kind === 3) {
    media = (thumb ? `<img class="pvimg sq" src="${thumb}">` : `<div class="pvicon">${icon('audio')}</div>`) + (r.cloud ? '' : `<audio controls preload="metadata" src="${fileURL(r.path)}"></audio>`);
  } else {
    media = thumb ? `<img class="pvimg" src="${thumb}">` : `<div class="pvicon">${icon(r.kind ? KIND_ICON[r.kind] : 'file')}</div>`;
  }
  const info = [];
  if (!r.dir) info.push(['Size', r.size >= 0 ? `${fmtSize(r.size)} <span class="dim">(${r.size.toLocaleString()} bytes)</span>` : '']);
  else if (r.count >= 0) info.push(['Contains', `${r.count.toLocaleString()} items`]);
  info.push(['Modified', fmtDate(r.mtime, true)]);
  if (!r.dir) info.push(['Type', (ext.toUpperCase() || 'File') + (r.kind ? ' ' + ['', 'video', 'photo', 'audio'][r.kind] : '')]);
  if (r.kind === 1 || r.kind === 2) info.push(['Dimensions', '<span id="pvDims" class="dim">…</span>']);
  if (r.kind === 1 || r.kind === 3) info.push(['Duration', '<span id="pvDur" class="dim">…</span>']);
  info.push(['Folder', `<a href="#" id="pvFolder">${esc(parentOf(r.path) || '')}</a>`]);
  if (r.cloud) info.push(['Storage', 'Online-only (not downloaded)']);
  pv.innerHTML = `<div class="pvmedia">${media}</div>
    <div class="pvname" title="${esc(r.path)}">${esc(r.name)}</div>
    <table class="pvinfo">${info.filter((x) => x[1]).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
    <div class="pvbtns">
      ${r.dir ? '<button class="btn key" id="pvOpen">Open folder</button>' : `<button class="btn key" id="pvOpen">${r.kind === 1 ? 'Open in ' + esc(S.boot.playerName) : 'Open'}</button>`}
      <button class="btn" id="pvReveal">Show in folder</button>
    </div>`;
  $('pvOpen').onclick = () => activate(id);
  $('pvReveal').onclick = () => mx.invoke('reveal', r.path);
  $('pvFolder').onclick = (e) => { e.preventDefault(); go(parentOf(r.path), { focusName: r.name }); };
  const dims = (w, h) => {
    const d = $('pvDims');
    if (!d || previewId !== id) return;
    if (w && h) { d.textContent = `${w} × ${h}`; d.className = ''; } else d.closest('tr').remove();
  };
  const img = pv.querySelector('.pvimg');
  const vid = pv.querySelector('video,audio');
  if (r.kind === 2 && BROWSER_IMG.has(ext) && !r.cloud) {
    const full = new Image();
    full.decoding = 'async';
    full.onload = () => dims(full.naturalWidth, full.naturalHeight);
    full.onerror = () => dims(0, 0);
    full.src = fileURL(r.path);
    // Swapped in only once decoded, so the thumbnail never blinks out.
    full.decode().then(() => {
      if (previewId === id && img.isConnected) img.replaceWith(Object.assign(full, { className: 'pvimg' }));
    }).catch(() => {});
  } else if (vid) {
    vid.addEventListener('loadedmetadata', () => {
      if (previewId !== id) return;
      if (vid.videoWidth) dims(vid.videoWidth, vid.videoHeight); else dims(0, 0);
      const d = $('pvDur');
      if (d && isFinite(vid.duration)) { d.textContent = fmtDuration(vid.duration); d.className = ''; }
    });
    vid.addEventListener('error', () => { dims(0, 0); const d = $('pvDur'); if (d) d.closest('tr').remove(); });
  } else {
    dims(0, 0);
    const d = $('pvDur');
    if (d) d.closest('tr').remove();
  }
}

const PLAYABLE = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv']);
const BROWSER_IMG = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'bmp', 'webp', 'gif', 'avif', 'ico']);

function fmtDuration(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
}

// ---------------------------------------------------------------- toolbar

function renderToolbar() {
  const p = S.prefs;
  for (const b of $('show').children) b.classList.toggle('on', b.dataset.v === p.show);
  for (const b of $('mode').children) b.classList.toggle('on', b.dataset.v === p.mode);
  $('zoom').value = p.thumb;
  $('zoom').disabled = p.mode !== 'grid';
  $('previewBtn').classList.toggle('on', p.preview);
  document.body.classList.toggle('nopreview', !p.preview);
  $('scope').textContent = p.scope === 'here' ? 'This folder' : 'Everywhere';
  $('scope').classList.toggle('on', p.scope === 'here');
  document.documentElement.style.setProperty('--side-w', p.sideW + 'px');
  document.documentElement.style.setProperty('--prev-w', p.prevW + 'px');
  renderSortUI();
}

function renderSortUI() {
  const p = S.prefs;
  const sel = $('sort');
  sel.querySelector('[value=relevance]').hidden = !S.searching;
  sel.value = S.searching ? p.ssort : p.sort;
  const desc = S.searching ? p.sdesc : p.desc;
  $('dir').innerHTML = icon(desc ? 'desc' : 'asc');
  renderListHead();
}

function renderListHead() {
  const h = $('listhead');
  const show = S.prefs.mode === 'list';
  document.body.classList.toggle('listmode', show);
  if (!show) { h.innerHTML = ''; return; }
  const sort = S.searching ? S.prefs.ssort : S.prefs.sort;
  const desc = S.searching ? S.prefs.sdesc : S.prefs.desc;
  const col = (key, label, cls) => `<span class="${cls}${sort === key ? ' sorted' : ''}" data-sort="${key}">${label}${sort === key ? (desc ? ' ▾' : ' ▴') : ''}</span>`;
  h.innerHTML = `<span class="ki"></span>${col('name', 'Name', 'c-name')}<span class="c-dir">Folder</span>${col('size', 'Size', 'c-size')}${col('date', 'Modified', 'c-date')}${col('type', 'Type', 'c-type')}`;
}

function setSort(key, toggle) {
  const p = S.prefs;
  if (S.searching) {
    if (toggle && p.ssort === key) p.sdesc = !p.sdesc; else { p.ssort = key; p.sdesc = key === 'date' || key === 'size'; }
  } else {
    if (toggle && p.sort === key) p.desc = !p.desc; else { p.sort = key; p.desc = key === 'date' || key === 'size'; }
  }
  savePrefs();
  refilter();
}

// ---------------------------------------------------------------- prefs

function loadPrefs(fromMain) {
  let p = null;
  try { p = JSON.parse(localStorage.getItem('mx.prefs') || 'null'); } catch (e) { p = null; }
  S.prefs = { ...DEFAULT_PREFS, ...(fromMain || {}), ...(p || {}) };
  if (!['media', 'video', 'photo', 'audio'].includes(S.prefs.show)) S.prefs.show = 'media';
}

let prefsTimer = 0;
function savePrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    try { localStorage.setItem('mx.prefs', JSON.stringify(S.prefs)); } catch (e) { /* storage blocked */ }
  }, 300);
}

// ---------------------------------------------------------------- misc ui

let toastTimer = 0;
function toast(msg) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function editAddress(on) {
  const addr = $('addr');
  document.body.classList.toggle('editing', on);
  if (on) {
    addr.value = S.path || '';
    addr.focus();
    addr.select();
  }
}

let completeTimer = 0;
function completeAddress() {
  clearTimeout(completeTimer);
  completeTimer = setTimeout(async () => {
    const v = $('addr').value;
    const i = Math.max(v.lastIndexOf('/'), v.lastIndexOf('\\'));
    if (i < 0) return;
    const dir = v.slice(0, i + 1);
    const names = await ix('subdirs', { path: dir.length > 1 && !/^[A-Za-z]:\\$/.test(dir) ? dir.replace(/[\\/]$/, '') : dir }).catch(() => []);
    const list = $('addrlist');
    list.innerHTML = names.slice(0, 200).map((n) => `<option value="${esc(dir + n)}">`).join('');
  }, 60);
}

function splitter(el, key, sign, min, max) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = S.prefs[key];
    const move = (ev) => {
      S.prefs[key] = Math.max(min, Math.min(max, w0 + sign * (ev.clientX - x0)));
      document.documentElement.style.setProperty(key === 'sideW' ? '--side-w' : '--prev-w', S.prefs[key] + 'px');
    };
    const upH = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', upH);
      document.body.classList.remove('dragging');
      savePrefs();
    };
    document.body.classList.add('dragging');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', upH);
  });
}

// ---------------------------------------------------------------- wiring

function wire() {
  for (const [id, name] of [['back', 'back'], ['fwd', 'fwd'], ['up', 'up'], ['reload', 'reload'], ['previewBtn', 'preview'], ['addRoot', 'plus']]) $(id).innerHTML = icon(name);
  $('mode').children[0].innerHTML = icon('grid');
  $('mode').children[1].innerHTML = icon('list');
  document.querySelector('.sicon').innerHTML = icon('search');

  $('back').onclick = back;
  $('fwd').onclick = forward;
  $('up').onclick = up;
  $('reload').onclick = reload;
  $('crumbs').onclick = () => editAddress(true);
  $('addr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { editAddress(false); go($('addr').value.trim()); }
    if (e.key === 'Escape') { editAddress(false); $('scroller').focus(); }
  });
  $('addr').addEventListener('input', completeAddress);
  $('addr').addEventListener('blur', () => setTimeout(() => editAddress(false), 100));

  const search = $('search');
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    // Coalesce a burst of keystrokes; a search over a million names costs a
    // few milliseconds, so this is about not flickering, not about load.
    searchTimer = setTimeout(runSearch, 30);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); exitSearch(true); $('scroller').focus(); }
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      runSearch();
      $('scroller').focus();
      if (view.n && view.focus < 0) view.setFocus(0);
    }
  });
  $('scope').onclick = () => {
    S.prefs.scope = S.prefs.scope === 'here' ? 'all' : 'here';
    savePrefs();
    renderToolbar();
    if (S.searching) runSearch();
  };
  $('qhelp').onclick = (e) => { e.stopPropagation(); $('help').hidden = !$('help').hidden; };
  document.addEventListener('click', (e) => { if (!$('help').hidden && !$('help').contains(e.target)) $('help').hidden = true; });

  for (const b of $('show').children) b.onclick = () => { S.prefs.show = b.dataset.v; savePrefs(); refilter(); };
  for (const b of $('mode').children) b.onclick = () => setMode(b.dataset.v);
  $('sort').onchange = () => setSort($('sort').value, false);
  $('dir').onclick = () => {
    const p = S.prefs;
    if (S.searching) p.sdesc = !p.sdesc; else p.desc = !p.desc;
    savePrefs();
    refilter();
  };
  $('listhead').onclick = (e) => { const s = e.target.closest('[data-sort]'); if (s) setSort(s.dataset.sort, true); };
  $('zoom').oninput = () => setZoom(+$('zoom').value);
  $('previewBtn').onclick = togglePreview;
  $('indexHere').onclick = () => { if (!$('indexHere').classList.contains('on')) addRoot(S.path); };
  $('addRoot').onclick = async () => { const p = await mx.invoke('pick-folder'); if (p) addRoot(p); };
  $('empty').onclick = (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'index-here') addRoot(S.path);
  };

  splitter($('sidesplit'), 'sideW', 1, 140, 480);
  splitter($('prevsplit'), 'prevW', -1, 220, 900);

  // Ctrl+wheel, or the wheel with the right button held: thumbnail size.
  $('scroller').addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !view.rmb) return;
    e.preventDefault();
    if (view.rmb) view.rmbUsed = true;
    if (S.prefs.mode !== 'grid' || !e.deltaY) return;
    setZoom(S.prefs.thumb * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // Drop a folder (or a file) on the window to go there.
  document.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const p = mx.pathForFile(f);
    if (p) go(p, {}).then(() => { if (S.error) go(parentOf(p), { focusName: baseName(p) }); });
  });

  document.addEventListener('keydown', onKey);
  mx.on('nav', (m) => {
    if (m === 'back') back();
    else if (m === 'forward') forward();
    else if (m && m.go) go(m.go);
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 3) back(); if (e.button === 4) forward(); });
}

function setMode(m) {
  S.prefs.mode = m;
  savePrefs();
  renderToolbar();
  view.setMode(m);
}

function setZoom(px) {
  px = Math.round(Math.max(96, Math.min(420, px)));
  S.prefs.thumb = px;
  $('zoom').value = px;
  view.setThumbPx(px);
  savePrefs();
  clearTimeout(setZoom.t);
  setZoom.t = setTimeout(prewarm, 400);
}

function togglePreview() {
  S.prefs.preview = !S.prefs.preview;
  savePrefs();
  renderToolbar();
  if (S.prefs.preview) renderPreview(view.focus >= 0 ? view.ids[view.focus] : -1);
  else { $('pv').innerHTML = ''; previewId = -2; }
  // The grid's width changed under it.
  requestAnimationFrame(() => view.layout(true));
}

function onKey(e) {
  const t = e.target;
  const typing = t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA';
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
  if ((ctrl && e.key === 'l') || (e.altKey && e.key === 'd')) { e.preventDefault(); editAddress(true); return; }
  if (e.key === 'F5') { e.preventDefault(); reload(); return; }
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); back(); return; }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); forward(); return; }
  if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); up(); return; }
  if (typing) return;
  if (ctrl && e.key === 'a') { e.preventDefault(); view.selectAll(); return; }
  if (ctrl && e.key === 'c') { e.preventDefault(); copySelection(); return; }
  if (ctrl && e.key === '1') { e.preventDefault(); setMode('grid'); return; }
  if (ctrl && e.key === '2') { e.preventDefault(); setMode('list'); return; }
  if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(S.prefs.thumb * 1.15); return; }
  if (ctrl && e.key === '-') { e.preventDefault(); setZoom(S.prefs.thumb / 1.15); return; }
  if (e.key === 'Backspace') { e.preventDefault(); up(); return; }
  if (e.key === 'Escape') { if (S.searching) exitSearch(true); else if (view.sel.size) { view.sel.clear(); view.renderNow(); previewSoon(-1); } return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (view.focus >= 0) activate(view.ids[view.focus]);
    return;
  }
  if (e.key === ' ' || (e.key === 'p' && !ctrl && !e.altKey)) { e.preventDefault(); togglePreview(); return; }
  const how = e.shiftKey ? 'extend' : ctrl ? 'keep' : undefined;
  if (view.move(e.key, how)) { e.preventDefault(); return; }
  // Typing anywhere searches.
  if (e.key.length === 1 && !ctrl && !e.altKey) {
    const s = $('search');
    s.focus();
    s.value = '';
    // The keystroke itself lands in the box once it has focus.
  }
}

// ---------------------------------------------------------------- boot

async function start() {
  wire();
  const boot = await mx.invoke('boot');
  S.boot = boot;
  document.body.classList.add('os-' + boot.platform);
  loadPrefs(boot.prefs);
  view.mode = S.prefs.mode;
  view.thumbPx = S.prefs.thumb;
  renderToolbar();
  loadPlaces();
  ix('roots').then((r) => { S.roots = r; renderRoots(); renderIndexButton(); renderIndexStatus(); });
  ix('stats').then((s) => { if (!S.progress) { S.progress = s; renderIndexStatus(); } });
  const first = boot.open || S.prefs.last || boot.home;
  await go(first, { push: false });
  if (S.error && first !== boot.home) await go(boot.home, { push: false });
  if (boot.index) addRoot(boot.index);
  $('scroller').focus();
  pollThumbs();
}

// While thumbnails are being made, say so; it is the one thing that can make
// the grid look unfinished.
async function pollThumbs() {
  const st = await mx.invoke('thumb-stats').catch(() => null);
  const el = $('stThumbs');
  if (st && (st.queued || st.running)) el.textContent = `Thumbnails: ${(st.queued + st.running).toLocaleString()} to make`;
  else if (st && st.background) el.textContent = `Pre-building ${st.background.toLocaleString()} thumbnails`;
  else el.textContent = '';
  setTimeout(pollThumbs, document.hasFocus() ? 700 : 3000);
}

// For --shot: what is on screen, in numbers.
window.__mxDebug = () => ({
  path: S.path,
  items: view.n,
  mode: S.prefs.mode,
  cols: view.cols,
  cells: view.active.size,
  rowsCached: rows.size,
  searching: S.searching,
  search: S.lastSearch,
  roots: S.roots.map((r) => ({ path: r.path, status: r.status, files: r.files })),
  thumbsLoaded: view.loaded.size,
  error: S.error,
});

start();
