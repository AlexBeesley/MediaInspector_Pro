'use strict';
// The indexer: owns the store, the scanning threads, the folder watchers and the
// file on disk, and answers the renderer's questions.
//
// It runs in its own process (see indexer/main.js), so a crawl of a whole drive
// or a search over millions of names never touches the window's thread or the
// Electron main process. Scanning itself is spread over worker threads; this
// thread only merges what they find, which is cheap.
//
// Browsing is stale-while-revalidate: a folder that has been seen before is
// answered from memory at once, and re-read in the background; if anything
// changed the renderer is told and asks again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { Store, F_DIR, F_ALIVE, F_SCANNED, F_DEEP, F_LINK, F_HIDDEN } = require('./store');
const { KIND } = require('../lib/media');

const ROWS_UP_FRONT = 400;    // rows sent with a listing, before any are asked for
const BATCH = 16;             // folders per message to a crawling thread
const SAVE_EVERY_MS = 120000; // during a long crawl, so a crash loses little
const REVISIT_MS = 1500;      // a folder re-read more often than this is not re-read

class Deque {
  constructor() { this.a = []; this.h = 0; }
  get length() { return this.a.length - this.h; }
  push(x) { this.a.push(x); }
  shift() {
    const x = this.a[this.h++];
    if (this.h > 4096 && this.h * 2 > this.a.length) { this.a = this.a.slice(this.h); this.h = 0; }
    return x;
  }
  clear() { this.a = []; this.h = 0; }
}

class Indexer {
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.file = path.join(this.dataDir, 'index.bin');
    this.emit = opts.emit || (() => {});
    this.threads = Math.max(1, opts.threads || Math.min(4, Math.max(2, os.cpus().length - 1)));
    this.watch = opts.watch !== undefined ? opts.watch : (process.platform === 'win32' || process.platform === 'darwin');
    // A folder's date only reliably moves with its contents on the platforms'
    // own filesystems; on Windows a full re-read is cheap enough anyway.
    this.skipUnchanged = opts.skipUnchanged !== undefined ? opts.skipUnchanged : process.platform !== 'win32';
    this.store = null;
    this.roots = [];          // [{path, added, lastScan, ms, files, dirs, media, status}]
    this.hi = new Deque();    // folders someone is looking at
    this.lo = new Deque();    // crawl
    this.workers = [];
    this.batches = new Map();
    this.batchSeq = 0;
    this.waiters = new Map(); // dir -> [resolve] for reads someone is awaiting
    this.queuedHi = new Set();
    this.crawls = new Map();  // root path -> {pending, done, start, revalidate}
    this.lastRead = new Map();
    this.watchers = new Map();
    this.watchDirty = new Set();
    this.watchTimer = null;
    this.changedDirs = new Set();
    this.changedTimer = null;
    this.progressTimer = null;
    this.savedVersion = 0;
    this.saveTimer = null;
    this.lastSave = Date.now();
    this.onlineCache = new Map();
  }

  // ------------------------------------------------------------ lifecycle

  init() {
    const t0 = Date.now();
    const { store, meta, error } = Store.load(this.file);
    this.store = store;
    this.savedVersion = store.version;
    this.roots = (meta && meta.roots) || [];
    for (const r of this.roots) r.status = 'idle';
    for (let i = 0; i < this.threads + 1; i++) this.spawnWorker(i === 0);
    const loadMs = Date.now() - t0;
    // Revalidate the indexed locations once the window has had its first
    // paint: the cached index is already answering, this only freshens it.
    setTimeout(() => {
      for (const r of this.roots) this.startCrawl(r.path, true);
      for (const r of this.roots) this.startWatch(r.path);
    }, 1200);
    return { loadMs, entries: store.live, error };
  }

  spawnWorker(hiOnly) {
    const w = new Worker(path.join(__dirname, 'scan-worker.js'));
    const slot = { w, busy: false, hiOnly };
    w.on('message', (msg) => this.onBatch(slot, msg));
    w.on('error', () => {
      // A thread that dies takes its batch with it; put the work back and
      // carry on with a fresh one.
      const jobs = slot.batch ? this.batches.get(slot.batch) : null;
      if (jobs) { this.batches.delete(slot.batch); for (const j of jobs) (j.hi ? this.hi : this.lo).push(j); }
      this.workers.splice(this.workers.indexOf(slot), 1);
      this.spawnWorker(hiOnly);
    });
    this.workers.push(slot);
    this.pump();
  }

  async close() {
    for (const w of this.watchers.values()) try { w.close(); } catch (e) { /* gone */ }
    this.watchers.clear();
    this.flush();
    await Promise.all(this.workers.map((s) => s.w.terminate()));
  }

  // ------------------------------------------------------------ scanning

  pump() {
    for (const slot of this.workers) {
      if (slot.busy) continue;
      const jobs = [];
      // The first thread only ever serves folders someone is waiting on, so a
      // drive-wide crawl can never put a click behind it.
      while (this.hi.length && jobs.length < 4) jobs.push(this.hi.shift());
      if (!jobs.length && !slot.hiOnly) while (this.lo.length && jobs.length < BATCH) jobs.push(this.lo.shift());
      if (!jobs.length) continue;
      const id = ++this.batchSeq;
      const live = [];
      for (const j of jobs) {
        if (!this.store.alive(j.dir)) { this.settle(j, { error: 'missing' }); continue; }
        if (j.hi) this.queuedHi.delete(j.dir);
        j.path = this.store.pathOf(j.dir);
        live.push(j);
      }
      if (!live.length) { this.pump(); return; }
      this.batches.set(id, live);
      slot.busy = true;
      slot.batch = id;
      slot.w.postMessage({ id, jobs: live.map((j) => ({ dir: j.dir, path: j.path, ifMtime: j.ifMtime, stamp: this.skipUnchanged })) });
    }
  }

  onBatch(slot, msg) {
    slot.busy = false;
    slot.batch = 0;
    const jobs = this.batches.get(msg.batch) || [];
    this.batches.delete(msg.batch);
    for (let i = 0; i < msg.results.length; i++) this.handle(jobs[i], msg.results[i]);
    this.pump();
    this.maybeSave();
  }

  handle(job, res) {
    const s = this.store;
    const dir = job.dir;
    if (!s.alive(dir)) { this.settle(job, { error: 'missing' }); return; }
    this.lastRead.set(dir, Date.now());
    if (res.unchanged) {
      // Nothing in this folder moved; its subfolders still might have.
      if (job.deep) {
        for (const c of s.kids[dir] || []) {
          if ((s.flags[c] & (F_DIR | F_LINK)) !== F_DIR) continue;
          if (s.skipped(s.names[c], s.parent[dir] < 0)) continue;
          this.queueCrawl(job.crawl, c, true);
        }
      }
    } else if (res.error) {
      if (res.error === 'missing' && s.parent[dir] >= 0 && this.volumeOnline(dir)) {
        const par = s.parent[dir];
        s.kill(dir);
        this.noteChanged(par);
      } else if (res.error === 'missing' || res.error === 'denied') {
        // A drive that is not plugged in keeps its index: browsable and
        // searchable offline, refreshed when it comes back.
        if (s.parent[dir] < 0 || !this.volumeOnline(dir)) this.markOffline(dir);
      }
    } else {
      const { changed, descend, fresh } = s.apply(dir, res.listing, !!job.deep);
      if (res.mtime !== undefined && res.mtime >= 0) s.mtime[dir] = res.mtime;
      if (changed) this.noteChanged(dir);
      if (job.crawl) {
        for (const d of descend) this.queueCrawl(job.crawl, d, !!job.crawl.revalidate);
      } else {
        // A rescan of one folder inside an indexed location only has to follow
        // what is new; the rest is already indexed.
        for (const d of fresh) this.queueCrawl(this.crawlFor(d), d, false);
      }
    }
    this.settle(job, res);
  }

  settle(job, res) {
    if (job.crawl) {
      const c = job.crawl;
      c.pending--;
      c.done++;
      if (c.pending === 0) this.finishCrawl(c);
      this.progressSoon();
    }
    const w = this.waiters.get(job.dir);
    if (w && job.hi) {
      this.waiters.delete(job.dir);
      for (const fn of w) fn(res);
    }
  }

  queueCrawl(crawl, dir, revalidate) {
    const s = this.store;
    const job = { dir, deep: true, crawl };
    // Only a folder whose contents were read before can be skipped on date.
    if (revalidate && this.skipUnchanged && (s.flags[dir] & F_SCANNED)) job.ifMtime = s.mtime[dir];
    crawl.pending++;
    this.lo.push(job);
  }

  // Read one folder now, ahead of any crawl. Resolves with the scan result.
  readNow(dir) {
    return new Promise((resolve) => {
      let w = this.waiters.get(dir);
      if (!w) { w = []; this.waiters.set(dir, w); }
      w.push(resolve);
      this.readSoon(dir);
    });
  }

  readSoon(dir) {
    if (this.queuedHi.has(dir)) return;
    this.queuedHi.add(dir);
    this.hi.push({ dir, hi: true, deep: (this.store.flags[dir] & F_DEEP) !== 0 });
    this.pump();
  }

  // A crawl to attribute a newly found folder to: the location it is in.
  crawlFor(dir) {
    const p = this.store.pathOf(dir);
    const root = this.rootOf(p);
    if (!root) return this.adhoc || (this.adhoc = { root: null, pending: 0, done: 0, start: Date.now() });
    let c = this.crawls.get(root.path);
    if (!c) {
      c = { root, pending: 0, done: 0, start: Date.now(), revalidate: false, quiet: true };
      this.crawls.set(root.path, c);
    }
    return c;
  }

  startCrawl(rootPath, revalidate) {
    const s = this.store;
    const root = this.roots.find((r) => r.path === rootPath);
    if (!root) return;
    if (this.crawls.has(rootPath) && !this.crawls.get(rootPath).quiet) return;
    const top = s.idOfPath(rootPath, true);
    s.flags[top] |= F_DEEP;
    const c = this.crawls.get(rootPath) || { root, pending: 0, done: 0 };
    Object.assign(c, { start: Date.now(), revalidate, quiet: false });
    this.crawls.set(rootPath, c);
    root.status = 'scanning';
    // The top is always read: it is how an unplugged drive is noticed.
    c.pending++;
    this.lo.push({ dir: top, deep: true, crawl: c });
    this.emitRoots();
    this.pump();
  }

  finishCrawl(c) {
    if (!c.root) return;
    const r = c.root;
    this.crawls.delete(r.path);
    if (r.status === 'offline') { this.emitRoots(); return; }
    r.status = 'idle';
    if (!c.quiet) {
      r.lastScan = Date.now();
      r.ms = Date.now() - c.start;
    }
    const top = this.store.idOfPath(r.path, false);
    if (top >= 0) Object.assign(r, this.store.statsUnder(top));
    this.emitRoots();
    this.saveSoon(1500);
  }

  markOffline(dir) {
    const p = this.store.pathOf(dir);
    const r = this.rootOf(p);
    if (r && r.status !== 'offline') {
      r.status = 'offline';
      // Nothing more to read on a drive that is not there.
      const c = this.crawls.get(r.path);
      if (c) {
        const keep = new Deque();
        while (this.lo.length) { const j = this.lo.shift(); if (j.crawl !== c) keep.push(j); else c.pending--; }
        this.lo = keep;
      }
      this.emitRoots();
    }
  }

  volumeOnline(dir) {
    const s = this.store;
    let top = dir;
    while (s.parent[top] >= 0) top = s.parent[top];
    const name = s.names[top];
    const hit = this.onlineCache.get(name);
    if (hit && Date.now() - hit.at < 3000) return hit.ok;
    let ok = false;
    try { fs.accessSync(name); ok = true; } catch (e) { ok = false; }
    this.onlineCache.set(name, { ok, at: Date.now() });
    return ok;
  }

  // ------------------------------------------------------------ watching

  startWatch(rootPath) {
    if (!this.watch || this.watchers.has(rootPath)) return;
    try {
      const w = fs.watch(rootPath, { recursive: true, persistent: false }, (ev, name) => {
        if (!name) { this.watchDirty.add(rootPath); } else {
          const full = path.join(rootPath, name.toString());
          this.watchDirty.add(path.dirname(full));
        }
        if (!this.watchTimer) this.watchTimer = setTimeout(() => this.flushWatch(), 300);
      });
      w.on('error', () => {
        try { w.close(); } catch (e) { /* gone */ }
        this.watchers.delete(rootPath);
      });
      this.watchers.set(rootPath, w);
    } catch (e) {
      /* unwatchable (network share, permissions): revisits still revalidate */
    }
  }

  flushWatch() {
    this.watchTimer = null;
    const s = this.store;
    const dirs = [...this.watchDirty];
    this.watchDirty.clear();
    for (let p of dirs) {
      // The nearest folder the index already has; a whole new tree is found
      // by reading its parent.
      let id = s.idOfPath(p, false);
      while (id < 0) {
        const up = path.dirname(p);
        if (up === p) break;
        p = up;
        id = s.idOfPath(p, false);
      }
      if (id >= 0 && (s.flags[id] & F_SCANNED)) this.readSoon(id);
    }
  }

  // ------------------------------------------------------------ events

  noteChanged(dir) {
    this.changedDirs.add(dir);
    if (this.changedTimer) return;
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null;
      const dirs = [...this.changedDirs];
      this.changedDirs.clear();
      this.emit('changed', dirs.length > 2000 ? { all: true } : { dirs });
    }, 250);
  }

  progressSoon() {
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.emit('progress', this.progress());
    }, 250);
  }

  progress() {
    const scanning = [];
    for (const c of this.crawls.values()) {
      if (c.quiet || !c.root) continue;
      const secs = Math.max(0.001, (Date.now() - c.start) / 1000);
      scanning.push({ path: c.root.path, done: c.done, pending: c.pending, rate: Math.round(c.done / secs) });
    }
    return { scanning, entries: this.store.live };
  }

  emitRoots() {
    this.emit('roots', this.rootsInfo());
  }

  rootsInfo() {
    return this.roots.map((r) => ({ ...r }));
  }

  rootOf(p) {
    const s = this.store;
    const lp = s.win ? p.toLowerCase() : p;
    let best = null;
    for (const r of this.roots) {
      const rp = s.win ? r.path.toLowerCase() : r.path;
      if (lp === rp || lp.startsWith(rp.endsWith(s.sep) ? rp : rp + s.sep)) {
        if (!best || r.path.length > best.path.length) best = r;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ saving

  maybeSave() {
    if (this.store.version !== this.savedVersion && Date.now() - this.lastSave > SAVE_EVERY_MS) this.flush();
  }

  saveSoon(ms) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, ms);
  }

  flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.store.version === this.savedVersion) return 0;
    const roots = this.roots.map(({ status, ...r }) => r);
    try {
      const bytes = this.store.save(this.file, { roots, savedAt: Date.now() });
      this.savedVersion = this.store.version;
      this.lastSave = Date.now();
      return bytes;
    } catch (e) {
      return -1;
    }
  }

  // ------------------------------------------------------------ queries

  rowsFor(ids, limit) {
    const n = Math.min(ids.length, limit === undefined ? ids.length : limit);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.store.row(ids[i]);
    return out;
  }

  async list(o) {
    const s = this.store;
    const p = s.normPath(o.path || '');
    if (!p) return { error: 'bad-path', path: o.path };
    let id = s.idOfPath(p, true);
    if (id < 0) return { error: 'missing', path: p };
    if (!(s.flags[id] & F_SCANNED)) {
      const res = await this.readNow(id);
      if (res.error) return { error: res.error, path: p };
      // The read may have replaced a placeholder that was really a file.
      if (!s.alive(id)) return { error: 'missing', path: p };
    } else if (!o.cached && Date.now() - (this.lastRead.get(id) || 0) > REVISIT_MS) {
      this.readSoon(id);
    }
    id = s.alive(id) ? id : -1;
    if (id < 0) return { error: 'missing', path: p };
    const t0 = performance.now();
    const ids = s.list(id, o);
    const parent = s.parent[id];
    return {
      dir: id,
      path: s.pathOf(id),
      parent: parent >= 0 ? s.pathOf(parent) : null,
      ids,
      rows: this.rowsFor(ids, ROWS_UP_FRONT),
      offline: !this.volumeOnline(id),
      indexed: (s.flags[id] & F_DEEP) !== 0,
      ms: performance.now() - t0,
    };
  }

  search(o) {
    const s = this.store;
    const t0 = performance.now();
    let scope = -1;
    if (o.scope) {
      scope = s.idOfPath(o.scope, false);
      if (scope < 0) return { ids: new Int32Array(0), rows: [], ms: 0 };
    }
    const ids = s.search(o.q || '', { ...o, scope });
    const ms = performance.now() - t0;
    return { ids, rows: this.rowsFor(ids, ROWS_UP_FRONT), ms, searched: s.blob ? s.blob.n : 0 };
  }

  rows(o) {
    return this.rowsFor(o.ids);
  }

  // Folders under a path, for the address bar's completion.
  subdirs(o) {
    const s = this.store;
    const id = s.idOfPath(o.path, false);
    if (id < 0) return [];
    const out = [];
    for (const k of s.kids[id] || []) if ((s.flags[k] & (F_DIR | F_HIDDEN)) === F_DIR) out.push(s.names[k]);
    return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  // Every media file under a path (or only directly in it, with deep: false),
  // for building thumbnails ahead of time.
  mediaUnder(o) {
    const s = this.store;
    const top = s.idOfPath(o.path, false);
    if (top < 0) return [];
    const out = [];
    const limit = o.limit || 500000;
    const stack = [top];
    while (stack.length && out.length < limit) {
      const x = stack.pop();
      for (const c of s.kids[x] || []) {
        const f = s.flags[c];
        if (!(f & F_ALIVE) || (f & F_HIDDEN)) continue;
        if (f & F_DIR) { if (o.deep !== false) stack.push(c); continue; }
        const k = s.kind[c];
        if (k === KIND.PHOTO || k === KIND.VIDEO || k === KIND.AUDIO) {
          out.push({ path: s.pathOf(c), size: s.size[c], mtime: s.mtime[c], kind: k, cloud: (f & 64) !== 0 });
        }
      }
    }
    return out;
  }

  stats() {
    return { ...this.store.stats(), ...this.progress(), threads: this.threads, file: this.file };
  }

  addRoot(o) {
    const s = this.store;
    const p = s.normPath(o.path || '');
    if (!p) return { error: 'bad-path' };
    if (this.roots.some((r) => r.path === p)) { this.startCrawl(p, false); return this.rootsInfo(); }
    // A location inside one already indexed adds nothing; one that contains
    // others absorbs them.
    const outer = this.rootOf(p);
    if (outer) return { error: 'inside', root: outer.path };
    const lp = s.win ? p.toLowerCase() : p;
    const prefix = lp.endsWith(s.sep) ? lp : lp + s.sep;
    this.roots = this.roots.filter((r) => !(s.win ? r.path.toLowerCase() : r.path).startsWith(prefix));
    this.roots.push({ path: p, added: Date.now(), lastScan: 0, ms: 0, files: 0, dirs: 0, media: 0, status: 'idle' });
    this.startCrawl(p, false);
    this.startWatch(p);
    return this.rootsInfo();
  }

  removeRoot(o) {
    const s = this.store;
    const r = this.roots.find((x) => x.path === o.path);
    if (!r) return this.rootsInfo();
    this.roots = this.roots.filter((x) => x !== r);
    const w = this.watchers.get(r.path);
    if (w) { try { w.close(); } catch (e) { /* gone */ } this.watchers.delete(r.path); }
    const c = this.crawls.get(r.path);
    if (c) {
      const keep = new Deque();
      while (this.lo.length) { const j = this.lo.shift(); if (j.crawl !== c) keep.push(j); }
      this.lo = keep;
      this.crawls.delete(r.path);
    }
    const top = s.idOfPath(r.path, false);
    if (top >= 0) s.undeep(top);
    this.noteChanged(top);
    this.saveSoon(500);
    return this.rootsInfo();
  }

  rescan(o) {
    const r = this.roots.find((x) => x.path === o.path);
    if (r) { r.status = 'idle'; this.startCrawl(r.path, false); }
    return this.rootsInfo();
  }

  // ------------------------------------------------------------ dispatch

  async op(name, args) {
    switch (name) {
      case 'list': return this.list(args);
      case 'search': return this.search(args);
      case 'rows': return this.rows(args);
      case 'subdirs': return this.subdirs(args);
      case 'roots': return this.rootsInfo();
      case 'addRoot': return this.addRoot(args);
      case 'removeRoot': return this.removeRoot(args);
      case 'rescan': return this.rescan(args);
      case 'stats': return this.stats();
      case 'mediaUnder': return this.mediaUnder(args);
      case 'flush': return this.flush();
      default: throw new Error('unknown op ' + name);
    }
  }
}

module.exports = { Indexer };
