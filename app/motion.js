'use strict';
// Motion: where a clip moves most, and the time-slice still.
//
// Both read raw frames that mpv decodes for us (encode mode, rawvideo), so
// like the rest of the app they need nothing but mpv.
//
//   profile()   - mean frame-to-frame difference over a small grey copy of
//                 the clip. Its peak is "the moment", which is where Snap to
//                 action puts the slow part of a speed ramp.
//   timeslice() - a chronophotograph: a clean background plate (the per-pixel
//                 median over the range, which the moving subject never wins)
//                 with the subject cut out of N evenly spaced frames and laid
//                 over it in order. Tripod footage; a moving camera has no
//                 single background to find.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const num = (v) => String(Math.round(v * 1e6) / 1e6);

// The frame size mpv will write. Rotation is applied after the filters in
// encode mode, so a quarter turn swaps the scaled size rather than the source.
function frameSize(src, maxSide, rotate) {
  const s = Math.min(1, maxSide / Math.max(src.w, src.h));
  const w = even(src.w * s);
  const h = even(src.h * s);
  const turned = ((((rotate || 0) % 180) + 180) % 180) === 90;
  return { scaleW: w, scaleH: h, w: turned ? h : w, h: turned ? w : h };
}

function decodeRaw(mpv, file, o) {
  const tmp = path.join(os.tmpdir(), `mi-motion-${process.pid}-${Date.now()}.raw`);
  const vf = [];
  if (o.crop) vf.push('crop=' + o.crop);
  vf.push('fps=fps=' + num(o.fps));
  vf.push(`scale=w=${o.size.scaleW}:h=${o.size.scaleH}:flags=area`);
  vf.push('format=' + o.pix);
  // Every frame of the range is decoded even when the fps filter keeps few of
  // them, so decoding is the cost: hardware decode with copy-back where there
  // is one, and for the throwaway grey copy the analysis reads, the decoder's
  // fast path too.
  const args = [
    '--no-config', '--really-quiet', '--no-audio', '--no-sub', '--hwdec=auto-copy',
    ...(o.fast ? ['--vd-lavc-fast', '--vd-lavc-skiploopfilter=all'] : []),
    '--start=' + num(o.start), '--end=' + num(o.end),
    '--vf=lavfi=[' + vf.join(',') + ']',
    '--ovc=rawvideo', '--of=rawvideo', '-o=' + tmp, file,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(mpv, args, { windowsHide: true, stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('exit', () => {
      const bpp = o.pix === 'gray' ? 1 : 3;
      const frameBytes = o.size.w * o.size.h * bpp;
      let size = 0;
      try { size = fs.statSync(tmp).size; } catch (e) { /* nothing written */ }
      const count = Math.floor(size / frameBytes);
      if (!count) {
        remove(tmp);
        reject(new Error('mpv decoded no frames from that range'));
        return;
      }
      resolve({ file: tmp, w: o.size.w, h: o.size.h, bpp, frameBytes, count });
    });
  });
}

function readFrame(fd, raw, i) {
  const buf = Buffer.alloc(raw.frameBytes);
  fs.readSync(fd, buf, 0, raw.frameBytes, i * raw.frameBytes);
  return buf;
}

function remove(file) {
  try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
}

// ---------------------------------------------------------------- profile

// opts: { start, end, fps, src: {w, h}, rotate, crop }
async function profile(mpv, file, opts) {
  const fps = Math.min(30, opts.fps || 30);
  const size = frameSize(opts.src, 160, opts.rotate);
  const raw = await decodeRaw(mpv, file, { ...opts, fps, size, pix: 'gray', fast: true });
  const fd = fs.openSync(raw.file, 'r');
  try {
    const t = new Float32Array(raw.count);
    const e = new Float32Array(raw.count);
    let prev = null;
    for (let i = 0; i < raw.count; i++) {
      const f = readFrame(fd, raw, i);
      t[i] = opts.start + i / fps;
      if (prev) {
        let s = 0;
        for (let p = 0; p < f.length; p++) s += Math.abs(f[p] - prev[p]);
        e[i] = s / f.length;
      }
      prev = f;
    }
    if (raw.count > 1) e[0] = e[1];
    return { t, e, peak: peakTime(t, e) };
  } finally {
    fs.closeSync(fd);
    remove(raw.file);
  }
}

// The peak of a lightly smoothed curve: one jittery frame is not "the moment".
function peakTime(t, e) {
  const n = e.length;
  if (!n) return null;
  const r = Math.max(1, Math.round(n / 60));
  let best = 0;
  let bestV = -1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) { s += e[j]; c++; }
    if (s / c > bestV) { bestV = s / c; best = i; }
  }
  return t[best];
}

// ---------------------------------------------------------------- timeslice

// Per-byte median of a handful of frames. Insertion sort, because K is at
// most a dozen and this runs a few million times.
function medianPlate(frames) {
  const k = frames.length;
  const len = frames[0].length;
  const out = Buffer.alloc(len);
  const v = new Uint8Array(k);
  const mid = k >> 1;
  for (let p = 0; p < len; p++) {
    for (let i = 0; i < k; i++) {
      const x = frames[i][p];
      let j = i - 1;
      while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
      v[j + 1] = x;
    }
    out[p] = v[mid];
  }
  return out;
}

// Separable box blur on a one-channel float mask, in place.
function blurMask(m, w, h, r) {
  if (r < 1) return m;
  const tmp = new Float32Array(m.length);
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += m[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / d;
      s += m[row + Math.min(w - 1, x + r + 1)] - m[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      m[y * w + x] = s / d;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return m;
}

// plate and copies are RGB24 buffers of one size; returns RGB24. threshold is
// the difference (0..255) at which a pixel counts as subject; the mask ramps
// in around it and is softened so cut-outs do not have hard, noisy edges.
function composite(plate, copies, w, h, opts = {}) {
  const thr = opts.threshold || 28;
  const lo = thr * 0.6;
  const hi = thr * 1.4;
  const fade = opts.fade !== false;
  const out = new Float32Array(plate.length);
  for (let p = 0; p < plate.length; p++) out[p] = plate[p];
  const mask = new Float32Array(w * h);
  const n = copies.length;

  copies.forEach((f, i) => {
    for (let q = 0, p = 0; q < mask.length; q++, p += 3) {
      const d = Math.max(Math.abs(f[p] - plate[p]), Math.abs(f[p + 1] - plate[p + 1]),
        Math.abs(f[p + 2] - plate[p + 2]));
      const u = Math.max(0, Math.min(1, (d - lo) / (hi - lo)));
      mask[q] = u * u * (3 - 2 * u);
    }
    blurMask(mask, w, h, Math.max(1, Math.round(Math.max(w, h) / 900)));
    // Earlier copies are ghosts; the last one, where the subject ends up, is solid.
    const o = fade && n > 1 ? 0.35 + 0.65 * (i / (n - 1)) : 1;
    for (let q = 0, p = 0; q < mask.length; q++, p += 3) {
      const a = mask[q] * o;
      if (a <= 0) continue;
      out[p] += (f[p] - out[p]) * a;
      out[p + 1] += (f[p + 1] - out[p + 1]) * a;
      out[p + 2] += (f[p + 2] - out[p + 2]) * a;
    }
  });

  const rgb = Buffer.alloc(plate.length);
  for (let p = 0; p < plate.length; p++) rgb[p] = Math.round(out[p]);
  return rgb;
}

function rgbToBgra(rgb, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let q = 0, p = 0, o = 0; q < w * h; q++, p += 3, o += 4) {
    out[o] = rgb[p + 2];
    out[o + 1] = rgb[p + 1];
    out[o + 2] = rgb[p];
    out[o + 3] = 255;
  }
  return out;
}

const pick = (count, k) => Array.from({ length: k }, (_, i) =>
  Math.round(k > 1 ? (i * (count - 1)) / (k - 1) : (count - 1) / 2));

// opts: { start, end, fps, src: {w, h}, rotate, crop, copies, threshold,
//         fade, maxSide }. Resolves with { rgb, w, h, copies }.
async function timeslice(mpv, file, opts) {
  const copies = Math.max(2, Math.min(24, Math.round(opts.copies || 8)));
  const span = Math.max(0.05, opts.end - opts.start);
  // Enough frames for the copies and an 11-frame plate, but never more than
  // the source actually has.
  const want = Math.max(copies, 11) * 2;
  const fps = Math.min(opts.fps || 60, Math.max(1, want / span));
  const size = frameSize(opts.src, opts.maxSide || 1920, opts.rotate);
  const raw = await decodeRaw(mpv, file, { ...opts, fps, size, pix: 'rgb24' });
  const fd = fs.openSync(raw.file, 'r');
  try {
    const plateIdx = pick(raw.count, Math.min(11, raw.count));
    const plate = medianPlate(plateIdx.map((i) => readFrame(fd, raw, i)));
    const copyIdx = [...new Set(pick(raw.count, Math.min(copies, raw.count)))];
    const frames = copyIdx.map((i) => readFrame(fd, raw, i));
    const rgb = composite(plate, frames, raw.w, raw.h, opts);
    return { rgb, w: raw.w, h: raw.h, copies: frames.length };
  } finally {
    fs.closeSync(fd);
    remove(raw.file);
  }
}

module.exports = { profile, timeslice, composite, medianPlate, peakTime, frameSize, rgbToBgra };
