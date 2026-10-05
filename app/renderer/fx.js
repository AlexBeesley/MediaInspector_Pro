'use strict';
// The three effect cards: Audio X-ray, Speed ramp and Motion trail.
//
// Loaded before app.js and built from inside its buildCards(), so everything
// here can lean on app.js's helpers (card, row, btn, props, S...) at call
// time. The work itself happens elsewhere: the spectrogram, trail and live
// ramp in config/scripts/mediainspector.lua, the analysis and exports in
// app/xray.js, app/motion.js and app/ramp.js. These cards draw and send.

/* global mi, S, props, kind, el, row, btn, card, label, hint, section, toggle,
   segmented, toast, saveState, onStatusUpdate, badge, fmtTime, trimBoxes */

// ---------------------------------------------------------------- shared

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// A canvas at device resolution, with its context scaled so drawing code can
// work in CSS pixels.
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, cv.clientWidth);
  const h = Math.max(1, cv.clientHeight);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// A plain labelled slider in the same row style as the colour sliders, for
// settings that are not part of the look.
function valueSlider(parent, name, min, max, value, onChange) {
  const r = el('div', 'slider-row');
  const input = el('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.step = 1;
  input.value = value;
  const out = el('span', 'num mono', String(value));
  const paint = () => {
    input.style.setProperty('--a', '0%');
    input.style.setProperty('--b', ((input.value - min) / (max - min)) * 100 + '%');
    out.textContent = input.value;
  };
  paint();
  input.addEventListener('input', () => { paint(); onChange(Number(input.value), false); });
  input.addEventListener('change', () => onChange(Number(input.value), true));
  r.appendChild(el('span', 'label', name));
  r.appendChild(input);
  r.appendChild(out);
  parent.appendChild(r);
  return input;
}

// In and Out from the Trim card, when Out has been set: the range the exports
// here use before falling back to one of their own.
function trimRange() {
  if (!trimBoxes) return null;
  const n = (v) => { const x = parseFloat(v); return isFinite(x) ? x : null; };
  const a = n(trimBoxes.in.value) || 0;
  const b = n(trimBoxes.out.value);
  const dur = props['duration'] || 0;
  if (b == null || b <= a) return null;
  return { a, b: dur ? Math.min(b, dur) : b };
}

const kHz = (hz) => (hz / 1000).toFixed(1) + ' kHz';

// ---------------------------------------------------------------- Audio X-ray

// magma, the palette the live spectrogram uses, so the two pictures of the
// same sound look like the same thing.
const MAGMA = (() => {
  const stops = [
    [0, 0, 0, 4], [0.13, 28, 16, 68], [0.25, 79, 18, 123], [0.38, 129, 37, 129],
    [0.5, 181, 54, 122], [0.63, 229, 80, 100], [0.75, 251, 135, 97],
    [0.88, 254, 194, 135], [1, 252, 253, 191],
  ];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, ...c0] = stops[k];
    const [t1, ...c1] = stops[k + 1];
    const u = (t - t0) / (t1 - t0);
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = Math.round(c0[j] + (c1[j] - c0[j]) * u);
  }
  return lut;
})();

const xr = { state: 'idle', result: null, path: null, error: '', bitmap: null, ui: null };

mi.on('xray', (m) => {
  xr.state = m.state;
  xr.path = m.path || null;
  xr.error = m.error || '';
  xr.result = m.state === 'done' ? m.result : null;
  xr.bitmap = xr.result ? spectrogramBitmap(xr.result) : null;
  paintXray();
});

// The analysis is column-major (time across, frequency up); a canvas wants
// rows from the top, so it is turned and coloured here, once per file.
function spectrogramBitmap(r) {
  if (!r.cols) return null;
  const c = document.createElement('canvas');
  c.width = r.cols;
  c.height = r.rows;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(r.cols, r.rows);
  const src = r.image;
  for (let x = 0; x < r.cols; x++) {
    for (let y = 0; y < r.rows; y++) {
      const v = src[x * r.rows + (r.rows - 1 - y)];
      const o = (y * r.cols + x) * 4;
      img.data[o] = MAGMA[v * 3];
      img.data[o + 1] = MAGMA[v * 3 + 1];
      img.data[o + 2] = MAGMA[v * 3 + 2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function paintXray() {
  const u = xr.ui;
  if (!u) return;
  const r = xr.result;
  u.wrap.classList.toggle('busy', xr.state === 'running');
  u.verdict.className = 'verdict' + (r ? ' lvl-' + r.verdict.level : '');
  u.vTitle.textContent = xr.state === 'running' ? 'Analysing the spectrum…'
    : xr.state === 'error' ? 'Analysis failed'
      : r ? r.verdict.title : 'No analysis yet';
  u.vDetail.textContent = xr.state === 'error' ? xr.error
    : r ? r.verdict.detail
      : 'Audio files are analysed as they open. For a video\'s soundtrack, press Analyse.';
  u.stats.textContent = r
    ? [kHz(r.sampleRate) + ' sample rate',
      'content to ' + kHz(r.extentHz || r.sampleRate / 2),
      r.cutoffHz ? 'cutoff ' + kHz(r.cutoffHz) : 'no cutoff',
      r.truncated ? 'first 30 min' : ''].filter(Boolean).join('  ·  ')
    : '';
  drawOverview();
}

function drawOverview() {
  const u = xr.ui;
  if (!u) return;
  const { ctx, w, h } = fitCanvas(u.cv);
  ctx.fillStyle = '#07070a';
  ctx.fillRect(0, 0, w, h);
  const r = xr.result;
  if (!r || !xr.bitmap) {
    ctx.fillStyle = cssVar('--faint');
    ctx.font = '10.5px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(xr.state === 'running' ? 'Decoding…' : 'Spectrum appears here', w / 2, h / 2 + 4);
    return;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(xr.bitmap, 0, 0, w, h);

  const nyq = r.sampleRate / 2;
  const step = nyq <= 12000 ? 2000 : nyq <= 30000 ? 5000 : 10000;
  ctx.font = '9px "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  for (let f = step; f < nyq - step * 0.3; f += step) {
    const y = h - (f / nyq) * h;
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    ctx.fillRect(0, Math.round(y), w, 1);
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.fillText(f / 1000 + 'k', 3, y - 2);
  }
  if (r.cutoffHz) {
    const y = Math.round(h - (r.cutoffHz / nyq) * h);
    ctx.fillStyle = '#d25aff';
    ctx.fillRect(0, y, w, 1.5);
    ctx.textAlign = 'right';
    ctx.fillText('cutoff ' + kHz(r.cutoffHz), w - 4, y - 3);
  }
  // The playhead, only over the file the picture belongs to.
  if (xr.path === props['path'] && r.seconds > 0) {
    const x = Math.round(((props['time-pos'] || 0) / r.seconds) * w);
    if (x >= 0 && x <= w) {
      ctx.fillStyle = cssVar('--accent');
      ctx.fillRect(x - 0.5, 0, 1.5, h);
    }
  }
}

function buildXrayCard() {
  const c = card('Audio X-ray', 'xray', { open: false });
  const b = c.body;
  let r = row(b);
  label(r, 'Live spectrogram').style.minWidth = '104px';
  const specTog = toggle(r, S.spectrogram, (on) => {
    saveState({ spectrogram: on });
    mi.setting('spectrogram', on ? 'yes' : 'no');
  });
  specTog.title = 'Show audio files as a scrolling spectrogram instead of cover art';
  r.appendChild(el('span', 'grow'));
  btn(r, 'Analyse', () => mi.invoke('xray'), {
    icon: 'sparkle', kinds: ['video', 'audio'],
    title: 'Decode the whole soundtrack and read its spectrum',
  });

  const wrap = el('div', 'xray');
  const cv = el('canvas', 'overview');
  cv.title = 'Click to jump there';
  wrap.appendChild(cv);
  b.appendChild(wrap);
  cv.addEventListener('click', (e) => {
    const res = xr.result;
    if (!res || xr.path !== props['path']) return;
    const rect = cv.getBoundingClientRect();
    mi.cmd('seek', ((e.clientX - rect.left) / rect.width) * res.seconds, 'absolute', 'exact');
  });

  const verdict = el('div', 'verdict');
  const vTitle = el('div', 'v-title');
  const vDetail = el('div', 'v-detail');
  verdict.appendChild(vTitle);
  verdict.appendChild(vDetail);
  b.appendChild(verdict);
  const stats = el('div', 'hint mono');
  b.appendChild(stats);

  xr.ui = { wrap, cv, verdict, vTitle, vDetail, stats };
  new ResizeObserver(() => drawOverview()).observe(cv);
  onStatusUpdate((p) => {
    specTog.checked = p['user-data/mi/set_spectrogram'] === 'yes';
    if (xr.result) drawOverview();
  });
  badge(c, () => {
    const res = xr.result;
    if (xr.state === 'running') return 'analysing…';
    if (!res) return '';
    return { genuine: 'lossless', suspect: 'suspect', lossy: 'lossy', unknown: '' }[res.verdict.level];
  });
  paintXray();
}

// ---------------------------------------------------------------- Speed ramp

// The curve the player follows. Same function as fx.ramp_eval in the Lua
// script and evaluate() in app/ramp.js - the page cannot require() the
// latter, so it is repeated here and the three must stay in step.
function rampEval(pts, t) {
  const n = pts.length;
  if (!n) return 1;
  if (t <= pts[0].t) return pts[0].s;
  if (t >= pts[n - 1].t) return pts[n - 1].s;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (t < b.t) {
      let u = (t - a.t) / Math.max(1e-6, b.t - a.t);
      u = u * u * (3 - 2 * u);
      return Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * u);
    }
  }
  return pts[n - 1].s;
}

const RAMP_MIN = 0.1;
const RAMP_MAX = 4;
const RAMP_PAD = { l: 34, r: 8, t: 8, b: 8 };
const rp = { path: null, seq: null, pts: [], profile: null, drag: null, hover: null, ui: null, busy: false };

function rampDur() { return props['duration'] || 0; }

// Below this a high-fps clip starts repeating frames: 24 fps of real motion.
function smoothFloor() {
  const fps = props['container-fps'];
  return fps > 0 ? 24 / fps : null;
}

function rampGeom() {
  const cv = rp.ui.cv;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  const pw = w - RAMP_PAD.l - RAMP_PAD.r;
  const ph = h - RAMP_PAD.t - RAMP_PAD.b;
  const lmin = Math.log(RAMP_MIN);
  const lmax = Math.log(RAMP_MAX);
  const dur = rampDur() || 1;
  return {
    w, h,
    x: (t) => RAMP_PAD.l + (t / dur) * pw,
    y: (s) => RAMP_PAD.t + (1 - (Math.log(s) - lmin) / (lmax - lmin)) * ph,
    t: (x) => Math.max(0, Math.min(dur, ((x - RAMP_PAD.l) / pw) * dur)),
    s: (y) => {
      const v = Math.exp(lmin + (1 - (y - RAMP_PAD.t) / ph) * (lmax - lmin));
      return Math.max(RAMP_MIN, Math.min(RAMP_MAX, v));
    },
  };
}

function drawRamp() {
  const u = rp.ui;
  if (!u) return;
  const { ctx, w, h } = fitCanvas(u.cv);
  const g = rampGeom();
  const accent = cssVar('--accent');
  ctx.fillStyle = '#0b0b0e';
  ctx.fillRect(0, 0, w, h);
  ctx.font = '9px "Segoe UI", sans-serif';
  ctx.textAlign = 'right';

  // Where the clip moves most, if it has been looked at: something to aim at.
  const prof = rp.profile;
  if (prof && prof.path === props['path'] && prof.e.length > 1) {
    const max = Math.max(...prof.e) || 1;
    ctx.beginPath();
    ctx.moveTo(g.x(prof.t[0]), h - RAMP_PAD.b);
    prof.t.forEach((t, i) => ctx.lineTo(g.x(t), h - RAMP_PAD.b - (prof.e[i] / max) * (h * 0.4)));
    ctx.lineTo(g.x(prof.t[prof.t.length - 1]), h - RAMP_PAD.b);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    ctx.fill();
  }

  for (const s of [0.25, 0.5, 1, 2, 4]) {
    const y = Math.round(g.y(s)) + 0.5;
    ctx.fillStyle = s === 1 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.08)';
    ctx.fillRect(RAMP_PAD.l, y, w - RAMP_PAD.l - RAMP_PAD.r, 1);
    ctx.fillStyle = s === 1 ? '#a0a0aa' : '#5a5a64';
    ctx.fillText(s + '×', RAMP_PAD.l - 5, y + 3);
  }

  const floor = smoothFloor();
  if (floor && floor > RAMP_MIN && floor < 1) {
    const y = Math.round(g.y(floor)) + 0.5;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(RAMP_PAD.l, y);
    ctx.lineTo(w - RAMP_PAD.r, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = accent;
    ctx.fillText('24 fps', w - RAMP_PAD.r - 2, y - 3);
  }

  const pts = rp.pts;
  ctx.lineWidth = 2;
  ctx.strokeStyle = pts.length ? accent : '#3a3a44';
  ctx.beginPath();
  const steps = Math.max(2, Math.round(w - RAMP_PAD.l - RAMP_PAD.r));
  const dur = rampDur() || 1;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * dur;
    const x = g.x(t);
    const y = g.y(rampEval(pts, t));
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.stroke();
  ctx.lineWidth = 1;

  for (const p of pts) {
    const r = p === rp.drag || p === rp.hover ? 5.5 : 4;
    ctx.beginPath();
    ctx.arc(g.x(p.t), g.y(p.s), r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  if (!pts.length) {
    ctx.fillStyle = '#5a5a64';
    ctx.textAlign = 'center';
    ctx.fillText(rampDur() ? 'Click to add a point' : 'Open a video to draw a ramp', (w + RAMP_PAD.l) / 2, g.y(1) - 8);
  }

  if (rampDur()) {
    const x = Math.round(g.x(props['time-pos'] || 0)) + 0.5;
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.fillRect(x - 0.5, RAMP_PAD.t, 1, h - RAMP_PAD.t - RAMP_PAD.b);
  }

  // A dragged point says exactly where it is.
  if (rp.drag) {
    const p = rp.drag;
    const text = fmtTime(p.t) + '.' + String(Math.floor((p.t % 1) * 10)) + '   ' + p.s.toFixed(2) + '×';
    ctx.textAlign = g.x(p.t) > w / 2 ? 'right' : 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText(text, g.x(p.t) + (ctx.textAlign === 'right' ? -9 : 9), Math.max(16, g.y(p.s) - 9));
  }
}

function rampPointAt(x, y) {
  const g = rampGeom();
  let best = null;
  let bestD = 8;
  for (const p of rp.pts) {
    const d = Math.hypot(g.x(p.t) - x, g.y(p.s) - y);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// The range an export covers: Trim's In/Out when set, otherwise the curve
// with a second either side of it.
function rampRange() {
  const tr = trimRange();
  if (tr) return tr;
  if (!rp.pts.length) return null;
  const dur = rampDur();
  return {
    a: Math.max(0, rp.pts[0].t - 1),
    b: Math.min(dur || Infinity, rp.pts[rp.pts.length - 1].t + 1),
  };
}

let planTimer = null;
function rampChanged(persist) {
  rp.pts.sort((a, b) => a.t - b.t);
  const arr = rp.pts.map((p) => [Math.round(p.t * 1000) / 1000, Math.round(p.s * 1000) / 1000]);
  mi.scriptMessage('mi-ramp', JSON.stringify(arr));
  if (persist && rp.path) {
    const map = Object.assign({}, S.ramps);
    delete map[rp.path];
    if (arr.length) map[rp.path] = arr;
    // Newest last; the oldest files' curves go first once there are many.
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete map[k];
    saveState({ ramps: map });
  }
  drawRamp();
  clearTimeout(planTimer);
  planTimer = setTimeout(async () => {
    const range = rampRange();
    if (!range || !rp.pts.length) {
      rp.ui.readout.textContent = 'Click the graph to add a point, drag to shape it, double-click one to remove it.';
      return;
    }
    const plan = await mi.invoke('ramp-plan', { pts: arr, a: range.a, b: range.b });
    if (!plan) return;
    rp.ui.readout.textContent = `Exports ${fmtTime(range.a)}–${fmtTime(range.b)}`
      + `${trimRange() ? ' (Trim In/Out)' : ''} as ${plan.outSeconds.toFixed(1)} s at ${plan.fps} fps, no audio.`;
  }, 120);
}

// A dip: real time, easing down to the slow speed through the moment and back
// up. As slow as stays smooth on high-fps footage; a quarter otherwise.
function placeDip(center) {
  const dur = rampDur();
  if (!dur) return;
  const floor = smoothFloor();
  const slow = floor && floor < 0.5 ? Math.max(RAMP_MIN, floor) : 0.25;
  rp.pts = [[center - 0.9, 1], [center - 0.25, slow], [center + 0.25, slow], [center + 0.9, 1]]
    .filter(([t]) => t >= 0 && t <= dur)
    .map(([t, s]) => ({ t, s }));
  rampChanged(true);
}

function buildRampCard() {
  const c = card('Speed ramp', 'ramp', { open: false });
  const b = c.body;
  const cv = el('canvas', 'ramp');
  b.appendChild(cv);
  const readout = el('div', 'hint');

  let r = row(b);
  r.style.marginTop = '6px';
  label(r, 'Play the ramp').style.minWidth = '88px';
  const onTog = toggle(r, false, (on) => mi.scriptMessage('mi-ramp-on', on ? 'yes' : 'no'));
  onTog.title = 'Playback follows the curve';
  r.appendChild(el('span', 'grow'));
  btn(r, 'Clear', () => {
    rp.pts = [];
    rampChanged(true);
  }, { kinds: ['video'] });

  r = row(b);
  btn(r, 'Dip here', () => placeDip(props['time-pos'] || 0),
    { grow: true, kinds: ['video'], title: 'Ease down to slow motion around the playhead' });
  const snapBtn = btn(r, 'Snap to action', async () => {
    const dur = rampDur();
    if (!dur || rp.busy) return;
    const pos = props['time-pos'] || 0;
    // The whole of a short clip; around the playhead in a long one, because
    // every frame searched has to be decoded.
    const range = dur <= 40 ? { a: 0, b: dur } : { a: Math.max(0, pos - 15), b: Math.min(dur, pos + 15) };
    rp.busy = true;
    snapBtn.disabled = true;
    toast('Looking for the moment with the most movement…');
    try {
      const prof = await mi.invoke('motion-profile', range);
      if (prof && prof.peak != null) {
        rp.profile = prof;
        placeDip(prof.peak);
        mi.cmd('seek', Math.max(0, prof.peak - 1), 'absolute', 'exact');
        toast('Most movement at ' + fmtTime(prof.peak) + ' — dip placed there');
      }
    } finally {
      rp.busy = false;
      snapBtn.disabled = kind !== 'video';
    }
  }, { icon: 'sparkle', grow: true, kinds: ['video'], title: 'Find the peak of motion and put the slow part there' });

  r = row(b);
  btn(r, 'Export ramp', () => {
    const range = rampRange();
    if (!range) { toast('Draw a curve first'); return; }
    const arr = rp.pts.map((p) => [p.t, p.s]);
    mi.invoke('ramp-export', { pts: arr, a: range.a, b: range.b });
  }, { icon: 'scissors', cls: 'key grow', kinds: ['video'] });
  b.appendChild(readout);

  rp.ui = { cv, readout, onTog };

  const local = (e) => {
    const rect = cv.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !rampDur() || kind !== 'video') return;
    const [x, y] = local(e);
    let p = rampPointAt(x, y);
    if (!p) {
      const g = rampGeom();
      p = { t: g.t(x), s: g.s(y) };
      rp.pts.push(p);
    }
    rp.drag = p;
    cv.setPointerCapture(e.pointerId);
    rampChanged(false);
  });
  cv.addEventListener('pointermove', (e) => {
    const [x, y] = local(e);
    if (rp.drag) {
      const g = rampGeom();
      rp.drag.t = g.t(x);
      let s = g.s(y);
      // 1x is where most ramps start and end; make it easy to land on.
      if (Math.abs(Math.log(s)) < 0.05) s = 1;
      rp.drag.s = s;
      rampChanged(false);
      return;
    }
    const over = rampPointAt(x, y);
    if (over !== rp.hover) {
      rp.hover = over;
      drawRamp();
    }
    cv.style.cursor = over ? 'grab' : 'crosshair';
  });
  const release = (e) => {
    if (!rp.drag) return;
    rp.drag = null;
    try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
    rampChanged(true);
  };
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', release);
  const removeAt = (e) => {
    const [x, y] = local(e);
    const p = rampPointAt(x, y);
    if (!p) return;
    e.preventDefault();
    rp.pts = rp.pts.filter((q) => q !== p);
    rp.hover = null;
    rampChanged(true);
  };
  cv.addEventListener('dblclick', removeAt);
  cv.addEventListener('contextmenu', removeAt);
  new ResizeObserver(() => drawRamp()).observe(cv);

  onStatusUpdate((p) => {
    // A new file: its own curve, if it has one. Sent on the load counter
    // rather than the path because the player clears its copy while the file
    // is loading, and a curve sent before that would be wiped.
    const seq = p['user-data/mi/loaded_seq'];
    if (seq !== rp.seq) {
      rp.seq = seq;
      if (p['path'] !== rp.path) {
        rp.path = p['path'] || null;
        rp.profile = null;
      }
      rp.pts = ((S.ramps || {})[rp.path] || []).map(([t, s]) => ({ t, s }));
      rampChanged(false);
    }
    onTog.checked = p['user-data/mi/ramp_on'] === true;
    onTog.disabled = !rp.pts.length || kind !== 'video';
    drawRamp();
  });
  badge(c, (p) => (p['user-data/mi/ramp_on'] ? 'playing' : rp.pts.length ? rp.pts.length + ' pts' : ''));
}

// ---------------------------------------------------------------- Motion trail

function buildMotionCard() {
  const c = card('Motion trail', 'motion', { open: false });
  const b = c.body;
  let r = row(b);
  const modeSeg = segmented(r, [
    { label: 'Off', value: 'off' },
    { label: 'Bright', value: 'bright', title: 'Light subjects leave a trail' },
    { label: 'Dark', value: 'dark', title: 'Dark subjects leave a trail' },
    { label: 'X-ray', value: 'xray', title: 'Only what moves is lit' },
  ], (v) => mi.setting('trail', v), { grow: true, kinds: ['video'] });
  valueSlider(b, 'Length', 0, 100, S.trailLength, (v, done) => {
    mi.setting('trail_length', v);
    if (done) saveState({ trailLength: v });
  });
  hint(b, 'Live on the picture. (t) cycles it. X-ray shows the difference between frames, so anything still goes black.');

  section(b, 'Time-slice still');
  valueSlider(b, 'Copies', 3, 16, S.tsCopies, (v, done) => { if (done) saveState({ tsCopies: v }); });
  valueSlider(b, 'Threshold', 8, 80, S.tsThreshold, (v, done) => { if (done) saveState({ tsThreshold: v }); });
  r = row(b);
  label(r, 'Fade the early copies').style.minWidth = '130px';
  toggle(r, S.tsFade, (on) => saveState({ tsFade: on }));
  r = row(b);
  const renderBtn = btn(r, 'Render still', async () => {
    const dur = props['duration'] || 0;
    const pos = props['time-pos'] || 0;
    const range = trimRange() || { a: pos, b: Math.min(dur, pos + 3) };
    if (!(range.b > range.a)) { toast('Nothing to render: move back from the end'); return; }
    renderBtn.disabled = true;
    try {
      await mi.invoke('timeslice', {
        a: range.a, b: range.b,
        copies: S.tsCopies, threshold: S.tsThreshold, fade: S.tsFade,
      });
    } finally {
      renderBtn.disabled = kind !== 'video';
    }
  }, { icon: 'camera', cls: 'key grow', kinds: ['video'], title: 'Write a chronophotograph to Exports/' });
  hint(b, 'The subject at evenly spaced moments over one clean background, from the Trim card\'s In/Out or the 3 s from the playhead. Needs a still camera.');

  onStatusUpdate((p) => modeSeg.set(p['user-data/mi/set_trail'] || 'off'));
  badge(c, (p) => {
    if (!p['user-data/mi/trail_live']) return '';
    return { bright: 'trail', dark: 'dark trail', xray: 'x-ray' }[p['user-data/mi/set_trail']] || '';
  });
}
