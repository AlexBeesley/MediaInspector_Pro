'use strict';
// Audio X-ray: a whole-file spectrogram and a verdict on whether a "lossless"
// file really is.
//
// A lossy encoder throws away what it cannot afford to keep, and the first
// thing to go is the top of the spectrum: LAME at 128 kbps low-passes at about
// 16 kHz, and the cut is a brick wall - forty decibels gone in a few hundred
// hertz. Decoding that MP3 and saving it as FLAC keeps the wall. Real
// recordings roll off gradually, if at all, so a cliff inside a lossless
// container is the fingerprint of an upconvert.
//
// The audio is decoded by mpv itself (encode mode, to a temporary mono WAV),
// because mpv is the one dependency this app already has: no ffmpeg.exe
// required. The analysis is plain JS over that file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FFT_N = 4096;          // ~11 Hz bins at 44.1 kHz: fine enough to place a cutoff
const ROWS = 256;            // overview height, linear in frequency like the live view
const MAX_COLS = 1200;
const MAX_SECONDS = 1800;    // half an hour is ~170 MB of 48 kHz mono on disk

// ---------------------------------------------------------------- FFT

const fftCache = new Map();

function fftTables(n) {
  if (fftCache.has(n)) return fftCache.get(n);
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const hann = new Float64Array(n);
  for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const t = { rev, cos, sin, hann };
  fftCache.set(n, t);
  return t;
}

// Power spectrum of one Hann-windowed frame, bins 0..n/2-1, normalised so a
// full-scale sine reads 0 dB.
function powerSpectrum(samples, out) {
  const n = samples.length;
  const { rev, cos, sin, hann } = fftTables(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[rev[i]] = samples[i] * hann[i];
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let j = 0; j < half; j++) {
        const wr = cos[j * step];
        const wi = sin[j * step];
        const a = start + j;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  const ref = (n / 4) * (n / 4);
  for (let k = 0; k < n / 2; k++) out[k] = (re[k] * re[k] + im[k] * im[k]) / ref;
  return out;
}

const dB = (p) => 10 * Math.log10(p + 1e-20);

// ---------------------------------------------------------------- analysis

// readWindow(start, n) -> Float32Array of n samples in -1..1, starting at
// sample `start`. Kept abstract so the analysis can be tested on a buffer.
function analyse(readWindow, totalSamples, sampleRate) {
  const n = FFT_N;
  const half = n / 2;
  const usable = Math.max(0, totalSamples - n);
  const cols = totalSamples < n ? 0
    : Math.max(1, Math.min(MAX_COLS, Math.floor(usable / (n / 2)) + 1));

  const colDb = new Float32Array(cols * ROWS);
  const avg = new Float64Array(half);
  const p = new Float64Array(half);
  const per = half / ROWS;
  let peakDb = -200;

  for (let c = 0; c < cols; c++) {
    const start = cols > 1 ? Math.round((c * usable) / (cols - 1)) : 0;
    powerSpectrum(readWindow(start, n), p);
    for (let k = 0; k < half; k++) avg[k] += p[k];
    for (let r = 0; r < ROWS; r++) {
      let s = 0;
      for (let k = r * per; k < (r + 1) * per; k++) s += p[k];
      const v = dB(s / per);
      colDb[c * ROWS + r] = v;
      if (v > peakDb) peakDb = v;
    }
  }
  if (cols) for (let k = 0; k < half; k++) avg[k] /= cols;

  // The picture is scaled to the file's own loudest point, so a quiet
  // recording is still a picture rather than a black rectangle.
  const floor = peakDb - 100;
  const image = new Uint8Array(cols * ROWS);
  for (let i = 0; i < image.length; i++) {
    image[i] = Math.max(0, Math.min(255, Math.round(((colDb[i] - floor) / 100) * 255)));
  }

  const spectrumDb = new Float32Array(half);
  for (let k = 0; k < half; k++) spectrumDb[k] = dB(avg[k]);
  const cut = findCutoff(spectrumDb, sampleRate);

  // A curve small enough to send to the page and plot.
  const CURVE = 512;
  const curve = new Float32Array(CURVE);
  const cper = half / CURVE;
  for (let i = 0; i < CURVE; i++) {
    let s = 0;
    for (let k = i * cper; k < (i + 1) * cper; k++) s += avg[k];
    curve[i] = dB(s / cper);
  }

  return {
    sampleRate,
    seconds: totalSamples / sampleRate,
    cols,
    rows: ROWS,
    image,
    curve,
    ...cut,
  };
}

function meanOf(a, from, to) {
  from = Math.max(0, from);
  to = Math.min(a.length, to);
  if (to <= from) return NaN;
  let s = 0;
  for (let i = from; i < to; i++) s += a[i];
  return s / (to - from);
}

function median(arr) {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
}

// Where the content stops, and whether it stops like an encoder or like a
// recording. A cliff is a drop of 20 dB or more across 0.8 kHz that stays down
// all the way to the top of the band; anything gentler is a roll-off.
function findCutoff(spec, sampleRate) {
  const half = spec.length;
  const nyq = sampleRate / 2;
  const binHz = nyq / half;
  const bin = (hz) => Math.max(0, Math.min(half - 1, Math.round(hz / binHz)));

  // ~100 Hz smoothing, enough to iron out tonal peaks without blurring a wall.
  const w = Math.max(1, Math.round(100 / binHz));
  const sm = new Float32Array(half);
  for (let k = 0; k < half; k++) sm[k] = meanOf(spec, k - w, k + w + 1);

  const ref = median(sm.subarray(bin(1000), bin(Math.min(8000, nyq * 0.8))));
  const out = { refDb: ref, cutoffHz: 0, dropDb: 0, extentHz: 0, bandHz: 0, silent: false };
  if (!isFinite(ref) || ref < -110) {
    out.silent = true;
    return out;
  }

  // Where anything at all rises out of the noise floor at the top of the
  // band. An upsampled file is silent - dither and nothing else - above the
  // old Nyquist, however steep or gentle the resampler made the slope there.
  // Content that runs right up to Nyquist leaves no floor to measure against,
  // which is the opposite finding: the band is full.
  const floorDb = median(sm.subarray(bin(nyq * 0.9), bin(nyq * 0.98)));
  if (floorDb > ref - 40) {
    out.bandHz = nyq;
  } else {
    for (let k = bin(nyq * 0.9) - 1; k > 0; k--) {
      if (sm[k] > floorDb + 10) {
        out.bandHz = k * binHz;
        break;
      }
    }
  }

  // The highest frequency still carrying something within 60 dB of the body.
  for (let k = half - 1; k > 0; k--) {
    if (sm[k] > ref - 60) {
      out.extentHz = k * binHz;
      break;
    }
  }

  const a = Math.max(2, Math.round(400 / binHz));
  const lo = bin(Math.min(10000, nyq * 0.45));
  const hi = half - a - bin(150);
  let best = -1;
  let bestDrop = 0;
  for (let k = lo; k < hi; k++) {
    const d = meanOf(sm, k - a, k) - meanOf(sm, k + 1, k + 1 + a);
    if (d > bestDrop) {
      bestDrop = d;
      best = k;
    }
  }
  if (best < 0) return out;

  const below = meanOf(sm, best - 2 * a, best - a);
  const above = meanOf(sm, best + a, half - bin(150));
  if (bestDrop >= 20 && below - above >= 25) {
    // The wall itself: the first bin past the knee that has fallen 10 dB.
    let k = best - a;
    while (k < half - 1 && sm[k] > below - 10) k++;
    out.cutoffHz = k * binHz;
    out.dropDb = below - above;
  }
  return out;
}

// ---------------------------------------------------------------- verdict

const LOSSLESS = /^(flac|alac|pcm_|wavpack|ape|tta|truehd|mlp|shorten|tak|dsd_|s302m)/;

// What LAME's default low-pass leaves at each bitrate: close enough for
// AAC and Vorbis too, which make similar choices for the same reasons.
function bitrateGuess(hz) {
  if (hz < 11500) return '64 kbps or less';
  if (hz < 15000) return 'about 96 kbps';
  if (hz < 17200) return 'about 128 kbps';
  if (hz < 18000) return 'about 160 kbps';
  if (hz < 19300) return 'about 192 kbps';
  if (hz < 19900) return 'about 256 kbps';
  return 'about 320 kbps';
}

const kHz = (hz) => (hz / 1000).toFixed(1) + ' kHz';

function verdict(r, codec) {
  codec = String(codec || '').toLowerCase();
  const lossless = LOSSLESS.test(codec);
  const nyq = r.sampleRate / 2;
  const name = codec || 'audio';

  if (r.silent || !r.cols) {
    return { level: 'unknown', title: 'Too quiet to judge', detail: 'There is not enough signal to read a spectrum from.' };
  }
  const cliff = r.cutoffHz > 0 && r.cutoffHz < nyq * 0.93;

  // A 44.1 or 48 kHz master resampled up still ends a little past its old
  // Nyquist, where the resampler's slope runs out: 30 kHz clears that and
  // sits below what a real hi-res recording carries.
  if (lossless && r.sampleRate >= 88000 && r.bandHz > 0 && r.bandHz < 30000) {
    return {
      level: 'suspect',
      title: 'Hi-res container, CD-band content',
      detail: `Sampled at ${kHz(r.sampleRate)}, but nothing rises out of the noise above ${kHz(r.bandHz)}: `
        + 'most likely upsampled from 44.1 or 48 kHz.',
    };
  }
  if (lossless && cliff && r.cutoffHz < 20500) {
    return {
      level: 'suspect',
      title: 'Probably upconverted from lossy',
      detail: `${name.toUpperCase()} with a brick-wall cutoff at ${kHz(r.cutoffHz)} (${Math.round(r.dropDb)} dB down): `
        + `the mark a lossy encoder at ${bitrateGuess(r.cutoffHz)} leaves. Real recordings roll off gradually.`,
    };
  }
  if (lossless) {
    return {
      level: 'genuine',
      title: 'Looks genuinely lossless',
      detail: `Content reaches ${kHz(r.extentHz || nyq)} with no encoder cutoff.`,
    };
  }
  if (cliff) {
    return {
      level: 'lossy',
      title: `Lossy ${name}, cut at ${kHz(r.cutoffHz)}`,
      detail: `Bandwidth typical of ${bitrateGuess(r.cutoffHz)}.`,
    };
  }
  return {
    level: 'lossy',
    title: `Lossy ${name}, full bandwidth`,
    detail: `No low-pass below ${kHz(nyq)}: a high-bitrate or modern encoder.`,
  };
}

// ---------------------------------------------------------------- WAV

function readWavInfo(fd, size) {
  const head = Buffer.alloc(Math.min(size, 65536));
  fs.readSync(fd, head, 0, head.length, 0);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let off = 12;
  let fmt = null;
  while (off + 8 <= head.length) {
    const id = head.toString('ascii', off, off + 4);
    const len = head.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        channels: head.readUInt16LE(off + 10),
        sampleRate: head.readUInt32LE(off + 12),
        bits: head.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      // A header written before the encoder knew the length carries 0 or
      // 0xFFFFFFFF here; the file's own size is the truth either way.
      const avail = size - (off + 8);
      const bytes = len > 0 && len <= avail ? len : avail;
      return Object.assign({ dataOffset: off + 8, dataBytes: bytes }, fmt);
    }
    off += 8 + len + (len & 1);
  }
  throw new Error('WAV has no data chunk');
}

function analyseWav(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const info = readWavInfo(fd, size);
    if (info.bits !== 16 || info.channels !== 1) throw new Error('expected 16-bit mono');
    const total = Math.floor(info.dataBytes / 2);
    const raw = Buffer.alloc(FFT_N * 2);
    const win = new Float32Array(FFT_N);
    const read = (start, n) => {
      const got = fs.readSync(fd, raw, 0, n * 2, info.dataOffset + start * 2);
      for (let i = 0; i < n; i++) win[i] = i * 2 + 1 < got ? raw.readInt16LE(i * 2) / 32768 : 0;
      return win;
    };
    return analyse(read, total, info.sampleRate);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------- runner

// One analysis at a time: opening the next file cancels the last one rather
// than letting two decodes race to report.
class XRay {
  constructor(findMpv) {
    this.findMpv = findMpv;
    this.job = null;
  }

  cancel() {
    const j = this.job;
    this.job = null;
    if (!j) return;
    j.cancelled = true;
    try { j.proc.kill(); } catch (e) { /* already gone */ }
    cleanup(j.tmp);
  }

  // Resolves with the analysis, or null when cancelled by a newer request.
  run(src, codec) {
    this.cancel();
    const mpv = this.findMpv();
    if (!mpv) return Promise.reject(new Error('mpv.exe not found'));

    const tmp = path.join(os.tmpdir(), `mi-xray-${process.pid}-${Date.now()}.wav`);
    // aformat forces the downmix; mpv picks the encoder's sample rate from the
    // source, so the spectrum keeps every hertz the file actually has.
    const args = [
      '--no-config', '--really-quiet', '--no-video',
      '--length=' + MAX_SECONDS,
      '--af=lavfi=[aformat=channel_layouts=mono]',
      '--oac=pcm_s16le', '--of=wav', '-o=' + tmp, src,
    ];
    const proc = spawn(mpv, args, { windowsHide: true, stdio: 'ignore' });
    const job = { proc, tmp, cancelled: false };
    this.job = job;

    return new Promise((resolve, reject) => {
      proc.on('error', (e) => { cleanup(tmp); reject(e); });
      proc.on('exit', () => {
        if (job.cancelled) { resolve(null); return; }
        this.job = null;
        try {
          const r = analyseWav(tmp);
          r.verdict = verdict(r, codec);
          r.truncated = r.seconds >= MAX_SECONDS - 1;
          resolve(r);
        } catch (e) {
          reject(e);
        } finally {
          cleanup(tmp);
        }
      });
    });
  }
}

function cleanup(file) {
  try { fs.unlinkSync(file); } catch (e) { /* never written, or already gone */ }
}

module.exports = { XRay, analyse, analyseWav, verdict, findCutoff, powerSpectrum, FFT_N };
