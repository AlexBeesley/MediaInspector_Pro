'use strict';
// MediaInspector_Pro control panel.
//
// Everything here is a view of the player's state: the panel sends commands
// and reflects what mpv pushes back. It never keeps a second copy of playback
// state, which is what let the old panel and the on-video bar disagree.
//
// Two rules shape the layout, both taken from how editing tools are built:
//
//   A control shows its own state. Speed is a segmented control with the live
//   speed lit, not four buttons that look identical whichever one you pressed;
//   mute, loop, HDR, deband and on-top light up when they are on. Every one of
//   them is registered as a reflector and updated from the same status push,
//   so the panel cannot drift out of step with the player.
//
//   The accent means "engaged" and nothing else. Primary actions get a lighter
//   face instead of a coloured one, because a saturated slab reads as a state
//   and an action is not a state.

/* global mi */

const TIERS = {
  yellow: '#ffd000',
  blue: '#3898ff',
  green: '#40d078',
  photo: '#f0a858',
  audio: '#58c8f0',
};
const MIN_PANEL = 340;   // one card column plus the panel's own padding
const MIN_VIDEO = 320;

let S = {};              // persisted panel state
let props = {};          // last snapshot the player pushed
let shaderFiles = [];
let kind = '';
let tier = 'yellow';
let mediaW = 16;
let mediaH = 9;
let uiScale = 1;
let connected = false;
let playerDead = false;

const $ = (sel) => document.querySelector(sel);
const stage = $('#stage');
const panel = $('#panel');
const cards = $('#cards');
const splitter = $('#splitter');

// ---------------------------------------------------------------- icons

// Drawn rather than pulled from a font: a dozen glyphs is not worth a
// dependency, and these have to line up with the on-video bar's own shapes.
const ICONS = {
  play: ['solid', 'M8 5.2v13.6L19 12z'],
  pause: ['solid', 'M7.5 5h3.2v14H7.5zM13.3 5h3.2v14h-3.2z'],
  prevFile: ['solid', 'M2.5 5h2v14h-2zM12.2 6.4v11.2L5.2 12zM21.5 6.4v11.2L14.5 12z'],
  nextFile: ['solid', 'M19.5 5h2v14h-2zM11.8 6.4v11.2L18.8 12zM2.5 6.4v11.2L9.5 12z'],
  frameBack: ['solid', 'M4 5h2v14H4zM19.5 6v12L8.8 12z'],
  frameFwd: ['solid', 'M18 5h2v14h-2zM4.5 6v12L15.2 12z'],
  open: ['stroke', 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  crop: ['stroke', 'M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14'],
  expand: ['stroke', 'M3 9V4h5M21 9V4h-5M3 15v5h5M21 15v5h-5'],
  pin: ['stroke', 'M12 17v5M8 3h8l-1 7 3 3v2H6v-2l3-3z'],
  info: ['stroke', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 11v5M12 7.6v.6'],
  folder: ['stroke', 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  volume: ['stroke', 'M4 9v6h3.5L13 19.5v-15L7.5 9zM17 9.5a3.5 3.5 0 0 1 0 5M19.5 7a7 7 0 0 1 0 10'],
  mute: ['stroke', 'M4 9v6h3.5L13 19.5v-15L7.5 9zM17 10l4 4M21 10l-4 4'],
  zoomIn: ['stroke', 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-3.9-3.9M11 8.5v5M8.5 11h5'],
  zoomOut: ['stroke', 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-3.9-3.9M8.5 11h5'],
  fit: ['stroke', 'M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3'],
  oneToOne: ['stroke', 'M3.5 5.5h17a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1M10.2 10.2h3.6v3.6h-3.6z'],
  rotateCw: ['stroke', 'M20 5v5h-5M20 10a8 8 0 1 0-1.6 6.2'],
  rotateCcw: ['stroke', 'M4 5v5h5M4 10a8 8 0 1 1 1.6 6.2'],
  pan: ['stroke', 'M12 3.5v17M3.5 12h17M12 3.5 9.8 6M12 3.5 14.2 6M12 20.5 9.8 18M12 20.5 14.2 18M3.5 12 6 9.8M3.5 12 6 14.2M20.5 12 18 9.8M20.5 12 18 14.2'],
  camera: ['stroke', 'M3 8.5A1.5 1.5 0 0 1 4.5 7H8l1.5-2h5L16 7h3.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7'],
  loop: ['stroke', 'M4 10.5A4.5 4.5 0 0 1 8.5 6H19M19 6l-3-3M19 6l-3 3M20 13.5A4.5 4.5 0 0 1 15.5 18H5M5 18l3 3M5 18l3-3'],
  scissors: ['stroke', 'M6.5 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M6.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M8.7 7 19 19M8.7 17 19 5'],
  keyboard: ['stroke', 'M3 6.5h18a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8'],
  sparkle: ['stroke', 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z'],
  sliders: ['stroke', 'M5 4v6M5 14v6M12 4v3M12 11v9M19 4v9M19 17v3M2.5 12h5M9.5 9h5M16.5 15h5'],
  quit: ['stroke', 'M15 5h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3M11 15.5 14.5 12 11 8.5M14 12H4'],
  reset: ['stroke', 'M4 5v5h5M4 10a8 8 0 1 1 1.6 6.2'],
};

// Swaps the glyph in a button, and only when it actually changed: status
// pushes arrive several times a second and rebuilding an SVG on each one is
// churn for nothing.
function setIcon(b, name) {
  if (b.dataset.icon === name) return;
  b.dataset.icon = name;
  b.replaceChild(icon(name), b.firstChild);
}

function icon(name) {
  const spec = ICONS[name];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (spec && spec[0] === 'solid') svg.classList.add('solid');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', spec ? spec[1] : '');
  svg.appendChild(p);
  return svg;
}

// ---------------------------------------------------------------- helpers

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function row(parent, cls) {
  const r = el('div', 'row' + (cls ? ' ' + cls : ''));
  parent.appendChild(r);
  return r;
}

function divider(parent) {
  parent.appendChild(el('div', 'div'));
}

// Every card folds and remembers it, because ten of them do not fit on a
// screen and the ones a given job needs are never all of them. The transport
// is the exception: it is why the panel is on screen, so it has no header to
// fold and cannot be shut.
function card(title, key, opts = {}) {
  const c = el('section', 'card');
  const body = el('div', 'body');

  if (opts.primary) {
    c.classList.add('primary');
  } else {
    const h = el('h2');
    h.appendChild(el('span', 'caret'));
    h.appendChild(el('span', null, title));
    h.appendChild(el('span', 'spacer'));
    const badge = el('span', 'badge');
    h.appendChild(badge);
    c.badge = badge;
    const open = S.open && key in S.open ? S.open[key] : opts.open !== false;
    if (!open) c.classList.add('closed');
    h.addEventListener('click', () => {
      c.classList.toggle('closed');
      const map = Object.assign({}, S.open);
      map[key] = !c.classList.contains('closed');
      saveState({ open: map });
    });
    c.appendChild(h);
  }

  c.appendChild(body);
  c.body = body;
  cards.appendChild(c);
  return c;
}

// kinds: which media the control applies to. Controls that do not apply are
// disabled rather than hidden, so the panel never reshuffles under the cursor.
function btn(parent, labelText, onClick, opts = {}) {
  const b = el('button', 'btn' + (opts.cls ? ' ' + opts.cls : ''));
  if (opts.icon) {
    b.appendChild(icon(opts.icon));
    b.dataset.icon = opts.icon;
    b.classList.add('ico');
    if (labelText) b.classList.add('wide');
  }
  if (labelText) b.appendChild(el('span', null, labelText));
  if (opts.title) b.title = opts.title;
  else if (!labelText && opts.icon) b.title = opts.icon;
  if (opts.grow) b.classList.add('grow');
  if (opts.kinds) b.dataset.kinds = opts.kinds.join(',');
  b.addEventListener('click', (e) => { onClick(b, e); });
  parent.appendChild(b);
  return b;
}

// A choice out of a few, showing which one is live. Rows of separate buttons
// cannot do that, which is why the speed row used to say nothing about speed.
function segmented(parent, items, onPick, opts = {}) {
  const g = el('div', 'seg' + (opts.grow ? ' grow' : ''));
  const made = items.map((it) => {
    const b = btn(g, it.label, () => onPick(it.value, it), { kinds: opts.kinds, title: it.title });
    if (opts.disabledWhenEmpty) b.dataset.seg = '1';
    b.dataset.value = String(it.value);
    return b;
  });
  parent.appendChild(g);
  return {
    node: g,
    set(value) {
      const v = String(value);
      for (const b of made) b.classList.toggle('on', b.dataset.value === v);
    },
  };
}

function label(parent, text, cls) {
  const l = el('span', cls || 'label', text);
  parent.appendChild(l);
  return l;
}

function hint(parent, text) {
  parent.appendChild(el('div', 'hint', text));
}

function section(parent, name) {
  parent.appendChild(el('div', 'section', name));
}

function toggle(parent, checked, onChange) {
  const t = el('input', 'tog');
  t.type = 'checkbox';
  t.checked = !!checked;
  t.addEventListener('change', () => onChange(t.checked, t));
  parent.appendChild(t);
  return t;
}

function textbox(parent, value, width, onChange) {
  const i = el('input');
  i.type = 'text';
  i.value = value == null ? '' : String(value);
  // A falsy width means "let the layout decide"; an inline 0px would beat the
  // stylesheet rule that stretches these to their grid cell.
  if (width) i.style.width = width + 'px';
  if (onChange) i.addEventListener('change', () => onChange(i.value, i));
  parent.appendChild(i);
  return i;
}

function select(parent, options, value, onChange) {
  const s = el('select');
  for (const o of options) {
    const opt = el('option', null, o);
    opt.value = o;
    s.appendChild(opt);
  }
  s.value = value;
  s.addEventListener('change', () => onChange(s.value, s));
  parent.appendChild(s);
  return s;
}

// The value is a field, not a readout: nudging a look and typing a number you
// already know are both things you want from the same control.
function slider(parent, key, name, min, max) {
  const r = el('div', 'slider-row');
  const num = el('input', 'num');
  num.type = 'text';
  const input = el('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.step = 1;
  input.value = S.look[key] || 0;

  const paint = () => {
    const pct = ((input.value - min) / (max - min)) * 100;
    const zero = Math.max(0, Math.min(100, ((0 - min) / (max - min)) * 100));
    input.style.setProperty('--a', Math.min(pct, zero) + '%');
    input.style.setProperty('--b', Math.max(pct, zero) + '%');
    if (document.activeElement !== num) num.value = input.value;
    r.classList.toggle('dirty', Number(input.value) !== 0);
  };
  paint();

  input.addEventListener('input', () => {
    S.look[key] = Number(input.value);
    paint();
    pushLook();
  });
  input.addEventListener('dblclick', () => {
    input.value = 0;
    S.look[key] = 0;
    paint();
    pushLook();
  });
  const commit = () => {
    const v = Math.max(min, Math.min(max, Math.round(Number(num.value) || 0)));
    input.value = v;
    S.look[key] = v;
    paint();
    pushLook();
  };
  num.addEventListener('change', commit);
  num.addEventListener('blur', () => { num.value = input.value; });

  r.appendChild(el('span', 'label', name));
  r.appendChild(input);
  r.appendChild(num);
  parent.appendChild(r);
  return { input, paint };
}

let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// Container rotation and the viewer's own rotation both turn the picture; a
// quarter turn either way swaps which side is long.
function displayShape(p) {
  const w = p['dwidth'] || p['width'] || 0;
  const h = p['dheight'] || p['height'] || 0;
  const turn = (((p['video-params/rotate'] || 0) + (p['video-rotate'] || 0)) % 180 + 180) % 180;
  return turn === 90 ? [h, w] : [w, h];
}

function fmtTime(t) {
  if (typeof t !== 'number' || !isFinite(t)) return '0:00';
  t = Math.max(0, t);
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = Math.floor(t % 60);
  const p = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

let lookTimer = null;
function pushLook() {
  clearTimeout(lookTimer);
  lookTimer = setTimeout(() => mi.invoke('look', S.look), 90);
}

function saveState(patch) {
  Object.assign(S, patch);
  mi.invoke('state', patch);
}

// ---------------------------------------------------------------- reflectors

// One list of "read the player, set the control", run on every status push.
// Live state lives here and nowhere else, so a control cannot be wired up to
// send a command and then quietly forget to show that it worked.
const reflect = [];
const onStatusUpdate = (fn) => reflect.push(fn);

// A card that is folded still has to say whether anything inside it is on.
function badge(c, fn) {
  onStatusUpdate((p) => {
    if (!c.badge) return;
    const text = fn(p);
    c.badge.textContent = text || '';
    c.badge.classList.toggle('show', !!text);
  });
}

// ---------------------------------------------------------------- cards

const lookSliders = [];
let cropBoxes = null;
let cropBtnHead = null;
let shaderBox = null;
let gpuLine = null;
let autoPanelToggle = null;
let headTopBtn = null;
let scrubbing = false;

function buildCards() {
  cards.innerHTML = '';
  reflect.length = 0;

  // ---- transport -------------------------------------------------------
  // Timecode, a scrubber and the transport cluster, in that order, because
  // that is the order they are read in: where am I, take me somewhere, play.
  let c = card('Transport', 'transport', { primary: true });
  let b = c.body;

  const tc = el('div', 'tc');
  const tcNow = el('span', 'now', '0:00');
  const tcDur = el('span', 'dur', '/ 0:00');
  const tcFlags = el('div', 'flags');
  tc.appendChild(tcNow);
  tc.appendChild(tcDur);
  tc.appendChild(tcFlags);
  b.appendChild(tc);

  // The panel had no scrubber at all: position was reachable only on the
  // picture. Seeks are throttled to one in flight so dragging lands where the
  // pointer is instead of queueing up a run of them.
  const scrubWrap = el('div', 'scrub');
  const scrub = el('input');
  scrub.type = 'range';
  scrub.min = 0;
  scrub.max = 1000;
  scrub.step = 1;
  scrub.value = 0;
  scrub.title = 'Position';
  scrubWrap.appendChild(scrub);
  b.appendChild(scrubWrap);

  let seekTimer = null;
  let seekWanted = null;
  const flushSeek = () => {
    seekTimer = null;
    if (seekWanted == null) return;
    mi.cmd('seek', seekWanted, 'absolute', 'exact');
    seekWanted = null;
    seekTimer = setTimeout(flushSeek, 90);
  };
  const paintScrub = (frac) => {
    scrub.style.setProperty('--a', '0%');
    scrub.style.setProperty('--b', (frac * 100).toFixed(2) + '%');
  };
  scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  scrub.addEventListener('pointerup', () => { scrubbing = false; });
  scrub.addEventListener('input', () => {
    const dur = props['duration'];
    if (!dur) return;
    scrubbing = true;
    const frac = scrub.value / 1000;
    paintScrub(frac);
    tcNow.textContent = fmtTime(frac * dur);
    seekWanted = frac * dur;
    if (!seekTimer) flushSeek();
  });
  scrub.addEventListener('change', () => { scrubbing = false; });

  let r = row(b, 'center');
  btn(r, '', () => mi.binding('prev_media'), { icon: 'prevFile', title: 'Previous file  (←)' });
  btn(r, '', () => mi.cmd('frame-back-step'), { icon: 'frameBack', title: 'Step back one frame  (Shift+←)', kinds: ['video'] });
  const playBtn = btn(r, '', () => mi.cmd('cycle', 'pause'),
    { icon: 'play', cls: 'play', title: 'Play / pause  (Space)', kinds: ['video', 'audio'] });
  btn(r, '', () => mi.cmd('frame-step'), { icon: 'frameFwd', title: 'Step forward one frame  (Shift+→)', kinds: ['video'] });
  btn(r, '', () => mi.binding('next_media'), { icon: 'nextFile', title: 'Next file  (→)' });

  r = row(b);
  for (const [text, secs] of [['−10s', -10], ['−1s', -1], ['+1s', 1], ['+10s', 10]]) {
    btn(r, text, () => mi.cmd('seek', secs, 'exact'), { grow: true, kinds: ['video', 'audio'] });
  }

  r = row(b);
  const speedSeg = segmented(r, [0.25, 0.5, 1, 2].map((v) => ({ label: v + '×', value: v })),
    (v) => mi.set('speed', v), { grow: true, kinds: ['video', 'audio'] });
  const slowmoBtn = btn(r, 'Slow-mo', () => mi.binding('slowmo_toggle'),
    { title: 'Conform the source fps to the 24fps target  (s)', kinds: ['video'] });

  onStatusUpdate((p) => {
    // A photo has no position to show and nothing to scrub, so the readout
    // stands down rather than sitting there reading 0:00 / 0:00.
    const timed = kind !== 'photo';
    tc.style.display = timed ? '' : 'none';
    scrubWrap.style.display = timed ? '' : 'none';

    setIcon(playBtn, p['pause'] === false ? 'pause' : 'play');
    const dur = p['duration'] || 0;
    const pos = p['time-pos'] || 0;
    if (!scrubbing) {
      const frac = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
      scrub.value = Math.round(frac * 1000);
      paintScrub(frac);
      tcNow.textContent = fmtTime(pos);
    }
    scrub.disabled = !(dur > 0);
    tcDur.textContent = '/ ' + fmtTime(dur);

    // Which preset is live, if any. Slow-mo conforms to a rate the source
    // dictates, so it shows as engaged exactly when the speed is one no preset
    // offers - that is what distinguishes it from a preset being picked.
    const sp = typeof p['speed'] === 'number' ? p['speed'] : 1;
    const preset = [0.25, 0.5, 1, 2].find((v) => Math.abs(sp - v) < 0.005);
    speedSeg.set(preset === undefined ? '' : preset);
    slowmoBtn.classList.toggle('on', preset === undefined);

    tcFlags.innerHTML = '';
    const flag = (t) => tcFlags.appendChild(el('span', 'flag', t));
    if (Math.abs(sp - 1) > 0.005) flag(sp.toFixed(2) + '×');
    if (p['play-direction'] === 'backward') flag('REVERSE');
    if (p['loop-file'] === 'inf') flag('LOOP');
    if (p['user-data/mi/crop']) flag('CROP');
  });

  // ---- media -----------------------------------------------------------
  c = card('Media', 'media');
  b = c.body;
  r = row(b);
  btn(r, 'Open…', () => mi.invoke('open-media'), { icon: 'open', cls: 'key grow' });
  btn(r, '', () => mi.binding('show_info'), { icon: 'info', title: 'Media info  (i)' });
  btn(r, '', () => mi.invoke('open-folder', S.exportDir), { icon: 'folder', title: 'Open the exports folder' });
  r = row(b);
  label(r, 'Browse').style.minWidth = '52px';
  const browseSeg = segmented(r, [
    { label: 'Videos only', value: 'no' },
    { label: 'All media', value: 'yes' },
  ], (v) => mi.setting('browse_all', v), { grow: true });
  hint(b, 'What ← and → step through in this folder. (b)');
  onStatusUpdate((p) => browseSeg.set(p['user-data/mi/set_browse_all'] === 'yes' ? 'yes' : 'no'));

  // ---- view ------------------------------------------------------------
  c = card('View', 'view');
  b = c.body;
  r = row(b);
  btn(r, 'Fit', () => mi.binding('zoom_fit'), { icon: 'fit', cls: 'grow', title: 'Fit to window  (z)', kinds: ['video', 'photo'] });
  btn(r, '1:1', () => mi.binding('zoom_actual'), { icon: 'oneToOne', cls: 'grow', title: 'Actual pixels  (x)', kinds: ['video', 'photo'] });
  divider(r);
  btn(r, '', () => mi.binding('zoom_out'), { icon: 'zoomOut', title: 'Zoom out', kinds: ['video', 'photo'] });
  btn(r, '', () => mi.binding('zoom_in'), { icon: 'zoomIn', title: 'Zoom in', kinds: ['video', 'photo'] });
  r = row(b);
  btn(r, '', () => mi.binding('rotate_ccw'), { icon: 'rotateCcw', title: 'Rotate left  (Shift+R)', kinds: ['video', 'photo'] });
  btn(r, '', () => mi.binding('rotate_cw'), { icon: 'rotateCw', title: 'Rotate right  (r)', kinds: ['video', 'photo'] });
  divider(r);
  btn(r, 'Reset zoom', () => mi.set('video-zoom', 0), { icon: 'reset', cls: 'grow', kinds: ['video', 'photo'] });
  btn(r, 'Reset pan', () => { mi.set('video-pan-x', 0); mi.set('video-pan-y', 0); },
    { icon: 'pan', cls: 'grow', kinds: ['video', 'photo'] });
  r = row(b);
  btn(r, 'Export frame', () => mi.binding('export_frame'),
    { icon: 'camera', cls: 'key grow', title: 'Write the decoded frame to Exports/  (e)', kinds: ['video', 'photo'] });
  const zoomFlag = el('div', 'hint', '');
  b.appendChild(zoomFlag);
  onStatusUpdate((p) => {
    const z = Math.pow(2, p['video-zoom'] || 0);
    const rot = ((p['video-rotate'] || 0) % 360 + 360) % 360;
    zoomFlag.textContent = `Zoom ${z.toFixed(2)}×` + (rot ? `   ·   rotated ${rot}°` : '');
  });
  badge(c, (p) => {
    const z = Math.pow(2, p['video-zoom'] || 0);
    return Math.abs(z - 1) > 0.005 ? z.toFixed(2) + '×' : '';
  });

  // ---- crop ------------------------------------------------------------
  c = card('Crop', 'crop', { open: false });
  b = c.body;
  r = row(b);
  const cropEdit = btn(r, 'Adjust on the picture', () => mi.scriptMessage('mi-crop-edit'),
    { icon: 'crop', cls: 'key grow', title: '(c)', kinds: ['video', 'photo'] });
  hint(b, 'Drag the box or its handles over the picture. Enter applies, Esc cancels.');
  section(b, 'Ratio');
  r = row(b, 'ratios');
  const ratioBtns = [];
  for (const ratio of ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '5:4', '4:5', '21:9']) {
    const [rw, rh] = ratio.split(':');
    const rb = btn(r, ratio, () => mi.scriptMessage('mi-crop-aspect', rw, rh, ratio), { kinds: ['video', 'photo'] });
    rb.dataset.ratio = ratio;
    ratioBtns.push(rb);
  }
  section(b, 'Rectangle');
  r = row(b, 'fields');
  const field = (name, value) => {
    label(r, name, 'label').style.minWidth = '12px';
    return textbox(r, value, 0);
  };
  const cw = field('W', '');
  const ch = field('H', '');
  const cx = field('X', '0');
  const cy = field('Y', '0');
  cropBoxes = { w: cw, h: ch, x: cx, y: cy, shown: '' };
  r = row(b);
  btn(r, 'Apply', () => {
    if (!cw.value || !ch.value) return;
    mi.scriptMessage('mi-crop-rect', cw.value, ch.value, cx.value || '0', cy.value || '0');
  }, { grow: true, kinds: ['video', 'photo'] });
  btn(r, 'Centre', () => mi.scriptMessage('mi-crop-center'), { grow: true, kinds: ['video', 'photo'] });
  btn(r, 'Clear', () => mi.scriptMessage('mi-crop-clear'), { grow: true, kinds: ['video', 'photo'] });
  onStatusUpdate((p) => {
    cropEdit.classList.toggle('on', p['user-data/mi/crop_editing'] === true);
    const live = p['user-data/mi/crop_ratio'] || '';
    for (const rb of ratioBtns) rb.classList.toggle('on', rb.dataset.ratio === live);
  });
  badge(c, (p) => {
    const v = p['user-data/mi/crop'];
    return v ? v.split(':').slice(0, 2).join('×') : '';
  });

  // ---- audio -----------------------------------------------------------
  c = card('Audio', 'audio', { open: false });
  b = c.body;
  r = row(b);
  const muteBtn = btn(r, '', () => mi.cmd('cycle', 'mute'), { icon: 'volume', title: 'Mute  (m)', kinds: ['video', 'audio'] });
  btn(r, '−', () => mi.cmd('add', 'volume', -5), { grow: true, title: 'Volume down  (9)', kinds: ['video', 'audio'] });
  const volRead = el('span', 'label mono');
  volRead.style.cssText = 'min-width:44px;text-align:center';
  r.appendChild(volRead);
  btn(r, '+', () => mi.cmd('add', 'volume', 5), { grow: true, title: 'Volume up  (0)', kinds: ['video', 'audio'] });
  r = row(b);
  btn(r, 'Sound settings', () => mi.binding('audio_menu'), { grow: true, kinds: ['video', 'audio'] });
  btn(r, 'Cycle track', () => mi.cmd('cycle', 'audio'), { grow: true, title: '(a)', kinds: ['video', 'audio'] });
  onStatusUpdate((p) => {
    const muted = !!p['mute'];
    setIcon(muteBtn, muted ? 'mute' : 'volume');
    muteBtn.classList.toggle('on', muted);
    const v = p['volume'];
    volRead.textContent = muted ? 'muted' : (typeof v === 'number' ? Math.round(v) + '%' : '—');
  });
  badge(c, (p) => (p['mute'] ? 'muted' : ''));

  // ---- playback options ------------------------------------------------
  c = card('Playback options', 'opts', { open: false });
  b = c.body;
  r = row(b);
  const loopBtn = btn(r, 'Loop file', () => mi.cmd('cycle-values', 'loop-file', 'inf', 'no'),
    { icon: 'loop', cls: 'grow', kinds: ['video', 'audio'] });
  const abBtn = btn(r, 'A-B loop', () => mi.cmd('ab-loop'), { cls: 'grow', kinds: ['video', 'audio'] });
  r = row(b);
  const hdrBtn = btn(r, 'HDR', () => mi.binding('hdr_toggle'), { cls: 'grow', title: 'Allow HDR passthrough  (Ctrl+H)' });
  const debandBtn = btn(r, 'Deband', () => mi.cmd('cycle', 'deband'), { cls: 'grow' });
  hint(b, 'HDR engages only for PQ/HLG sources, and resets to off on every launch.');
  onStatusUpdate((p) => {
    loopBtn.classList.toggle('on', p['loop-file'] === 'inf');
    abBtn.classList.toggle('on', typeof p['ab-loop-a'] === 'number');
    debandBtn.classList.toggle('on', !!p['deband']);
    hdrBtn.classList.toggle('on', hdrLive(p));
  });
  badge(c, (p) => {
    const on = [];
    if (p['loop-file'] === 'inf') on.push('loop');
    if (hdrLive(p)) on.push('HDR');
    if (p['deband']) on.push('deband');
    return on.join(' · ');
  });

  // ---- look ------------------------------------------------------------
  c = card('Colour', 'look', { open: false });
  b = c.body;
  lookSliders.length = 0;
  section(b, 'White balance');
  lookSliders.push(slider(b, 'temp', 'Temperature', -100, 100));
  lookSliders.push(slider(b, 'tint', 'Tint', -100, 100));
  section(b, 'Light');
  lookSliders.push(slider(b, 'brightness', 'Brightness', -100, 100));
  lookSliders.push(slider(b, 'contrast', 'Contrast', -100, 100));
  lookSliders.push(slider(b, 'highlights', 'Highlights', -100, 100));
  lookSliders.push(slider(b, 'shadows', 'Shadows', -100, 100));
  lookSliders.push(slider(b, 'gamma', 'Gamma', -100, 100));
  section(b, 'Colour');
  lookSliders.push(slider(b, 'vibrance', 'Vibrance', -100, 100));
  lookSliders.push(slider(b, 'saturation', 'Saturation', -100, 100));
  lookSliders.push(slider(b, 'hue', 'Hue', -100, 100));
  section(b, 'Texture');
  lookSliders.push(slider(b, 'sharpness', 'Sharpness', -100, 100));
  lookSliders.push(slider(b, 'vignette', 'Vignette', 0, 100));
  r = row(b);
  btn(r, 'Reset all', () => {
    S.look = {};
    for (const s of lookSliders) { s.input.value = 0; s.paint(); }
    pushLook();
  }, { icon: 'reset', cls: 'grow' });
  hint(b, 'Applies to playback, exported frames and trimmed clips. Double-click a slider to zero it.');
  badge(c, () => {
    const n = Object.values(S.look || {}).filter((v) => v).length;
    return n ? n + ' active' : '';
  });

  // ---- upscale ---------------------------------------------------------
  c = card('Upscale & enhance', 'upscale', { open: false });
  b = c.body;
  gpuLine = el('div', 'hint', 'GPU: …');
  gpuLine.style.margin = '0 0 6px';
  b.appendChild(gpuLine);
  r = row(b);
  label(r, 'Mode');
  select(r, ['Off', 'RTX Video Super Resolution'], S.upscaleMode, (v) => {
    saveState({ upscaleMode: v });
    mi.invoke('push-upscale');
  }).classList.add('grow');
  r = row(b);
  label(r, 'Factor');
  select(r, ['1.5', '2', '3', '4'], S.upscaleFactor, (v) => {
    saveState({ upscaleFactor: v });
    mi.invoke('push-upscale');
  });
  label(r, 'RTX Video HDR').style.minWidth = '92px';
  toggle(r, S.rtxHdr, (on) => {
    saveState({ rtxHdr: on });
    mi.invoke('push-upscale');
  });
  section(b, 'GPU shaders');
  shaderBox = el('div', 'shaders');
  b.appendChild(shaderBox);
  renderShaders();
  r = row(b);
  r.style.marginTop = '4px';
  btn(r, 'Rescan', async () => {
    shaderFiles = await mi.invoke('shaders');
    renderShaders();
    toast('Rescanned config\\shaders');
  }, { grow: true });
  btn(r, 'Open folder', () => mi.invoke('open-shaders'), { icon: 'folder', grow: true });
  section(b, 'Renderer');
  r = row(b);
  label(r, 'Scaler');
  select(r, ['ewa_lanczos4sharpest', 'ewa_lanczossharp', 'ewa_lanczos', 'lanczos', 'spline36',
    'spline64', 'mitchell', 'catmull_rom', 'bicubic', 'bilinear', 'nearest'], S.scaler, (v) => {
    saveState({ scaler: v });
    mi.set('scale', v);
    mi.set('cscale', v);
    toast('Renderer scaler: ' + v);
  }).classList.add('grow');
  r = row(b);
  label(r, 'Downscale');
  select(r, ['mitchell', 'catmull_rom', 'lanczos', 'spline36', 'box', 'bilinear'], S.dscaler, (v) => {
    saveState({ dscaler: v });
    mi.set('dscale', v);
    toast('Downscaler: ' + v);
  }).classList.add('grow');
  r = row(b);
  label(r, 'API');
  const apiSel = select(r, ['D3D11 (RTX VSR)', 'Vulkan'], S.renderApi, () => {});
  apiSel.classList.add('grow');
  btn(r, 'Apply', () => mi.invoke('render-api', apiSel.value));
  hint(b, 'Shaders apply everywhere. RTX needs hardware-decoded video on D3D11, and restarts the player.');
  badge(c, () => {
    const on = [];
    if (S.upscaleMode && S.upscaleMode !== 'Off') on.push('RTX');
    const n = (S.shaders || []).length;
    if (n) on.push(n + ' shader' + (n > 1 ? 's' : ''));
    return on.join(' · ');
  });

  // ---- trim ------------------------------------------------------------
  c = card('Trim & export clip', 'trim', { open: false });
  b = c.body;
  r = row(b, 'trim');
  label(r, 'In', 'label').style.minWidth = '24px';
  const trimIn = textbox(r, '0', 0);
  btn(r, 'Set', () => { trimIn.value = (props['time-pos'] || 0).toFixed(3); },
    { title: 'Set to the current position', kinds: ['video', 'audio'] });
  r = row(b, 'trim');
  label(r, 'Out', 'label').style.minWidth = '24px';
  const trimOut = textbox(r, '', 0);
  btn(r, 'Set', () => { trimOut.value = (props['time-pos'] || 0).toFixed(3); },
    { title: 'Set to the current position', kinds: ['video', 'audio'] });
  r = row(b);
  btn(r, 'Export trimmed clip', () => mi.invoke('trim', { trimIn: trimIn.value, trimOut: trimOut.value }),
    { icon: 'scissors', cls: 'key grow', kinds: ['video', 'audio'] });
  hint(b, 'Times in seconds. Blank Out = end of file. The crop and the colour go with it.');

  // ---- window & export -------------------------------------------------
  c = card('Window & export', 'window', { open: false });
  b = c.body;
  r = row(b);
  label(r, 'Fit window to each file').style.minWidth = '168px';
  toggle(r, S.fitWindow, (on) => saveState({ fitWindow: on }));
  r = row(b);
  label(r, 'Fit panel to media shape').style.minWidth = '168px';
  autoPanelToggle = toggle(r, S.autoPanel, (on) => {
    saveState({ autoPanel: on });
    if (on) applyAutoPanel();
  });
  hint(b, 'On, the panel widens for portrait media so the picture fills its side.');
  section(b, 'Frame export');
  r = row(b);
  label(r, 'Folder').style.minWidth = '52px';
  const expDir = textbox(r, S.exportDir, 180, (v) => {
    saveState({ exportDir: v });
    mi.setting('export_dir', v);
  });
  expDir.classList.add('grow');
  btn(r, '', async () => {
    const dir = await mi.invoke('pick-folder');
    if (dir) {
      expDir.value = dir;
      saveState({ exportDir: dir });
      mi.setting('export_dir', dir);
    }
  }, { icon: 'folder', title: 'Choose a folder' });
  r = row(b);
  label(r, 'Format').style.minWidth = '52px';
  select(r, ['jpg', 'png', 'webp'], S.exportFormat, (v) => {
    saveState({ exportFormat: v });
    mi.setting('export_format', v);
  });
  label(r, 'Scale %').style.minWidth = '48px';
  textbox(r, S.exportScale, 48, (v) => {
    saveState({ exportScale: v });
    mi.setting('export_scale', v);
  });
  r = row(b);
  label(r, 'Resampler').style.minWidth = '52px';
  select(r, ['lanczos', 'spline', 'bicubic', 'neighbor'], S.exportScaler, (v) => {
    saveState({ exportScaler: v });
    mi.setting('export_scaler', v);
  }).classList.add('grow');
  hint(b, 'Above 100% upscales on export through the chosen resampler.');

  // ---- window controls / quit ------------------------------------------
  c = card('Window', 'wintools', { open: false });
  b = c.body;
  r = row(b);
  btn(r, 'Fullscreen', () => mi.invoke('fullscreen'), { icon: 'expand', cls: 'grow', title: '(f)' });
  const topBtn = btn(r, 'On top', (bt) => mi.invoke('always-on-top').then((on) => bt.classList.toggle('on', on)),
    { icon: 'pin', cls: 'grow' });
  r = row(b);
  label(r, 'UI scale').style.minWidth = '58px';
  btn(r, '−', () => mi.binding('ui_scale_down'), { grow: true, title: 'Ctrl+−' });
  btn(r, '+', () => mi.binding('ui_scale_up'), { grow: true, title: 'Ctrl+=' });
  btn(r, 'Reset', () => mi.binding('ui_scale_reset'), { grow: true, title: 'Ctrl+0' });
  r = row(b);
  btn(r, 'Shortcuts overlay', () => mi.binding('toggle_help'), { icon: 'keyboard', cls: 'grow', title: '(h)' });
  r = row(b);
  btn(r, 'Quit', () => mi.invoke('quit'), { icon: 'quit', cls: 'danger grow' });
  headTopBtn = topBtn;

  // ---- shortcuts -------------------------------------------------------
  c = card('Keyboard shortcuts', 'keys', { open: false });
  b = c.body;
  const dl = el('dl', 'keys');
  const keys = [
    ['← / →', 'Previous / next file'],
    ['Shift+← / →', 'Step one frame'],
    ['b', 'Browse videos only / all media'],
    ['c', 'Adjust the crop on the picture'],
    ['Enter / Esc', 'Apply / cancel the crop'],
    ['s', 'Slow-mo conform'],
    ['e', 'Export frame / image'],
    ['i', 'Media info'],
    ['u', 'Cycle GPU upscaler'],
    ['z / x', 'Zoom fit / 1:1'],
    ['r / Shift+R', 'Rotate right / left'],
    ['w', 'Refit window to media'],
    ['Ctrl+H', 'Toggle HDR'],
    ['9 / 0, m, a', 'Volume, mute, track'],
    ['Space', 'Play / pause'],
    ['Wheel', 'Shuttle (video) / zoom (photo)'],
    ['Ctrl+Wheel, drag', 'Zoom / pan'],
  ];
  for (const [k, v] of keys) {
    dl.appendChild(el('dt', null, k));
    dl.appendChild(el('dd', null, v));
  }
  b.appendChild(dl);
}

function renderShaders() {
  shaderBox.innerHTML = '';
  if (!shaderFiles.length) {
    shaderBox.appendChild(el('div', 'hint', 'No .glsl files in config\\shaders'));
    return;
  }
  for (const sh of shaderFiles) {
    const l = el('label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = (S.shaders || []).includes(sh.path);
    cb.addEventListener('change', () => {
      const list = new Set(S.shaders || []);
      if (cb.checked) list.add(sh.path); else list.delete(sh.path);
      saveState({ shaders: [...list] });
      mi.invoke('push-upscale');
    });
    l.appendChild(cb);
    l.appendChild(el('span', null, sh.name.replace(/\.glsl$/i, '')));
    shaderBox.appendChild(l);
  }
}

// ---------------------------------------------------------------- header

function buildHead() {
  const h = $('#headbtns');
  h.innerHTML = '';
  const mk = (iconName, act, title) => {
    const b = btn(h, '', () => {}, { icon: iconName, title });
    b.dataset.act = act;
    return b;
  };
  mk('open', 'open', 'Open a file…');
  mk('crop', 'crop', 'Adjust the crop on the picture  (c)');
  mk('expand', 'fullscreen', 'Fullscreen  (f)');
  mk('pin', 'ontop', 'Keep the window on top');
}

function hdrLive(p) {
  return (p['video-params/gamma'] === 'pq' || p['video-params/gamma'] === 'hlg')
    && p['target-colorspace-hint'] !== 'no' && p['target-colorspace-hint'] !== undefined;
}

// The header answers "what am I looking at": the kind, the name, and the
// handful of specs worth knowing before touching anything. What the player is
// *doing* is the transport card's job, so none of it is repeated here.
function renderStatus() {
  const p = props;
  $('#kind').textContent = kind || 'media';

  if (!connected) {
    $('#title').textContent = playerDead ? 'Player exited.' : 'Connecting to player…';
    $('#specs').innerHTML = '';
    return;
  }
  $('#title').textContent = p['filename'] || '—';

  const specs = $('#specs');
  specs.innerHTML = '';
  const chip = (text, cls) => {
    if (!text) return;
    specs.appendChild(el('span', 'chip' + (cls ? ' ' + cls : ''), text));
  };

  chip(`${mediaW}×${mediaH}`);
  const fps = p['container-fps'];
  if (typeof fps === 'number' && fps > 0) {
    chip(fps.toFixed(fps < 100 ? 2 : 1).replace(/\.?0+$/, '') + ' fps', kind === 'video' ? 'lit' : '');
  }
  chip(p['video-format'] || p['audio-codec-name']);
  const hw = p['hwdec-current'];
  chip((!hw || hw === 'no') ? 'CPU decode' : 'HW ' + hw);
  if (hdrLive(p)) chip('HDR', 'hdr');
  // Only once the decoder has actually produced one: it reads 0 for a moment
  // after a load, and "frame 0" beside a non-zero timecode is a lie.
  const n = p['estimated-frame-number'];
  if (typeof n === 'number' && n > 0 && kind === 'video') chip('frame ' + n);
}

function applyTier(name) {
  tier = name;
  document.documentElement.style.setProperty('--accent', TIERS[name] || TIERS.yellow);
}

function applyKind(k) {
  kind = k;
  for (const b of document.querySelectorAll('.btn[data-kinds]')) {
    b.disabled = !b.dataset.kinds.split(',').includes(k);
  }
}

function onStatus(p) {
  props = p;

  const t = p['user-data/mi/tier'];
  if (t && t !== tier) applyTier(t);
  const k = p['user-data/mi/kind'];
  if (k && k !== kind) applyKind(k);

  // The shape the layout has to fit is the shape on screen, which is neither
  // the decoded size nor mpv's reported one:
  //   - a crop makes dwidth/dheight differ from width/height, and
  //   - a phone shoots 3840x2160 with a rotate-90 flag, which every one of
  //     mpv's size properties reports unrotated. That is why portrait clips
  //     were laid out as landscape and sat in a letterbox a third as wide as
  //     the window - the panel was sizing for a shape that was never on screen.
  const [w, h] = displayShape(p);
  if (w >= 1 && h >= 1 && (w !== mediaW || h !== mediaH || uiScale !== p['user-data/mi/ui_scale'])) {
    mediaW = w;
    mediaH = h;
    uiScale = p['user-data/mi/ui_scale'];
    applyAutoPanel();
  }

  // The crop boxes follow the box on the picture, including mid-drag, but
  // never while one of them is being typed into.
  if (cropBoxes) {
    const v = p['user-data/mi/crop'] || '';
    const typing = [cropBoxes.w, cropBoxes.h, cropBoxes.x, cropBoxes.y].includes(document.activeElement);
    if (!typing && v !== cropBoxes.shown) {
      cropBoxes.shown = v;
      const parts = v.split(':');
      if (parts.length === 4) {
        cropBoxes.w.value = parts[0];
        cropBoxes.h.value = parts[1];
        cropBoxes.x.value = parts[2];
        cropBoxes.y.value = parts[3];
      } else {
        cropBoxes.w.value = '';
        cropBoxes.h.value = '';
        cropBoxes.x.value = '0';
        cropBoxes.y.value = '0';
      }
    }
  }

  if (cropBtnHead) cropBtnHead.classList.toggle('on', p['user-data/mi/crop_editing'] === true);

  for (const fn of reflect) fn(p);
  renderStatus();
}

// ---------------------------------------------------------------- layout

let reportTimer = null;
function reportStage() {
  if (reportTimer) return;
  reportTimer = requestAnimationFrame(() => {
    reportTimer = null;
    const r = stage.getBoundingClientRect();
    mi.videoRect({ x: r.x, y: r.y, width: r.width, height: r.height });
  });
}

function setPanelWidth(px) {
  const total = document.body.clientWidth - splitter.offsetWidth;
  const max = Math.max(MIN_PANEL, total - MIN_VIDEO);
  const w = Math.round(Math.max(MIN_PANEL, Math.min(px, max)));
  document.documentElement.style.setProperty('--panel-w', w + 'px');
  return w;
}

// Give the picture the shape it actually wants and hand the rest to the cards:
// a portrait clip in a landscape window would otherwise sit in a wide letterbox
// with a one-column panel beside it.
//
// The player reserves real space at the top and bottom of its own window for
// the status strip and the control dock (STATUS_H + SUBBAR_H + BAR_H = 100
// unscaled pixels, times the UI scale it publishes), and the picture is
// letterboxed inside what is left. Subtracting that here is the difference
// between "nearly fills" and fills.
function playerChromeHeight() {
  const scale = props['user-data/mi/ui_scale'];
  return 100 * (typeof scale === 'number' && scale > 0 ? scale : 1);
}

function applyAutoPanel() {
  if (!S.autoPanel) return;
  const total = document.body.clientWidth - splitter.offsetWidth;
  const h = $('#body').clientHeight - playerChromeHeight();
  if (total < 10 || h < 10 || mediaW < 1 || mediaH < 1) return;
  setPanelWidth(total - h * (mediaW / mediaH));
}

function initSplitter() {
  let dragging = false;
  let startX = 0;
  let moved = false;

  splitter.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
    startX = e.clientX;
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // A click that never travelled is not a drag. Without this, brushing the
    // splitter was enough to switch the panel to a manual width for good.
    if (!moved && Math.abs(e.clientX - startX) < 4) return;
    moved = true;
    setPanelWidth(e.clientX);
    // A real drag is a deliberate choice: stop second-guessing it.
    if (S.autoPanel) {
      saveState({ autoPanel: false });
      if (autoPanelToggle) autoPanelToggle.checked = false;
      toast('Panel width is manual now — double-click the splitter to hand it back');
    }
  });
  splitter.addEventListener('pointerup', (e) => {
    dragging = false;
    splitter.releasePointerCapture(e.pointerId);
    splitter.classList.remove('dragging');
    if (moved) saveState({ panelWidth: panel.clientWidth });
  });
  splitter.addEventListener('dblclick', () => {
    saveState({ autoPanel: true });
    if (autoPanelToggle) autoPanelToggle.checked = true;
    applyAutoPanel();
    toast('Panel follows the media shape again');
  });
}

// ---------------------------------------------------------------- keyboard

// Keys reach the player wherever focus happens to be: mpv owns the bindings,
// this only forwards what the page would otherwise swallow.
const KEYMAP = {
  ' ': 'SPACE', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', ArrowUp: 'UP', ArrowDown: 'DOWN',
  Enter: 'ENTER', Escape: 'ESC', Backspace: 'BS', PageUp: 'PGUP', PageDown: 'PGDWN',
  Home: 'HOME', End: 'END', Delete: 'DEL', Tab: 'TAB',
};

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;

    let key = KEYMAP[e.key] || (e.key.length === 1 ? e.key : null);
    if (!key) return;
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey && key.length > 1) mods.push('Shift');
    mi.keypress(mods.length ? mods.join('+') + '+' + key : key);
    e.preventDefault();
  });
}

// ---------------------------------------------------------------- startup

async function init() {
  const info = await mi.invoke('init');
  S = info.state;
  S.look = S.look || {};
  S.open = S.open || {};
  if (!S.exportDir) S.exportDir = info.exportDir;
  shaderFiles = info.shaders || [];

  buildHead();
  buildCards();
  panel.scrollTop = 0;
  applyTier('yellow');
  applyKind('video');

  if (S.autoPanel) applyAutoPanel();
  else if (S.panelWidth) setPanelWidth(S.panelWidth);

  initSplitter();
  initKeyboard();

  cropBtnHead = [...document.querySelectorAll('#headbtns .btn')].find((b) => b.dataset.act === 'crop');

  new ResizeObserver(reportStage).observe(stage);
  window.addEventListener('resize', () => { applyAutoPanel(); reportStage(); });
  reportStage();

  mi.on('status', onStatus);
  mi.on('log', (text) => toast(text));
  mi.on('gpu', (name) => { if (gpuLine) gpuLine.textContent = 'GPU: ' + name; });
  mi.on('connection', (c) => {
    connected = c.connected;
    playerDead = !c.connected && c.alive === false;
    // The hint only earns its place when there is no picture over it.
    $('#hint').style.display = c.connected ? 'none' : '';
    renderStatus();
  });
}

// Header buttons
document.addEventListener('click', (e) => {
  const b = e.target.closest('#headbtns .btn');
  if (!b) return;
  switch (b.dataset.act) {
    case 'open': mi.invoke('open-media'); break;
    case 'crop': mi.scriptMessage('mi-crop-edit'); break;
    case 'fullscreen': mi.invoke('fullscreen'); break;
    case 'ontop': mi.invoke('always-on-top').then((on) => {
      b.classList.toggle('on', on);
      if (headTopBtn) headTopBtn.classList.toggle('on', on);
    }); break;
  }
});

// Clicking the picture should hand the keyboard back to the player.
stage.addEventListener('mousedown', () => mi.focusVideo());

// Drag and drop anywhere in the window loads the file.
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragover'); });
document.addEventListener('dragleave', () => document.body.classList.remove('dragover'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) mi.invoke('load-file', mi.pathForFile(f));
});

init();
