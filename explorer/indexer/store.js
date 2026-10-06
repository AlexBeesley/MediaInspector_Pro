'use strict';
// The index: every folder and file the explorer knows about, held in memory as
// columns rather than objects.
//
// One entry is an integer id. Its parent, size, date, flags and kind sit at that
// id in typed arrays, and its name in a plain string array - about 30 bytes of
// columns plus the name per entry, against several hundred for a JS object, and
// a scan over a million of them stays inside the CPU cache instead of chasing
// pointers. Ids are never reused within a session, so an id the renderer holds
// stays valid; dead entries are tombstoned and dropped when the index is saved.
//
// A parent is always created before its children, so a parent's id is always
// smaller than its child's. Saving keeps that order, which is what lets loading
// rebuild the tree in one pass.

const fs = require('fs');
const path = require('path');
const { KIND, kindOf, extOf } = require('../lib/media');
const { L_DIR, L_LINK, L_HIDDEN, L_CLOUD } = require('./fsscan');

const F_DIR = 1;
const F_ALIVE = 2;
const F_SCANNED = 4;   // a folder whose entries have been read at least once
const F_DEEP = 8;      // inside an indexed location, so crawled and watched
const F_LINK = 16;
const F_HIDDEN = 32;
const F_CLOUD = 64;

const MAGIC = 'MXIDX002';

// Folders a crawl never descends into. They are still browsable - this only
// keeps a whole-drive index from filling up with the OS, toolchains and trash.
const SKIP_ANYWHERE = new Set([
  '$recycle.bin', 'system volume information', '$winreagent', 'config.msi',
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache',
  '.trash', '.trashes', '.spotlight-v100', '.fseventsd', '.temporaryitems',
  'appdata', 'windowsapps', '$windows.~bt', '$windows.~ws',
]);
const SKIP_AT_DRIVE_ROOT = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'recovery',
  'perflogs', 'msocache', 'intel', 'amd', 'nvidia',
  // a POSIX root
  'proc', 'sys', 'dev', 'run', 'snap', 'boot', 'usr', 'lib', 'lib32', 'lib64',
  'bin', 'sbin', 'etc', 'var', 'tmp', 'opt', 'srv', 'lost+found',
]);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

class Store {
  constructor(opts = {}) {
    this.win = opts.win !== undefined ? !!opts.win : process.platform === 'win32';
    this.sep = this.win ? '\\' : '/';
    this.cap = 0;
    this.count = 0;
    this.names = [];
    this.lowers = [];
    this.kids = [];          // id -> number[] of child ids, folders only
    this.tops = new Map();   // root key ('c:\', '/', '\\srv\share\') -> id
    this.alloc(1 << 12);
    this.dirPaths = new Map();
    this.nkeys = [];         // natural-sort keys, made on first sort
    this.blob = null;        // search text, rebuilt after the tree changes
    this.version = 1;
    this.live = 0;
  }

  alloc(cap) {
    const grow = (Old, old) => {
      const a = new Old(cap);
      if (old) a.set(old.subarray(0, this.count));
      return a;
    };
    this.parent = grow(Int32Array, this.parent);
    this.size = grow(Float64Array, this.size);
    this.mtime = grow(Float64Array, this.mtime);
    this.flags = grow(Uint8Array, this.flags);
    this.kind = grow(Uint8Array, this.kind);
    this.cap = cap;
  }

  add(parent, name, flags, size, mtime) {
    if (this.count === this.cap) this.alloc(this.cap * 2);
    const id = this.count++;
    this.parent[id] = parent;
    this.flags[id] = flags | F_ALIVE;
    this.size[id] = size;
    this.mtime[id] = mtime;
    this.kind[id] = flags & F_DIR ? KIND.OTHER : kindOf(name);
    this.names[id] = name;
    this.lowers[id] = name.toLowerCase();
    if (flags & F_DIR) this.kids[id] = [];
    if (parent >= 0) this.kids[parent].push(id);
    this.live++;
    this.blob = null;
    return id;
  }

  isDir(id) { return (this.flags[id] & F_DIR) !== 0; }
  alive(id) { return id >= 0 && id < this.count && (this.flags[id] & F_ALIVE) !== 0; }

  // ------------------------------------------------------------ paths

  // Split an absolute path into its root and the names below it. Windows paths
  // compare case-insensitively, so the root key is lowered there.
  splitPath(p) {
    if (this.win) {
      p = p.replace(/\//g, '\\');
      let root;
      let rest;
      if (p.startsWith('\\\\')) {
        const parts = p.slice(2).split('\\').filter(Boolean);
        if (parts.length < 2) return null;
        root = '\\\\' + parts[0] + '\\' + parts[1] + '\\';
        rest = parts.slice(2);
      } else {
        const m = /^([a-zA-Z]):(?:\\|$)/.exec(p);
        if (!m) return null;
        root = m[1].toUpperCase() + ':\\';
        rest = p.slice(2).split('\\').filter(Boolean);
      }
      return { root, rest };
    }
    if (!p.startsWith('/')) return null;
    return { root: '/', rest: p.split('/').filter(Boolean) };
  }

  normPath(p) {
    const s = this.splitPath(p);
    if (!s) return null;
    return s.root + s.rest.join(this.sep);
  }

  pathOf(id) {
    if (id < 0) return '';
    const isDir = this.isDir(id);
    if (isDir) {
      const hit = this.dirPaths.get(id);
      if (hit !== undefined) return hit;
    }
    const par = this.parent[id];
    let out;
    if (par < 0) out = this.names[id];
    else {
      const pp = this.pathOf(par);
      out = pp.endsWith(this.sep) ? pp + this.names[id] : pp + this.sep + this.names[id];
    }
    if (isDir) this.dirPaths.set(id, out);
    return out;
  }

  childByName(dir, name) {
    const kids = this.kids[dir];
    if (!kids) return -1;
    if (this.win) {
      const lo = name.toLowerCase();
      for (let i = 0; i < kids.length; i++) if (this.lowers[kids[i]] === lo) return kids[i];
    } else {
      for (let i = 0; i < kids.length; i++) if (this.names[kids[i]] === name) return kids[i];
    }
    return -1;
  }

  // The id for a folder path. With create, placeholder folders are made along
  // the way; they are filled in when they are first read, and keep their ids
  // when their parent is read later.
  idOfPath(p, create) {
    const s = this.splitPath(p);
    if (!s) return -1;
    const key = this.win ? s.root.toLowerCase() : s.root;
    let id = this.tops.get(key);
    if (id === undefined) {
      if (!create) return -1;
      id = this.add(-1, s.root, F_DIR, 0, 0);
      this.tops.set(key, id);
    }
    for (const name of s.rest) {
      let next = this.childByName(id, name);
      if (next < 0) {
        if (!create) return -1;
        next = this.add(id, name, F_DIR, 0, 0);
      } else if (!this.isDir(next)) {
        return -1;
      }
      id = next;
    }
    return id;
  }

  isUnder(id, ancestor) {
    for (let p = id; p >= 0; p = this.parent[p]) if (p === ancestor) return true;
    return false;
  }

  // ------------------------------------------------------------ updates

  // Drop an entry and everything under it. Children are tombstoned rather than
  // spliced out one at a time - only the top of the subtree leaves its parent.
  kill(id) {
    const par = this.parent[id];
    if (par >= 0) {
      const k = this.kids[par];
      const i = k.indexOf(id);
      if (i >= 0) k.splice(i, 1);
    }
    const stack = [id];
    while (stack.length) {
      const x = stack.pop();
      if (!(this.flags[x] & F_ALIVE)) continue;
      this.flags[x] &= ~F_ALIVE;
      this.live--;
      const k = this.kids[x];
      if (k) {
        for (let i = 0; i < k.length; i++) stack.push(k[i]);
        this.kids[x] = undefined;
      }
      this.nkeys[x] = undefined;
    }
    this.dirPaths.clear();
    this.blob = null;
  }

  // Merge a fresh listing of a folder into the tree. Entries keep their ids
  // when they are still there, so a revisit costs nothing downstream. Returns
  // whether anything changed, the subfolders a crawl should go on into, and
  // which of those are new (all a rescan of one folder needs to follow).
  apply(dir, listing, deep) {
    const kids = this.kids[dir] || (this.kids[dir] = []);
    const byName = new Map();
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      byName.set(this.win ? this.lowers[k] : this.names[k], k);
    }
    let changed = !(this.flags[dir] & F_SCANNED);
    const descend = [];
    const fresh = [];
    const deepFlag = deep ? F_DEEP : 0;
    const atDriveRoot = this.parent[dir] < 0;

    for (let i = 0; i < listing.n; i++) {
      const name = listing.names[i];
      const lf = listing.flags[i];
      let f = deepFlag;
      if (lf & L_DIR) f |= F_DIR;
      if (lf & L_LINK) f |= F_LINK;
      if (lf & L_HIDDEN) f |= F_HIDDEN;
      if (lf & L_CLOUD) f |= F_CLOUD;
      const size = listing.sizes[i];
      const mtime = listing.mtimes[i];
      const key = this.win ? name.toLowerCase() : name;
      let id = byName.get(key);
      let isNew = false;
      if (id !== undefined) {
        byName.delete(key);
        if ((this.flags[id] & F_DIR) !== (f & F_DIR)) {
          // A file became a folder or the other way round: a different thing.
          this.kill(id);
          id = undefined;
        }
      }
      if (id === undefined) {
        id = this.add(dir, name, f, size, mtime);
        changed = true;
        isNew = true;
      } else {
        const keep = this.flags[id] & (F_ALIVE | F_SCANNED | F_DEEP);
        const nf = keep | f;
        if (f & F_DIR) {
          // A folder's own date is not a change anyone sees, except through
          // what is in it, which its own scan reports. Off Windows the column
          // means "when its contents were last read" and is what lets a
          // revalidation skip it, so only that read may move it.
          if (this.win) this.mtime[id] = mtime;
          if (this.flags[id] !== nf) { this.flags[id] = nf; changed = true; }
        } else if (this.size[id] !== size || this.mtime[id] !== mtime || this.flags[id] !== nf) {
          changed = true;
          this.size[id] = size;
          this.mtime[id] = mtime;
          this.flags[id] = nf;
        }
        if (this.names[id] !== name) {
          this.names[id] = name;
          this.lowers[id] = name.toLowerCase();
          this.nkeys[id] = undefined;
          this.dirPaths.clear();
          this.blob = null;
          changed = true;
        }
      }
      if (deep && (f & F_DIR) && !(f & F_LINK) && !this.skipped(name, atDriveRoot)) {
        descend.push(id);
        if (isNew) fresh.push(id);
      }
    }
    for (const gone of byName.values()) {
      this.kill(gone);
      changed = true;
    }
    this.flags[dir] |= F_SCANNED | deepFlag;
    if (changed) this.version++;
    return { changed, descend, fresh };
  }

  skipped(name, atDriveRoot) {
    const lo = name.toLowerCase();
    return SKIP_ANYWHERE.has(lo) || (atDriveRoot && SKIP_AT_DRIVE_ROOT.has(lo));
  }

  // Drop everything inside a folder in one pass, without splicing each child
  // out of the folder's list one at a time.
  clear(dir) {
    const k = this.kids[dir];
    if (!k || !k.length) return;
    this.kids[dir] = [];
    for (let i = 0; i < k.length; i++) {
      // Detach first so kill() has nothing to splice.
      this.parent[k[i]] = -1;
      this.kill(k[i]);
      this.parent[k[i]] = dir;
    }
    this.flags[dir] &= ~F_SCANNED;
    this.version++;
  }

  // A location stops being indexed: its top level stays as browse cache, and
  // what the crawl found below that is forgotten.
  undeep(top) {
    this.flags[top] &= ~F_DEEP;
    for (const c of this.kids[top] || []) {
      this.flags[c] &= ~F_DEEP;
      if (this.flags[c] & F_DIR) this.clear(c);
    }
    this.version++;
  }

  // ------------------------------------------------------------ listing

  natKey(id) {
    let k = this.nkeys[id];
    if (k === undefined) {
      // Zero-pad every run of digits so plain string order is natural order:
      // "img 9" < "img 10". A plain < on these is ~20x a collator compare.
      k = this.lowers[id].replace(/\d+/g, (d) => (d.length >= 12 ? d : '000000000000'.slice(d.length) + d));
      this.nkeys[id] = k;
    }
    return k;
  }

  // Filtering shared by listing and search.
  makeFilter(opts) {
    const hidden = !!opts.hidden;
    const show = opts.show || 'media';
    const want = show === 'video' ? KIND.VIDEO : show === 'photo' ? KIND.PHOTO : show === 'audio' ? KIND.AUDIO : -1;
    const flags = this.flags;
    const kind = this.kind;
    return (id) => {
      const f = flags[id];
      if (!hidden && (f & F_HIDDEN)) return false;
      if (f & F_DIR) return true;
      const k = kind[id];
      if (k === KIND.OTHER) return false;
      return want < 0 || k === want;
    };
  }

  sortIds(ids, sort, desc) {
    const flags = this.flags;
    const dirFirst = (a, b) => (flags[b] & F_DIR) - (flags[a] & F_DIR);
    let cmp;
    if (sort === 'size') {
      const s = this.size;
      cmp = (a, b) => dirFirst(a, b) || (desc ? s[b] - s[a] : s[a] - s[b]) || a - b;
    } else if (sort === 'date') {
      const m = this.mtime;
      cmp = (a, b) => dirFirst(a, b) || (desc ? m[b] - m[a] : m[a] - m[b]) || a - b;
    } else if (sort === 'type') {
      const ext = new Map();
      const e = (id) => { let x = ext.get(id); if (x === undefined) { x = extOf(this.names[id]); ext.set(id, x); } return x; };
      cmp = (a, b) => {
        const d = dirFirst(a, b);
        if (d) return d;
        const ea = e(a);
        const eb = e(b);
        const r = ea < eb ? -1 : ea > eb ? 1 : 0;
        return (desc ? -r : r) || this.natCmp(a, b);
      };
    } else {
      // Small sets get a real collator (accents, locale); big ones the padded
      // key, which is close enough and far faster.
      if (ids.length <= 3000) {
        const names = this.names;
        cmp = (a, b) => dirFirst(a, b) || (desc ? collator.compare(names[b], names[a]) : collator.compare(names[a], names[b]));
      } else {
        for (let i = 0; i < ids.length; i++) this.natKey(ids[i]);
        const nk = this.nkeys;
        cmp = (a, b) => {
          const d = dirFirst(a, b);
          if (d) return d;
          const r = nk[a] < nk[b] ? -1 : nk[a] > nk[b] ? 1 : a - b;
          return desc ? -r : r;
        };
      }
    }
    return ids.sort(cmp);
  }

  natCmp(a, b) {
    const ka = this.natKey(a);
    const kb = this.natKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }

  list(dir, opts = {}) {
    const kids = this.kids[dir] || [];
    const keep = this.makeFilter(opts);
    const out = new Int32Array(kids.length);
    let n = 0;
    for (let i = 0; i < kids.length; i++) if (keep(kids[i])) out[n++] = kids[i];
    return this.sortIds(out.subarray(0, n), opts.sort, opts.desc).slice();
  }

  // The picture a folder tile shows: its first photo or video, by name.
  cover(dir) {
    const kids = this.kids[dir];
    if (!kids || !(this.flags[dir] & F_SCANNED)) return -1;
    let best = -1;
    let bestKey = '';
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const kd = this.kind[k];
      if ((kd !== KIND.PHOTO && kd !== KIND.VIDEO) || (this.flags[k] & (F_HIDDEN | F_DIR))) continue;
      const key = this.natKey(k);
      if (best < 0 || key < bestKey) { best = k; bestKey = key; }
    }
    return best;
  }

  // ------------------------------------------------------------ search

  // Every live name, lowered, in one string: "\nname\nname...". One indexOf
  // over it is a vectorised scan of the whole index; a match's position maps
  // back to its entry through `starts`. Rebuilt only after names change.
  ensureBlob() {
    if (this.blob) return;
    const ids = new Int32Array(this.live);
    const starts = new Int32Array(this.live + 1);
    const parts = new Array(this.live);
    let n = 0;
    let pos = 1;
    for (let id = 0; id < this.count; id++) {
      if (!(this.flags[id] & F_ALIVE) || this.parent[id] < 0) continue;
      const lo = this.lowers[id];
      ids[n] = id;
      starts[n] = pos;
      parts[n] = lo;
      pos += lo.length + 1;
      n++;
    }
    starts[n] = pos;
    parts.length = n;
    this.blob = { text: '\n' + parts.join('\n') + '\n', ids: ids.subarray(0, n), starts: starts.subarray(0, n + 1), n };
  }

  search(q, opts = {}) {
    const query = typeof q === 'string' ? parseQuery(q) : q;
    this.ensureBlob();
    const { text, ids, starts, n } = this.blob;
    const keep = this.makeFilter(opts);
    const scope = opts.scope >= 0 ? opts.scope : -1;
    const scopeMemo = new Map();
    const inScope = (id) => {
      if (scope < 0) return true;
      const p = this.parent[id];
      let r = scopeMemo.get(p);
      if (r === undefined) {
        r = this.isUnder(p, scope);
        scopeMemo.set(p, r);
      }
      return r;
    };
    const pathMemo = new Map();
    const pathOk = (id) => {
      if (!query.paths.length) return true;
      const p = this.parent[id];
      let r = pathMemo.get(p);
      if (r === undefined) {
        r = true;
        for (const t of query.paths) {
          let hit = false;
          for (let a = p; a >= 0 && !hit; a = this.parent[a]) if (this.lowers[a].includes(t)) hit = true;
          if (!hit) { r = false; break; }
        }
        pathMemo.set(p, r);
      }
      return r;
    };
    // Inside a hidden folder is hidden too, unless hidden things are asked for.
    const hidMemo = new Map();
    const inHidden = (id) => {
      const p = this.parent[id];
      let r = hidMemo.get(p);
      if (r === undefined) {
        r = false;
        for (let a = p; a >= 0; a = this.parent[a]) if (this.flags[a] & F_HIDDEN) { r = true; break; }
        hidMemo.set(p, r);
      }
      return r;
    };
    const showHidden = !!opts.hidden;
    const lowers = this.lowers;
    const accept = (id) => {
      if (!(this.flags[id] & F_ALIVE)) return false;
      if (!keep(id)) return false;
      const lo = lowers[id];
      for (const t of query.terms) if (!lo.includes(t)) return false;
      for (const t of query.not) if (lo.includes(t)) return false;
      if (query.exts && !query.exts.has(extOf(lo))) return false;
      if (query.kinds && !query.kinds.has(this.kind[id])) return false;
      if (query.dirs === true && !(this.flags[id] & F_DIR)) return false;
      if (query.dirs === false && (this.flags[id] & F_DIR)) return false;
      if (query.minSize >= 0 && (this.flags[id] & F_DIR || this.size[id] < query.minSize)) return false;
      if (query.maxSize >= 0 && (this.flags[id] & F_DIR || this.size[id] > query.maxSize)) return false;
      if (query.after > 0 && this.mtime[id] < query.after) return false;
      if (query.before > 0 && this.mtime[id] >= query.before) return false;
      return inScope(id) && pathOk(id) && (showHidden || !inHidden(id));
    };

    // Relevance in four buckets, each kept in index order (which is folder
    // order), so ranking costs no sort at all: whole name, name starts with
    // the term, a word starts with it, anywhere.
    const buckets = [[], [], [], []];
    const driver = query.terms.reduce((a, t) => (t.length > a.length ? t : a), '');
    if (driver) {
      let pos = text.indexOf(driver, 1);
      let lo = 0;
      while (pos >= 0) {
        // The entry containing pos: the last start <= pos. Matches arrive in
        // order, so the search window only ever moves forward.
        let hi = n - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
        }
        const id = ids[lo];
        if (accept(id)) {
          const name = lowers[id];
          const at = pos - starts[lo];
          let b = 3;
          if (at === 0) b = name.length === driver.length || name.lastIndexOf('.') === driver.length ? 0 : 1;
          else if (!isWordChar(name.charCodeAt(at - 1))) b = 2;
          buckets[b].push(id);
        }
        // Next entry: a name is counted once however often the term repeats.
        pos = text.indexOf(driver, starts[lo + 1]);
        lo++;
      }
    } else {
      for (let i = 0; i < n; i++) if (accept(ids[i])) buckets[3].push(ids[i]);
    }
    const total = buckets[0].length + buckets[1].length + buckets[2].length + buckets[3].length;
    let out = new Int32Array(total);
    let o = 0;
    for (const b of buckets) { out.set(b, o); o += b.length; }
    if (opts.sort && opts.sort !== 'relevance') out = this.sortIds(out, opts.sort, opts.desc);
    return out;
  }

  // ------------------------------------------------------------ rows

  row(id) {
    const f = this.flags[id];
    const dir = (f & F_DIR) !== 0;
    const r = {
      id,
      name: this.names[id],
      path: this.pathOf(id),
      dir,
      kind: this.kind[id],
      size: this.size[id],
      mtime: this.mtime[id],
      hidden: (f & F_HIDDEN) !== 0,
      cloud: (f & F_CLOUD) !== 0,
      link: (f & F_LINK) !== 0,
      alive: (f & F_ALIVE) !== 0,
    };
    if (dir) {
      r.scanned = (f & F_SCANNED) !== 0;
      r.count = r.scanned && this.kids[id] ? this.kids[id].length : -1;
      const c = this.cover(id);
      if (c >= 0) r.cover = { path: this.pathOf(c), size: this.size[c], mtime: this.mtime[c], kind: this.kind[c] };
    }
    return r;
  }

  stats() {
    let files = 0;
    let dirs = 0;
    let media = 0;
    let bytes = 0;
    for (let id = 0; id < this.count; id++) {
      const f = this.flags[id];
      if (!(f & F_ALIVE)) continue;
      if (f & F_DIR) { dirs++; continue; }
      files++;
      if (this.kind[id] !== KIND.OTHER) media++;
      if (this.size[id] > 0) bytes += this.size[id];
    }
    return { files, dirs, media, bytes, entries: this.live };
  }

  // Counts for one indexed location, for the sidebar.
  statsUnder(top) {
    let files = 0;
    let dirs = 0;
    let media = 0;
    const stack = [top];
    while (stack.length) {
      const x = stack.pop();
      const k = this.kids[x];
      if (!k) continue;
      for (let i = 0; i < k.length; i++) {
        const c = k[i];
        if (this.flags[c] & F_DIR) { dirs++; stack.push(c); } else { files++; if (this.kind[c]) media++; }
      }
    }
    return { files, dirs, media };
  }

  // ------------------------------------------------------------ persistence

  // Columns are written as raw little-endian arrays after a JSON header, live
  // entries only and in id order. Loading is a few memcpys and one split.
  serialize(meta) {
    const map = new Int32Array(this.count).fill(-1);
    let n = 0;
    for (let id = 0; id < this.count; id++) {
      if (!(this.flags[id] & F_ALIVE)) continue;
      const p = this.parent[id];
      if (p >= 0 && map[p] < 0) continue; // orphan of a dead folder
      map[id] = n++;
    }
    const parent = new Int32Array(n);
    const size = new Float64Array(n);
    const mtime = new Float64Array(n);
    const flags = new Uint8Array(n);
    const names = new Array(n);
    for (let id = 0; id < this.count; id++) {
      const j = map[id];
      if (j < 0) continue;
      const p = this.parent[id];
      parent[j] = p < 0 ? -1 : map[p];
      size[j] = this.size[id];
      mtime[j] = this.mtime[id];
      flags[j] = this.flags[id];
      names[j] = this.names[id];
    }
    const nameBuf = Buffer.from(names.join('\0'), 'utf8');
    const header = Buffer.from(JSON.stringify({ n, win: this.win, nameBytes: nameBuf.length, meta: meta || {} }), 'utf8');
    const pad = (x) => (8 - (x % 8)) % 8;
    const headLen = 8 + 4 + header.length;
    const head = Buffer.alloc(headLen + pad(headLen));
    head.write(MAGIC, 0, 'latin1');
    head.writeUInt32LE(header.length, 8);
    header.copy(head, 12);
    const view = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    const i32 = view(parent);
    return Buffer.concat([head, view(size), view(mtime), i32, Buffer.alloc(pad(i32.length)), view(flags), nameBuf]);
  }

  save(file, meta) {
    const buf = this.serialize(meta);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    return buf.length;
  }

  static load(file, opts = {}) {
    const store = new Store(opts);
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (e) {
      return { store, meta: null };
    }
    try {
      if (buf.toString('latin1', 0, 8) !== MAGIC) throw new Error('not an index');
      const hlen = buf.readUInt32LE(8);
      const header = JSON.parse(buf.toString('utf8', 12, 12 + hlen));
      if (header.win !== store.win) throw new Error('index from another platform');
      const n = header.n;
      let off = 12 + hlen;
      off += (8 - (off % 8)) % 8;
      // Copy out rather than view: the file buffer's alignment is not ours to
      // rely on, and a copy lets the big read buffer be collected.
      const take = (Type, count) => {
        const bytes = count * Type.BYTES_PER_ELEMENT;
        const a = new Type(count);
        new Uint8Array(a.buffer).set(buf.subarray(off, off + bytes));
        off += bytes;
        return a;
      };
      const size = take(Float64Array, n);
      const mtime = take(Float64Array, n);
      const parent = take(Int32Array, n);
      off += (8 - ((n * 4) % 8)) % 8;
      const flags = take(Uint8Array, n);
      const names = n ? buf.toString('utf8', off, off + header.nameBytes).split('\0') : [];
      if (names.length !== n) throw new Error('index names do not match');

      store.alloc(Math.max(1 << 12, n + (n >> 2)));
      store.parent.set(parent);
      store.size.set(size);
      store.mtime.set(mtime);
      store.flags.set(flags);
      store.count = n;
      store.live = n;
      store.names = names;
      store.lowers = new Array(n);
      for (let id = 0; id < n; id++) {
        const name = names[id];
        const f = flags[id];
        store.lowers[id] = name.toLowerCase();
        store.kind[id] = f & F_DIR ? KIND.OTHER : kindOf(name);
        // An index written before non-media files were left out: drop them
        // here, and the next save leaves them behind.
        if (!(f & F_DIR) && store.kind[id] === KIND.OTHER) {
          store.flags[id] &= ~F_ALIVE;
          store.live--;
          continue;
        }
        if (f & F_DIR) store.kids[id] = [];
        const p = parent[id];
        if (p >= 0) store.kids[p].push(id);
        else store.tops.set(store.win ? name.toLowerCase() : name, id);
      }
      return { store, meta: header.meta };
    } catch (e) {
      return { store: new Store(opts), meta: null, error: e.message };
    }
  }
}

function isWordChar(c) {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || c > 127;
}

// ---------------------------------------------------------------- queries

const UNITS = { b: 1, k: 1e3, kb: 1e3, m: 1e6, mb: 1e6, g: 1e9, gb: 1e9, t: 1e12, tb: 1e12 };

function parseSize(s) {
  const m = /^([\d.]+)\s*([a-z]*)$/.exec(s);
  if (!m) return -1;
  const u = UNITS[m[2] || 'b'];
  return u ? parseFloat(m[1]) * u : -1;
}

// "2024", "2024-03", "2024-03-15" -> [start, end) in ms.
function parseDate(s) {
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(s);
  if (m) {
    const y = +m[1];
    const mo = m[2] ? +m[2] - 1 : 0;
    const d = m[3] ? +m[3] : 1;
    const start = new Date(y, mo, d).getTime();
    const end = m[3] ? new Date(y, mo, d + 1).getTime() : m[2] ? new Date(y, mo + 1, 1).getTime() : new Date(y + 1, 0, 1).getTime();
    return [start, end];
  }
  const rel = /^(\d+)\s*([dwmy])$/.exec(s); // 7d, 2w, 6m, 1y ago until now
  if (rel) {
    const n = +rel[1];
    const day = 86400000;
    const span = { d: day, w: 7 * day, m: 30 * day, y: 365 * day }[rel[2]];
    return [Date.now() - n * span, Infinity];
  }
  return null;
}

const KIND_WORDS = { video: KIND.VIDEO, videos: KIND.VIDEO, photo: KIND.PHOTO, photos: KIND.PHOTO, image: KIND.PHOTO, images: KIND.PHOTO, audio: KIND.AUDIO, music: KIND.AUDIO };

// Words are ANDed substrings of the name. Operators:
//   ext:jpg,png  *.mp4  video: photo: audio:  kind:video  is:folder is:file
//   size:>100mb size:<1g size:10mb..1gb  after:2024-01 before:2024 date:2023
//   modified:7d  path:holiday (any parent folder name)  -word  "two words"
function parseQuery(q) {
  const out = { terms: [], not: [], paths: [], exts: null, kinds: null, dirs: null, minSize: -1, maxSize: -1, after: 0, before: 0 };
  const tokens = q.toLowerCase().match(/-?"[^"]*"?|\S+/g) || [];
  for (let tok of tokens) {
    let neg = false;
    if (tok.startsWith('-') && tok.length > 1) { neg = true; tok = tok.slice(1); }
    if (tok.startsWith('"')) {
      const t = tok.replace(/^"|"$/g, '');
      if (t) (neg ? out.not : out.terms).push(t);
      continue;
    }
    const colon = tok.indexOf(':');
    const op = colon > 0 ? tok.slice(0, colon) : '';
    const val = colon > 0 ? tok.slice(colon + 1) : '';
    if (op === 'ext' || op === 'type') {
      out.exts = out.exts || new Set();
      for (const e of val.split(/[,;|]/)) if (e) out.exts.add(e.replace(/^\*?\./, ''));
    } else if (/^\*\.[a-z0-9]+$/.test(tok)) {
      out.exts = out.exts || new Set();
      out.exts.add(tok.slice(2));
    } else if (op && KIND_WORDS[op] !== undefined && !val) {
      out.kinds = out.kinds || new Set();
      out.kinds.add(KIND_WORDS[op]);
    } else if (op === 'kind' || op === 'is') {
      if (val === 'folder' || val === 'dir') out.dirs = true;
      else if (val === 'file') out.dirs = false;
      else if (KIND_WORDS[val] !== undefined) { out.kinds = out.kinds || new Set(); out.kinds.add(KIND_WORDS[val]); }
    } else if (op === 'size') {
      const range = val.split('..');
      if (range.length === 2) {
        out.minSize = parseSize(range[0]);
        out.maxSize = parseSize(range[1]);
      } else if (val.startsWith('>')) out.minSize = parseSize(val.replace(/^>=?/, ''));
      else if (val.startsWith('<')) out.maxSize = parseSize(val.replace(/^<=?/, ''));
      else { const s = parseSize(val); if (s >= 0) { out.minSize = s * 0.95; out.maxSize = s * 1.05; } }
    } else if (op === 'after' || op === 'since' || op === 'modified' || op === 'before' || op === 'date') {
      const r = parseDate(val.replace(/^[<>]=?/, ''));
      if (!r) continue;
      if (op === 'before') out.before = r[0];
      else if (op === 'date') { out.after = r[0]; out.before = r[1] === Infinity ? 0 : r[1]; }
      else out.after = op === 'modified' ? r[0] : r[0];
    } else if (op === 'path' || op === 'in') {
      if (val) out.paths.push(val);
    } else if (tok) {
      (neg ? out.not : out.terms).push(tok);
    }
  }
  return out;
}

module.exports = { Store, parseQuery, F_DIR, F_ALIVE, F_SCANNED, F_DEEP, F_LINK, F_HIDDEN, F_CLOUD };
