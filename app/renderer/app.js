'use strict';
// MediaInspector_Pro control panel.
//
// Everything here is a view of the player's state: the panel sends commands
// and reflects what mpv pushes back. It never keeps a second copy of playback
// state, which is what let the old panel and the on-video bar disagree.

/* global mi */

const TIERS = {
  yellow: '#ffd000',
  blue: '#3898ff',
  green: '#40d078',
  photo: '#f0a858',
  audio: '#58c8f0',
};
const HDR_COLOUR = '#d25aff';

const MIN_PANEL = 396;   // one card column plus the panel's own padding
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

function card(title) {
  const c = el('section', 'card');
  c.appendChild(el('h2', null, title));
  cards.appendChild(c);
  return c;
}

// kinds: which media the control applies to. Buttons that do not apply are
// disabled rather than hidden, so the panel never reshuffles under the cursor.
function btn(parent, label, onClick, opts = {}) {
  const b = el('button', 'btn' + (opts.cls ? ' ' + opts.cls : ''), label);
  if (opts.grow) b.classList.add('grow');
  if (opts.kinds) b.dataset.kinds = opts.kinds.join(',');
  b.addEventListener('click', (e) => { onClick(b, e); });
  parent.appendChild(b);
  return b;
}

function label(parent, text, cls) {
  const l = el('span', cls || 'label', text);
  parent.appendChild(l);
  return l;
}

function hint(parent, text) {
  parent.appendChild(el('div', 'hint', text));
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
  i.style.width = width + 'px';
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

function slider(parent, key, name, min, max) {
  const r = el('div', 'slider-row');
  const val = el('span', 'val', '0');
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
    val.textContent = input.value;
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

  r.appendChild(el('span', 'label', name));
  r.appendChild(input);
  r.appendChild(val);
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

// ---------------------------------------------------------------- cards

const lookSliders = [];
let cropBoxes = null;
let browseToggle = null;
let cropBtnHead = null;
let shaderBox = null;
let gpuLine = null;
let autoPanelToggle = null;

function buildCards() {
  cards.innerHTML = '';

  // ---- playback ----
  let c = card('Playback & Transport');
  let r = row(c);
  btn(r, '⏵  Play / Pause', () => mi.cmd('cycle', 'pause'), { cls: 'accent', grow: true, kinds: ['video', 'audio'] });
  r = row(c, 'tight');
  btn(r, '« -10s', () => mi.cmd('seek', -10, 'exact'), { grow: true, kinds: ['video', 'audio'] });
  btn(r, '‹ -1s', () => mi.cmd('seek', -1, 'exact'), { grow: true, kinds: ['video', 'audio'] });
  btn(r, '‹ Frame', () => mi.cmd('frame-back-step'), { grow: true, kinds: ['video'] });
  btn(r, 'Frame ›', () => mi.cmd('frame-step'), { grow: true, kinds: ['video'] });
  btn(r, '+1s ›', () => mi.cmd('seek', 1, 'exact'), { grow: true, kinds: ['video', 'audio'] });
  btn(r, '+10s »', () => mi.cmd('seek', 10, 'exact'), { grow: true, kinds: ['video', 'audio'] });
  r = row(c, 'tight');
  for (const sp of [0.25, 0.5, 1, 2]) {
    btn(r, sp + 'x', () => mi.set('speed', sp), { grow: true, kinds: ['video', 'audio'] });
  }
  btn(r, 'Slow-mo', () => mi.binding('slowmo_toggle'), { grow: true, kinds: ['video'] });

  // ---- media ----
  c = card('Media & Navigation');
  r = row(c);
  btn(r, 'Open Media…', () => mi.invoke('open-media'), { grow: true });
  btn(r, 'Media Info', () => mi.binding('show_info'));
  r = row(c);
  btn(r, '« Previous', () => mi.binding('prev_media'), { grow: true });
  btn(r, 'Next »', () => mi.binding('next_media'), { grow: true });
  btn(r, 'Open Exports', () => mi.invoke('open-folder', S.exportDir));
  r = row(c);
  label(r, 'Browse videos only');
  browseToggle = toggle(r, true, (on) => mi.setting('browse_all', on ? 'no' : 'yes'));
  hint(c, 'Off also steps through photos and audio in the folder. (b)');

  // ---- crop ----
  c = card('Crop');
  r = row(c);
  btn(r, 'Adjust on the Picture  (c)', () => mi.scriptMessage('mi-crop-edit'), { cls: 'accent', grow: true, kinds: ['video', 'photo'] });
  hint(c, 'Drag the box or its handles over the picture. Enter applies, Esc cancels.');
  r = row(c, 'ratios');
  for (const ratio of ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '5:4', '4:5', '21:9']) {
    const [rw, rh] = ratio.split(':');
    btn(r, ratio, () => mi.scriptMessage('mi-crop-aspect', rw, rh, ratio), { kinds: ['video', 'photo'] });
  }
  r = row(c, 'tight');
  label(r, 'W', 'label').style.minWidth = '14px';
  const cw = textbox(r, '', 66);
  label(r, 'H', 'label').style.minWidth = '14px';
  const ch = textbox(r, '', 66);
  label(r, 'X', 'label').style.minWidth = '14px';
  const cx = textbox(r, '0', 56);
  label(r, 'Y', 'label').style.minWidth = '14px';
  const cy = textbox(r, '0', 56);
  cropBoxes = { w: cw, h: ch, x: cx, y: cy, shown: '' };
  r = row(c);
  btn(r, 'Apply Crop', () => {
    if (!cw.value || !ch.value) return;
    mi.scriptMessage('mi-crop-rect', cw.value, ch.value, cx.value || '0', cy.value || '0');
  }, { grow: true, kinds: ['video', 'photo'] });
  btn(r, 'Clear Crop', () => mi.scriptMessage('mi-crop-clear'), { grow: true, kinds: ['video', 'photo'] });
  btn(r, 'Centre', () => mi.scriptMessage('mi-crop-center'), { grow: true, kinds: ['video', 'photo'] });

  // ---- image ----
  c = card('Image Inspection & Zoom');
  r = row(c);
  btn(r, 'Fit to Window', () => mi.binding('zoom_fit'), { grow: true, kinds: ['video', 'photo'] });
  btn(r, '1:1 Actual Pixels', () => mi.binding('zoom_actual'), { grow: true, kinds: ['video', 'photo'] });
  r = row(c);
  btn(r, 'Zoom In', () => mi.binding('zoom_in'), { grow: true, kinds: ['video', 'photo'] });
  btn(r, 'Zoom Out', () => mi.binding('zoom_out'), { grow: true, kinds: ['video', 'photo'] });
  btn(r, 'Reset Zoom', () => mi.set('video-zoom', 0), { grow: true, kinds: ['video', 'photo'] });
  r = row(c);
  btn(r, 'Rotate Left', () => mi.binding('rotate_ccw'), { grow: true, kinds: ['video', 'photo'] });
  btn(r, 'Rotate Right', () => mi.binding('rotate_cw'), { grow: true, kinds: ['video', 'photo'] });
  btn(r, 'Reset Pan', () => { mi.set('video-pan-x', 0); mi.set('video-pan-y', 0); }, { grow: true, kinds: ['video', 'photo'] });
  r = row(c);
  btn(r, 'Export Frame', () => mi.binding('export_frame'), { grow: true, kinds: ['video', 'photo'] });

  // ---- display / audio / tools ----
  c = card('Display, Audio & Tools');
  r = row(c);
  btn(r, 'Fullscreen', () => mi.invoke('fullscreen'), { grow: true });
  btn(r, 'Always On Top', (b) => mi.invoke('always-on-top').then((on) => b.classList.toggle('on', on)), { grow: true });
  btn(r, 'Shortcuts Overlay', () => mi.binding('toggle_help'), { grow: true });
  r = row(c);
  btn(r, 'UI Scale −', () => mi.binding('ui_scale_down'), { grow: true });
  btn(r, 'UI Scale +', () => mi.binding('ui_scale_up'), { grow: true });
  btn(r, 'Reset', () => mi.binding('ui_scale_reset'), { grow: true });
  r = row(c);
  btn(r, 'Mute', () => mi.cmd('cycle', 'mute'), { grow: true, kinds: ['video', 'audio'] });
  btn(r, 'Vol −', () => mi.cmd('add', 'volume', -5), { grow: true, kinds: ['video', 'audio'] });
  btn(r, 'Vol +', () => mi.cmd('add', 'volume', 5), { grow: true, kinds: ['video', 'audio'] });
  r = row(c);
  btn(r, 'Sound Settings', () => mi.binding('audio_menu'), { grow: true, kinds: ['video', 'audio'] });
  btn(r, 'Cycle Audio Track', () => mi.cmd('cycle', 'audio'), { grow: true, kinds: ['video', 'audio'] });
  r = row(c);
  btn(r, 'Loop File', () => mi.cmd('cycle-values', 'loop-file', 'inf', 'no'), { grow: true, kinds: ['video', 'audio'] });
  btn(r, 'A-B Loop', () => mi.cmd('ab-loop'), { grow: true, kinds: ['video', 'audio'] });
  btn(r, 'Toggle HDR', () => mi.binding('hdr_toggle'), { grow: true });
  btn(r, 'Deband', () => mi.cmd('cycle', 'deband'), { grow: true });
  r = row(c);
  btn(r, 'Quit', () => mi.invoke('quit'), { cls: 'danger', grow: true });

  // ---- look ----
  c = card('Visual Adjustments (Look)');
  lookSliders.length = 0;
  const group = (name) => c.appendChild(el('div', 'section', name));
  group('White balance');
  lookSliders.push(slider(c, 'temp', 'Temperature', -100, 100));
  lookSliders.push(slider(c, 'tint', 'Tint', -100, 100));
  group('Light');
  lookSliders.push(slider(c, 'brightness', 'Brightness', -100, 100));
  lookSliders.push(slider(c, 'contrast', 'Contrast', -100, 100));
  lookSliders.push(slider(c, 'highlights', 'Highlights', -100, 100));
  lookSliders.push(slider(c, 'shadows', 'Shadows', -100, 100));
  lookSliders.push(slider(c, 'gamma', 'Gamma', -100, 100));
  group('Colour');
  lookSliders.push(slider(c, 'vibrance', 'Vibrance', -100, 100));
  lookSliders.push(slider(c, 'saturation', 'Saturation', -100, 100));
  lookSliders.push(slider(c, 'hue', 'Hue', -100, 100));
  group('Texture');
  lookSliders.push(slider(c, 'sharpness', 'Sharpness', -100, 100));
  lookSliders.push(slider(c, 'vignette', 'Vignette', 0, 100));
  r = row(c);
  btn(r, 'Reset All Adjustments', () => {
    S.look = {};
    for (const s of lookSliders) { s.input.value = 0; s.paint(); }
    pushLook();
  }, { grow: true });
  hint(c, 'Applies to playback, exported frames and trimmed clips. Double-click a slider to zero it.');

  // ---- upscale ----
  c = card('GPU Upscale & Enhancements');
  gpuLine = el('div', 'hint', 'GPU: …');
  c.appendChild(gpuLine);
  r = row(c);
  label(r, 'Mode');
  select(r, ['Off', 'RTX Video Super Resolution'], S.upscaleMode, (v) => {
    saveState({ upscaleMode: v });
    mi.invoke('push-upscale');
  }).classList.add('grow');
  r = row(c);
  label(r, 'Factor');
  select(r, ['1.5', '2', '3', '4'], S.upscaleFactor, (v) => {
    saveState({ upscaleFactor: v });
    mi.invoke('push-upscale');
  });
  label(r, 'RTX Video HDR');
  toggle(r, S.rtxHdr, (on) => {
    saveState({ rtxHdr: on });
    mi.invoke('push-upscale');
  });
  hint(c, 'GPU shaders (config\\shaders)');
  shaderBox = el('div', 'shaders');
  c.appendChild(shaderBox);
  renderShaders();
  r = row(c);
  btn(r, 'Rescan', async () => {
    shaderFiles = await mi.invoke('shaders');
    renderShaders();
    toast('Rescanned config\\shaders');
  }, { grow: true });
  btn(r, 'Open Folder', () => mi.invoke('open-shaders'), { grow: true });
  r = row(c);
  label(r, 'Scaler');
  select(r, ['ewa_lanczos4sharpest', 'ewa_lanczossharp', 'ewa_lanczos', 'lanczos', 'spline36',
    'spline64', 'mitchell', 'catmull_rom', 'bicubic', 'bilinear', 'nearest'], S.scaler, (v) => {
    saveState({ scaler: v });
    mi.set('scale', v);
    mi.set('cscale', v);
    toast('Renderer scaler: ' + v);
  }).classList.add('grow');
  r = row(c);
  label(r, 'Downscale');
  select(r, ['mitchell', 'catmull_rom', 'lanczos', 'spline36', 'box', 'bilinear'], S.dscaler, (v) => {
    saveState({ dscaler: v });
    mi.set('dscale', v);
    toast('Downscaler: ' + v);
  }).classList.add('grow');
  r = row(c);
  label(r, 'Renderer API');
  const apiSel = select(r, ['D3D11 (RTX VSR)', 'Vulkan'], S.renderApi, () => {});
  apiSel.classList.add('grow');
  btn(r, 'Apply', () => mi.invoke('render-api', apiSel.value));
  hint(c, 'Shaders apply everywhere. RTX needs hardware-decoded video on D3D11, and restarts the player.');

  // ---- trim ----
  c = card('Trim & Clip Export');
  r = row(c);
  label(r, 'In', 'label').style.minWidth = '20px';
  const trimIn = textbox(r, '0', 92);
  label(r, 'Out', 'label').style.minWidth = '28px';
  const trimOut = textbox(r, '', 92);
  r = row(c);
  btn(r, 'Set In = now', () => { trimIn.value = (props['time-pos'] || 0).toFixed(3); }, { grow: true, kinds: ['video', 'audio'] });
  btn(r, 'Set Out = now', () => { trimOut.value = (props['time-pos'] || 0).toFixed(3); }, { grow: true, kinds: ['video', 'audio'] });
  r = row(c);
  btn(r, 'Export Trimmed Clip', () => mi.invoke('trim', { trimIn: trimIn.value, trimOut: trimOut.value }),
    { grow: true, kinds: ['video', 'audio'] });
  hint(c, 'Times in seconds. Blank Out = end of file. The crop and the look go with it.');

  // ---- window / export settings ----
  c = card('Window & Export Settings');
  r = row(c);
  label(r, 'Fit window to each file').style.minWidth = '180px';
  toggle(r, S.fitWindow, (on) => saveState({ fitWindow: on }));
  r = row(c);
  label(r, 'Fit panel to media shape').style.minWidth = '180px';
  autoPanelToggle = toggle(r, S.autoPanel, (on) => {
    saveState({ autoPanel: on });
    if (on) applyAutoPanel();
  });
  hint(c, 'On, the panel widens for portrait media so the picture fills its side.');
  r = row(c);
  label(r, 'Export folder').style.minWidth = '96px';
  const expDir = textbox(r, S.exportDir, 210, (v) => {
    saveState({ exportDir: v });
    mi.setting('export_dir', v);
  });
  expDir.classList.add('grow');
  btn(r, '…', async () => {
    const dir = await mi.invoke('pick-folder');
    if (dir) {
      expDir.value = dir;
      saveState({ exportDir: dir });
      mi.setting('export_dir', dir);
    }
  });
  r = row(c);
  label(r, 'Format');
  select(r, ['jpg', 'png', 'webp'], S.exportFormat, (v) => {
    saveState({ exportFormat: v });
    mi.setting('export_format', v);
  });
  label(r, 'Scale %');
  textbox(r, S.exportScale, 56, (v) => {
    saveState({ exportScale: v });
    mi.setting('export_scale', v);
  });
  label(r, 'Resampler');
  select(r, ['lanczos', 'spline', 'bicubic', 'neighbor'], S.exportScaler, (v) => {
    saveState({ exportScaler: v });
    mi.setting('export_scaler', v);
  });
  hint(c, 'Above 100% upscales on export through the chosen resampler.');

  // ---- shortcuts ----
  c = card('Keyboard Shortcuts');
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
  c.appendChild(dl);
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

// ---------------------------------------------------------------- status

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

function renderStatus() {
  const paused = props['pause'];
  const hdrLive = (props['video-params/gamma'] === 'pq' || props['video-params/gamma'] === 'hlg')
    && props['target-colorspace-hint'] !== 'no' && props['target-colorspace-hint'] !== undefined;

  let line1;
  if (kind === 'photo') {
    const zoom = Math.pow(2, props['video-zoom'] || 0);
    line1 = `PHOTO   ${mediaW}x${mediaH}   zoom ${zoom.toFixed(2)}`;
  } else {
    const sp = props['speed'];
    const speed = (typeof sp === 'number' && Math.abs(sp - 1) > 0.01) ? `   ${sp.toFixed(2)}x` : '';
    const dir = props['play-direction'] === 'backward' ? '   ◀ reverse' : '';
    line1 = `${paused ? 'PAUSED ' : 'PLAYING'}   ${fmtTime(props['time-pos'])} / ${fmtTime(props['duration'])}${speed}${dir}`;
  }
  if (props['user-data/mi/crop']) line1 += '   crop ' + props['user-data/mi/crop'].split(':').slice(0, 2).join('x');
  if (hdrLive) line1 += '   HDR';

  const hw = props['hwdec-current'];
  const vol = props['volume'];
  const name = props['filename'] || '';
  const line2 = [
    props['mute'] ? 'muted' : 'vol ' + (typeof vol === 'number' ? Math.round(vol) : '?') + '%',
    (!hw || hw === 'no') ? 'SW (CPU)' : 'HW (' + hw + ')',
    `${mediaW}x${mediaH}`,
    name.length > 60 ? name.slice(0, 59) + '~' : name,
  ].join('   ');

  $('#line1').textContent = connected ? line1
    : (playerDead ? 'Player exited.' : 'Connecting to player…');
  $('#line2').textContent = line2;
  $('#line1').style.color = hdrLive ? HDR_COLOUR : 'var(--accent)';
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

  if (browseToggle && document.activeElement !== browseToggle) {
    browseToggle.checked = p['user-data/mi/set_browse_all'] !== 'yes';
  }
  if (cropBtnHead) cropBtnHead.classList.toggle('on', p['user-data/mi/crop_editing'] === true);

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
  if (!S.exportDir) S.exportDir = info.exportDir;
  shaderFiles = info.shaders || [];

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
    case 'ontop': mi.invoke('always-on-top').then((on) => b.classList.toggle('on', on)); break;
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
