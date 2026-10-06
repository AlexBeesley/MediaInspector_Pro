'use strict';
// Thumbnails: made once, kept on disk, served to the page over thumb://.
//
// The page never asks for a thumbnail explicitly; it sets <img src="thumb://...">
// on the cells it can see, and Chromium decodes the answer off the page's
// thread. The URL carries the file's path, size and date, so a cache entry is
// keyed by content version: an edited photo gets a new thumbnail, and an
// unchanged one is a single file read.
//
// Making one tries, in order of cost:
//   1. the OS thumbnailer (Windows shell / macOS QuickLook) - instant when
//      Explorer already has it cached, and it knows HEIC, RAW and video codecs
//      the user has installed;
//   2. Chromium's own decoders, in worker threads of a hidden window, for the
//      formats a browser reads (JPEG, PNG, WebP, GIF, AVIF, BMP);
//   3. ffmpeg, or mpv, for video frames, cover art and everything else.
//
// Work is a stack, not a queue: the cells asked for last are the ones on
// screen now, so they go first, and a fast scroll past a thousand files does
// not make the screen you stopped on wait for them.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { KIND, extOf, BROWSER_DECODES } = require('../lib/media');

const MAX_JOBS = Math.max(3, Math.min(8, os.cpus().length));
const MAX_PROCS = Math.max(2, Math.min(4, os.cpus().length >> 1));
const MAX_BACKGROUND = 2;

function which(names, extra = []) {
  const dirs = [...extra, ...(process.env.PATH || '').split(path.delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const n of names) {
      try {
        const c = path.join(dir.trim(), n);
        if (fs.existsSync(c)) return c;
      } catch (e) { /* unreadable PATH entry */ }
    }
  }
  return null;
}

class ThumbService {
  constructor(opts) {
    this.dir = opts.dir;
    this.renderers = opts.renderers;      // { available(), call(kind, args) }
    this.shellInMain = opts.shellInMain;  // fallback when the hidden window cannot
    const win = process.platform === 'win32';
    this.ffmpeg = which(win ? ['ffmpeg.exe'] : ['ffmpeg'], opts.toolDirs || []);
    this.mpv = which(win ? ['mpv.exe', 'mpv.com'] : ['mpv'], [...(opts.toolDirs || []), win ? 'C:\\Program Files\\MPV Player' : '/usr/bin']);
    this.useShell = win || process.platform === 'darwin';
    this.stack = [];          // interactive, newest last
    this.background = [];     // pre-builds, oldest first
    this.inflight = new Map();
    this.running = 0;
    this.runningBg = 0;
    this.procs = 0;
    this.procWait = [];
    this.made = 0;
    this.hits = 0;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  static parse(url) {
    const u = new URL(url);
    const q = u.searchParams;
    return {
      path: q.get('p'),
      size: +q.get('s') || 0,
      mtime: +q.get('m') || 0,
      kind: +q.get('k') || 0,
      w: Math.min(1024, Math.max(64, +q.get('w') || 256)),
      cloud: q.get('c') === '1',
    };
  }

  keyOf(job) {
    return crypto.createHash('sha1').update(`${job.path}|${job.size}|${Math.round(job.mtime)}|${job.w}`).digest('hex');
  }

  fileOf(key) {
    return path.join(this.dir, key.slice(0, 2), key);
  }

  // protocol.handle('thumb', ...) lands here.
  async handle(request) {
    let job;
    try {
      job = ThumbService.parse(request.url);
    } catch (e) {
      return new Response(null, { status: 400 });
    }
    if (!job.path) return new Response(null, { status: 400 });
    const buf = await this.get(job, false);
    if (!buf || !buf.length) return new Response(null, { status: 404 });
    return new Response(buf, {
      headers: {
        'Content-Type': sniff(buf),
        // Keyed by size and date: a URL's answer never changes.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  }

  async get(job, background) {
    const key = this.keyOf(job);
    const file = this.fileOf(key);
    try {
      const buf = await fsp.readFile(file);
      this.hits++;
      return buf; // zero bytes: tried before, nothing to show
    } catch (e) { /* not cached */ }
    let p = this.inflight.get(key);
    if (p) {
      if (!background) this.promote(key);
      return p;
    }
    p = new Promise((resolve) => {
      const item = { job, key, file, resolve };
      if (background) this.background.push(item); else this.stack.push(item);
    });
    this.inflight.set(key, p);
    this.pump();
    return p;
  }

  // Something the page now needs was queued as a pre-build: move it up.
  promote(key) {
    const i = this.background.findIndex((x) => x.key === key);
    if (i >= 0) this.stack.push(this.background.splice(i, 1)[0]);
  }

  pump() {
    while (this.running < MAX_JOBS && this.stack.length) this.start(this.stack.pop(), false);
    // Pre-builds only run when nothing on screen is waiting.
    while (!this.stack.length && this.runningBg < MAX_BACKGROUND && this.running < MAX_JOBS && this.background.length) {
      this.start(this.background.shift(), true);
    }
  }

  async start(item, bg) {
    this.running++;
    if (bg) this.runningBg++;
    let buf = null;
    try {
      buf = await this.make(item.job);
    } catch (e) {
      buf = null;
    }
    this.running--;
    if (bg) this.runningBg--;
    this.inflight.delete(item.key);
    item.resolve(buf);
    this.made++;
    // A zero-byte file remembers a failure, so a file no tool can read is not
    // retried every time it scrolls past. Its key changes if the file does.
    fsp.mkdir(path.dirname(item.file), { recursive: true })
      .then(() => fsp.writeFile(item.file, buf || Buffer.alloc(0)))
      .catch(() => {});
    this.pump();
  }

  async make(job) {
    const ext = extOf(job.path);
    if (this.useShell) {
      const b = await this.viaShell(job);
      if (b) return b;
      // A cloud placeholder is only ever shown by the OS: reading it ourselves
      // would download the whole file.
      if (job.cloud) return null;
    }
    if (job.kind === KIND.PHOTO && BROWSER_DECODES.has(ext)) {
      const b = await this.viaDecode(job, ext);
      if (b) return b;
    }
    if (job.kind === KIND.OTHER) return null;
    return this.viaProcess(job);
  }

  async viaShell(job) {
    try {
      if (this.renderers.canShell()) return await this.renderers.call('shell', { path: job.path, w: job.w });
      if (this.shellInMain) return await this.shellInMain(job.path, job.w);
    } catch (e) { /* no handler for this type */ }
    return null;
  }

  async viaDecode(job, ext) {
    try {
      const alpha = ext === 'png' || ext === 'gif' || ext === 'webp' || ext === 'ico' || ext === 'cur' || ext === 'avif';
      return await this.renderers.call('decode', { path: job.path, w: job.w, type: alpha ? 'image/webp' : 'image/jpeg' });
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------ processes

  async viaProcess(job) {
    if (!this.ffmpeg && !this.mpv) return null;
    await this.procSlot();
    try {
      if (this.ffmpeg) {
        const seek = job.kind === KIND.VIDEO;
        let b = await this.ffmpegFrame(job, seek ? 3 : -1);
        // Shorter than the seek: take the first frame instead.
        if (!b && seek) b = await this.ffmpegFrame(job, -1);
        if (b) return b;
      }
      if (this.mpv) return await this.mpvFrame(job);
      return null;
    } finally {
      this.procs--;
      const next = this.procWait.shift();
      if (next) next();
    }
  }

  procSlot() {
    if (this.procs < MAX_PROCS) { this.procs++; return Promise.resolve(); }
    return new Promise((resolve) => this.procWait.push(() => { this.procs++; resolve(); }));
  }

  ffmpegFrame(job, seek) {
    const w = job.w;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2'];
    if (seek > 0) args.push('-ss', String(seek));
    args.push('-i', job.path);
    // Audio: the attached picture is the first video stream, if there is one.
    if (job.kind === KIND.AUDIO) args.push('-map', '0:v:0');
    args.push(
      '-frames:v', '1', '-an', '-sn', '-dn',
      '-vf', `scale=${w}:${w}:force_original_aspect_ratio=decrease:flags=bicubic,format=yuvj420p`,
      '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', '-',
    );
    return run(this.ffmpeg, args, 20000);
  }

  async mpvFrame(job) {
    const w = job.w;
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'mx-thumb-'));
    const args = [
      '--no-config', '--msg-level=all=no', '--no-audio', '--sub=no', '--load-scripts=no',
      '--ytdl=no', '--hr-seek=no', '--frames=1', '--vo=image', '--vo-image-format=jpg',
      '--vo-image-jpeg-quality=82', '--vo-image-outdir=' + out,
      `--vf=lavfi=[scale=${w}:${w}:force_original_aspect_ratio=decrease]`,
    ];
    if (job.kind === KIND.VIDEO) args.push('--start=10%');
    args.push('--', job.path);
    try {
      await run(this.mpv, args, 20000, true);
      const files = await fsp.readdir(out);
      if (!files.length) return null;
      return await fsp.readFile(path.join(out, files[0]));
    } catch (e) {
      return null;
    } finally {
      fsp.rm(out, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ------------------------------------------------------------ pre-builds

  // The whole of the folder being looked at, in the background, so scrolling
  // down it finds everything ready. A new folder replaces the old list.
  prewarm(items, w, replace = true) {
    if (replace) {
      for (const it of this.background) { this.inflight.delete(it.key); it.resolve(null); }
      this.background = [];
    }
    let queued = 0;
    for (const it of items) {
      if (!it.path || it.kind === KIND.OTHER) continue;
      const job = { path: it.path, size: it.size, mtime: it.mtime, kind: it.kind, w, cloud: !!it.cloud };
      const key = this.keyOf(job);
      if (this.inflight.has(key)) continue;
      const file = this.fileOf(key);
      // existsSync is a single stat; doing it here keeps already-cached files
      // out of the queue entirely, which is most of them on a revisit.
      if (fs.existsSync(file)) continue;
      const p = new Promise((resolve) => this.background.push({ job, key, file, resolve }));
      this.inflight.set(key, p);
      queued++;
    }
    this.pump();
    return queued;
  }

  stats() {
    return {
      queued: this.stack.length,
      background: this.background.length,
      running: this.running,
      made: this.made,
      hits: this.hits,
      ffmpeg: this.ffmpeg,
      mpv: this.mpv,
    };
  }

  async diskUsage() {
    let bytes = 0;
    let files = 0;
    let shards = [];
    try { shards = await fsp.readdir(this.dir); } catch (e) { return { bytes, files }; }
    for (const s of shards) {
      let names = [];
      try { names = await fsp.readdir(path.join(this.dir, s)); } catch (e) { continue; }
      for (const n of names) {
        try { bytes += (await fsp.stat(path.join(this.dir, s, n))).size; files++; } catch (e) { /* raced */ }
      }
    }
    return { bytes, files };
  }

  async clear() {
    await fsp.rm(this.dir, { recursive: true, force: true });
    await fsp.mkdir(this.dir, { recursive: true });
  }
}

function sniff(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp';
  return 'application/octet-stream';
}

// Run a tool and collect stdout; null on failure, timeout or empty output.
function run(cmd, args, timeoutMs, ignoreOutput) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', ignoreOutput ? 'ignore' : 'pipe', 'ignore'] });
    } catch (e) {
      resolve(null);
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => { try { p.kill(); } catch (e) { /* gone */ } }, timeoutMs);
    if (p.stdout) p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (ignoreOutput) { resolve(code === 0 ? Buffer.alloc(1) : null); return; }
      const b = Buffer.concat(chunks);
      resolve(code === 0 && b.length ? b : null);
    });
  });
}

module.exports = { ThumbService };
