'use strict';
// Reading one directory, as fast as the platform allows.
//
// On Windows that means FindFirstFileExW with FIND_FIRST_EX_LARGE_FETCH, called
// through koffi: one call hands back name, attributes, size and modification
// time together, in large batches from the filesystem. The portable route -
// readdir and then a stat per file - costs a second syscall for every file and
// is several times slower on a cold NTFS volume. The record is read straight
// out of a reused Buffer rather than decoded into an object per file.
//
// Everywhere else (and on Windows if koffi will not load) it is readdir with
// file types, plus a stat only where a size or date is worth having: media
// files and directories. Other files get size -1 and show as "-".

const fs = require('fs');
const path = require('path');
const { kindOf, KIND } = require('../lib/media');

// Listing flags, per entry. The store keeps its own flag byte; these are only
// what the scanner learned.
const L_DIR = 1;
const L_LINK = 2;     // junction / symlink: listed, never descended into
const L_HIDDEN = 4;
const L_CLOUD = 8;    // OneDrive-style placeholder: reading it would download it

// A listing is columnar so it crosses the worker boundary as a handful of
// buffers rather than thousands of objects.
function makeListing(cap) {
  return {
    n: 0,
    names: [],
    flags: new Uint8Array(cap),
    sizes: new Float64Array(cap),
    mtimes: new Float64Array(cap),
  };
}

function grow(l) {
  const cap = l.flags.length * 2;
  const f = new Uint8Array(cap); f.set(l.flags); l.flags = f;
  const s = new Float64Array(cap); s.set(l.sizes); l.sizes = s;
  const m = new Float64Array(cap); m.set(l.mtimes); l.mtimes = m;
}

function push(l, name, flags, size, mtime) {
  if (l.n === l.flags.length) grow(l);
  l.names.push(name);
  l.flags[l.n] = flags;
  l.sizes[l.n] = size;
  l.mtimes[l.n] = mtime;
  l.n++;
}

// Trim the typed arrays to length so only the used part is copied across.
function finish(l) {
  return {
    n: l.n,
    names: l.names,
    flags: l.flags.slice(0, l.n),
    sizes: l.sizes.slice(0, l.n),
    mtimes: l.mtimes.slice(0, l.n),
  };
}

// ---------------------------------------------------------------- win32

let win = null;

function loadWin32() {
  if (win !== null) return win;
  win = false;
  if (process.platform !== 'win32') return win;
  try {
    const koffi = require('koffi');
    const k32 = koffi.load('kernel32.dll');
    // HANDLE comes back as int64: INVALID_HANDLE_VALUE is -1, and real handles
    // fit in a double on x64. The find data is a raw Buffer we parse ourselves.
    win = {
      first: k32.func('int64 __stdcall FindFirstFileExW(str16 name, int level, void *data, int op, void *filter, uint32 flags)'),
      next: k32.func('bool __stdcall FindNextFileW(int64 h, void *data)'),
      close: k32.func('bool __stdcall FindClose(int64 h)'),
      attrs: k32.func('uint32 __stdcall GetFileAttributesW(str16 name)'),
      buf: Buffer.alloc(592),
    };
  } catch (e) {
    win = false;
  }
  return win;
}

// \\?\ lifts MAX_PATH, so deep trees and long camera-import names still list.
function longPath(p) {
  if (p.startsWith('\\\\?\\')) return p;
  if (p.startsWith('\\\\')) return '\\\\?\\UNC\\' + p.slice(2);
  return '\\\\?\\' + p;
}

const FA_HIDDEN = 0x2;
const FA_SYSTEM = 0x4;
const FA_DIRECTORY = 0x10;
const FA_REPARSE = 0x400;
const FA_OFFLINE = 0x1000;
const FA_RECALL_ON_OPEN = 0x40000;
const FA_RECALL_ON_DATA = 0x400000;
const INVALID_ATTRS = 0xFFFFFFFF;

// FILETIME is 100ns ticks since 1601; JS wants ms since 1970.
const EPOCH_DIFF_MS = 11644473600000;

function listWin32(dir) {
  const w = win;
  const buf = w.buf;
  const pattern = longPath(dir.endsWith('\\') ? dir + '*' : dir + '\\*');
  // FindExInfoBasic (1) skips the 8.3 name; LARGE_FETCH (2) asks for bigger
  // batches per kernel call.
  const h = w.first(pattern, 1, buf, 0, null, 2);
  if (h == -1) { // eslint-disable-line eqeqeq
    // Tell a vanished folder from a locked one: the UI says different things.
    const a = w.attrs(longPath(dir));
    return { error: a === INVALID_ATTRS ? 'missing' : 'denied' };
  }
  const l = makeListing(256);
  try {
    do {
      // cFileName starts at byte 44, NUL-terminated UTF-16.
      let end = 44;
      while (end < 564 && (buf[end] | buf[end + 1]) !== 0) end += 2;
      const name = buf.toString('utf16le', 44, end);
      if (name === '.' || name === '..') continue;
      const attrs = buf.readUInt32LE(0);
      // desktop.ini, Thumbs.db and friends: hidden *and* system is the OS
      // saying "not for people".
      if ((attrs & (FA_HIDDEN | FA_SYSTEM)) === (FA_HIDDEN | FA_SYSTEM)) continue;
      let f = 0;
      if (attrs & FA_DIRECTORY) f |= L_DIR;
      if (attrs & FA_REPARSE) f |= L_LINK;
      if (attrs & FA_HIDDEN) f |= L_HIDDEN;
      if (attrs & (FA_OFFLINE | FA_RECALL_ON_OPEN | FA_RECALL_ON_DATA)) f |= L_CLOUD;
      const ft = buf.readUInt32LE(24) * 4294967296 + buf.readUInt32LE(20);
      const mtime = ft / 10000 - EPOCH_DIFF_MS;
      const size = (f & L_DIR) ? 0 : buf.readUInt32LE(28) * 4294967296 + buf.readUInt32LE(32);
      push(l, name, f, size, mtime);
    } while (w.next(h, buf));
  } finally {
    w.close(h);
  }
  return finish(l);
}

// ---------------------------------------------------------------- portable

function errCode(e) {
  return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'missing' : 'denied';
}

function listPortable(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { error: errCode(e) };
  }
  const l = makeListing(Math.max(16, ents.length));
  const posix = process.platform !== 'win32';
  for (const d of ents) {
    const name = d.name;
    let f = 0;
    if (posix && name.charCodeAt(0) === 46) f |= L_HIDDEN; // dotfile
    let isDir = d.isDirectory();
    const isLink = d.isSymbolicLink();
    let size = -1;
    let mtime = 0;
    const full = path.join(dir, name);
    if (isLink) {
      f |= L_LINK;
      try {
        const st = fs.statSync(full);
        isDir = st.isDirectory();
        size = isDir ? 0 : st.size;
        mtime = st.mtimeMs;
      } catch (e) {
        continue; // dangling link
      }
    } else if (isDir || kindOf(name) !== KIND.OTHER) {
      // Directories need their mtime (it is how a revisit skips unchanged
      // folders); media needs size and date for the grid and the thumbnail key.
      try {
        const st = fs.statSync(full);
        size = isDir ? 0 : st.size;
        mtime = st.mtimeMs;
      } catch (e) {
        continue; // vanished between readdir and stat
      }
    } else if (!d.isFile()) {
      continue; // sockets, fifos, devices
    }
    if (isDir) f |= L_DIR;
    push(l, name, f, size, mtime);
  }
  return finish(l);
}

function listDir(dir) {
  if (process.platform === 'win32' && loadWin32()) {
    try {
      return listWin32(dir);
    } catch (e) {
      /* fall through to the portable path */
    }
  }
  return listPortable(dir);
}

// The cheap question asked before re-reading a folder on platforms where a
// folder's mtime reliably moves when an entry is added, removed or renamed.
function dirMtime(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch (e) {
    return -1;
  }
}

module.exports = { listDir, dirMtime, L_DIR, L_LINK, L_HIDDEN, L_CLOUD, nativeScanner: () => !!loadWin32() };
