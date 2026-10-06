'use strict';
// The grid and the details list: one virtualised view in two layouts.
//
// Only the cells on screen exist. A folder of 200,000 files is 200,000 ids in
// a typed array and a spacer of the right height; scrolling moves a pool of a
// hundred or so cells into place with transforms and refills the ones that
// changed item. No layout is read during a scroll except scrollTop and the
// viewport, so nothing forces the page to reflow mid-frame.
//
// Thumbnails are plain <img> elements pointed at thumb:// URLs. During a fast
// flick, thumbnails the page has not shown before are held back until the
// scroll settles, so the thumbnailer works on what you stopped at rather than
// on everything that flew past; ones already seen are assigned immediately
// because they come from memory.

const GRID_PAD = 10;
const GRID_GAP = 8;
const LABEL_H = 38;
const LIST_ROW = 24;
const FAST_PX_PER_MS = 3;   // above this the scroll counts as a flick

const DATE_FMT = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function fmtSize(n) {
  if (!(n >= 0)) return '';
  if (n < 1000) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1000; i++; } while (n >= 1000 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + ' ' + u[i];
}

function fmtDate(ms, withTime) {
  if (!(ms > 0)) return '';
  return (withTime ? TIME_FMT : DATE_FMT).format(ms);
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 && name.length - i <= 9 ? name.slice(i + 1).toUpperCase() : '';
}

class VirtualView {
  constructor(scroller, spacer, head, hooks) {
    this.sc = scroller;
    this.spacer = spacer;
    this.head = head;
    this.h = hooks;
    this.ids = new Int32Array(0);
    this.n = 0;
    this.mode = 'grid';
    this.thumbPx = 180;
    this.search = false;
    this.cols = 1;
    this.cellW = 0;
    this.cellH = 0;
    this.rowH = 0;
    this.active = new Map();  // index -> cell
    this.free = [];
    this.sel = new Set();     // ids
    this.anchor = -1;
    this.focus = -1;
    this.loaded = new Set();  // thumb URLs that have loaded once: in memory now
    this.raf = 0;
    this.lastY = 0;
    this.lastT = 0;
    this.fast = false;
    this.settleTimer = 0;
    this.byIndex = (idx) => this.ids[idx];

    scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    new ResizeObserver(() => this.layout(true)).observe(scroller);
    this.bindPointer();
  }

  // ------------------------------------------------------------ items

  setItems(ids, opts = {}) {
    const focusId = opts.focusId !== undefined ? opts.focusId : (opts.keep && this.focus >= 0 ? this.ids[this.focus] : -1);
    this.ids = ids;
    this.n = ids.length;
    if (opts.keep) {
      const present = new Set(ids);
      for (const id of this.sel) if (!present.has(id)) this.sel.delete(id);
    } else {
      this.sel.clear();
    }
    this.focus = -1;
    this.anchor = -1;
    if (focusId >= 0) {
      const i = ids.indexOf(focusId);
      if (i >= 0) { this.focus = i; this.anchor = i; if (!opts.keep) this.sel.add(focusId); }
    }
    for (const c of this.active.values()) c.id = -2;   // force a refill
    this.layout(false);
    if (opts.scrollTop !== undefined) this.sc.scrollTop = opts.scrollTop;
    else if (!opts.keep) this.sc.scrollTop = 0;
    if (this.focus >= 0 && opts.reveal) this.reveal(this.focus);
    this.renderNow();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const first = this.firstVisible();
    this.mode = mode;
    for (const c of this.active.values()) c.remove();
    for (const c of this.free) c.remove();
    this.active.clear();
    this.free = [];
    this.layout(false);
    this.scrollToIndex(this.focus >= 0 ? this.focus : first);
    this.renderNow();
  }

  setThumbPx(px) {
    if (px === this.thumbPx) return;
    const keep = this.focus >= 0 && this.isVisible(this.focus) ? this.focus : this.firstVisible();
    this.thumbPx = px;
    if (this.mode !== 'grid') return;
    this.layout(false);
    this.scrollToIndex(keep);
    for (const c of this.active.values()) c.id = -2;
    this.renderNow();
  }

  refresh() {
    for (const c of this.active.values()) c.id = -2;
    this.renderNow();
  }

  // ------------------------------------------------------------ geometry

  layout(fromResize) {
    const W = this.sc.clientWidth;
    const keep = fromResize ? this.firstVisible() : -1;
    if (this.mode === 'grid') {
      const cols = Math.max(1, Math.floor((W - GRID_PAD * 2 + GRID_GAP) / (this.thumbPx + GRID_GAP)));
      this.cols = cols;
      this.cellW = Math.floor((W - GRID_PAD * 2 - GRID_GAP * (cols - 1)) / cols);
      this.boxH = Math.round(this.cellW * 0.75);
      this.cellH = this.boxH + LABEL_H;
      this.rowH = this.cellH + GRID_GAP;
      this.pad = GRID_PAD;
    } else {
      this.cols = 1;
      this.cellW = W;
      this.cellH = LIST_ROW;
      this.rowH = LIST_ROW;
      this.pad = 0;
    }
    this.rows = Math.ceil(this.n / this.cols);
    this.spacer.style.height = (this.rows * this.rowH + this.pad * 2) + 'px';
    for (const [idx, c] of this.active) this.place(c, idx);
    this.sc.classList.toggle('list', this.mode === 'list');
    this.sc.classList.toggle('grid', this.mode === 'grid');
    if (keep >= 0) this.scrollToIndex(keep);
    this.schedule();
  }

  place(c, idx) {
    const col = idx % this.cols;
    const row = (idx - col) / this.cols;
    const x = this.pad + col * (this.cellW + GRID_GAP);
    const y = this.pad + row * this.rowH;
    c.style.transform = `translate(${x}px,${y}px)`;
    if (c.w !== this.cellW || c.hh !== this.cellH) {
      c.w = this.cellW;
      c.hh = this.cellH;
      c.style.width = this.cellW + 'px';
      c.style.height = this.cellH + 'px';
      if (c.tb) c.tb.style.height = this.boxH + 'px';
    }
    c.idx = idx;
  }

  firstVisible() {
    if (!this.rowH) return 0;
    return Math.min(this.n - 1, Math.max(0, Math.floor((this.sc.scrollTop - this.pad) / this.rowH) * this.cols));
  }

  isVisible(idx) {
    const row = Math.floor(idx / this.cols);
    const y = this.pad + row * this.rowH;
    return y >= this.sc.scrollTop && y + this.cellH <= this.sc.scrollTop + this.sc.clientHeight;
  }

  scrollToIndex(idx) {
    if (idx < 0) return;
    const row = Math.floor(idx / this.cols);
    this.sc.scrollTop = Math.max(0, row * this.rowH);
  }

  reveal(idx) {
    if (idx < 0) return;
    const row = Math.floor(idx / this.cols);
    const y = this.pad + row * this.rowH;
    const top = this.sc.scrollTop;
    const h = this.sc.clientHeight;
    if (y < top) this.sc.scrollTop = y - this.pad;
    else if (y + this.cellH > top + h) this.sc.scrollTop = y + this.cellH - h + this.pad;
  }

  visibleRows() {
    return Math.max(1, Math.floor(this.sc.clientHeight / this.rowH));
  }

  // ------------------------------------------------------------ rendering

  onScroll() {
    const now = performance.now();
    const y = this.sc.scrollTop;
    const dt = now - this.lastT;
    if (dt > 0 && dt < 200) this.fast = Math.abs(y - this.lastY) / dt > FAST_PX_PER_MS;
    this.lastY = y;
    this.lastT = now;
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => { this.fast = false; this.schedule(); }, 90);
    this.schedule();
  }

  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.renderNow());
  }

  renderNow() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    const top = this.sc.scrollTop;
    const h = this.sc.clientHeight;
    const over = this.mode === 'grid' ? 1 : 8;
    const r0 = Math.max(0, Math.floor((top - this.pad) / this.rowH) - over);
    const r1 = Math.min(this.rows - 1, Math.floor((top + h - this.pad) / this.rowH) + over);
    const i0 = r0 * this.cols;
    const i1 = Math.min(this.n, (r1 + 1) * this.cols);

    for (const [idx, c] of this.active) {
      if (idx < i0 || idx >= i1) {
        this.active.delete(idx);
        c.style.display = 'none';
        this.free.push(c);
      }
    }
    for (let idx = i0; idx < i1; idx++) {
      let c = this.active.get(idx);
      if (!c) {
        c = this.free.pop() || this.make();
        c.style.display = '';
        this.active.set(idx, c);
        this.place(c, idx);
        c.id = -2;
      }
      this.fill(c, this.ids[idx], idx);
    }

    // Row data for this screen and the next couple, asked for in one go.
    const p0 = Math.max(0, i0 - this.cols * 4);
    const p1 = Math.min(this.n, i1 + (i1 - i0) * 2);
    const need = [];
    for (let i = p0; i < p1; i++) if (!this.h.row(this.ids[i])) need.push(this.ids[i]);
    if (need.length) this.h.need(need);
  }

  make() {
    const c = document.createElement('div');
    c.draggable = true;
    if (this.mode === 'grid') {
      c.className = 'cell';
      c.innerHTML = '<div class="tb"><div class="ph"></div><img decoding="async" draggable="false" alt=""><span class="badge"></span></div><div class="nm"></div><div class="mt"></div>';
      c.tb = c.firstChild;
      c.ph = c.tb.firstChild;
      c.img = c.ph.nextSibling;
      c.badge = c.img.nextSibling;
      c.nm = c.tb.nextSibling;
      c.mt = c.nm.nextSibling;
      c.img.onload = () => { if (c.src) { this.loaded.add(c.src); c.classList.add('ok'); } };
      c.img.onerror = () => { c.classList.remove('ok'); };
    } else {
      c.className = 'row';
      c.innerHTML = '<span class="ki"></span><span class="c-name"></span><span class="c-dir"></span><span class="c-size"></span><span class="c-date"></span><span class="c-type"></span>';
      c.ki = c.firstChild;
      c.cn = c.ki.nextSibling;
      c.cd = c.cn.nextSibling;
      c.cs = c.cd.nextSibling;
      c.ct = c.cs.nextSibling;
      c.cy = c.ct.nextSibling;
    }
    c.kindKey = '';
    c.style.position = 'absolute';
    c.style.left = '0';
    c.style.top = '0';
    this.sc.appendChild(c);
    return c;
  }

  fill(c, id, idx) {
    const row = this.h.row(id);
    const sel = this.sel.has(id);
    if (c.selFlag !== sel) { c.selFlag = sel; c.classList.toggle('sel', sel); }
    const foc = idx === this.focus;
    if (c.focFlag !== foc) { c.focFlag = foc; c.classList.toggle('focus', foc); }
    const ver = row ? row.v : 0;
    if (c.id === id && c.ver === ver) {
      if (this.mode === 'grid' && c.want && c.src !== c.want && !this.fast) this.assign(c);
      return;
    }
    c.id = id;
    c.ver = ver;
    if (this.mode === 'grid') this.fillCell(c, row); else this.fillRow(c, row);
  }

  kindIcon(c, row, target) {
    const key = !row ? 'wait' : row.dir ? 'folder' : KIND_ICON[row.kind] || 'file';
    if (c.kindKey === key) return;
    c.kindKey = key;
    target.innerHTML = key === 'wait' ? '' : icon(key);
    c.dataset.kind = key;
  }

  fillCell(c, row) {
    this.kindIcon(c, row, c.ph);
    if (!row) {
      c.nm.textContent = '';
      c.mt.textContent = '';
      c.badge.textContent = '';
      c.want = null;
      this.assign(c);
      return;
    }
    c.nm.textContent = row.name;
    c.title = row.path;
    if (row.dir) {
      c.badge.textContent = row.count > 0 ? String(row.count) : '';
      c.mt.textContent = this.search ? parentName(row.path) : (row.count >= 0 ? row.count + (row.count === 1 ? ' item' : ' items') : 'Folder');
    } else {
      c.badge.textContent = extOf(row.name);
      c.mt.textContent = this.search ? parentName(row.path) : fmtSize(row.size) + (row.mtime ? ' · ' + fmtDate(row.mtime) : '');
    }
    c.want = this.h.thumb(row, this.thumbPx);
    this.assign(c);
  }

  assign(c) {
    const url = c.want;
    if (c.src === url) return;
    if (url && this.fast && !this.loaded.has(url)) {
      // Held until the flick settles; the cell shows its icon meanwhile.
      if (c.src) { c.img.removeAttribute('src'); c.src = null; c.classList.remove('ok'); }
      return;
    }
    c.src = url;
    if (!url) {
      c.img.removeAttribute('src');
      c.classList.remove('ok');
      return;
    }
    c.classList.toggle('ok', this.loaded.has(url));
    c.img.src = url;
  }

  fillRow(c, row) {
    this.kindIcon(c, row, c.ki);
    if (!row) {
      c.cn.textContent = '';
      c.cd.textContent = '';
      c.cs.textContent = '';
      c.ct.textContent = '';
      c.cy.textContent = '';
      return;
    }
    c.cn.textContent = row.name;
    c.title = row.path;
    // The column is right-to-left so a long path keeps its deep end; the marks
    // stop the bidi algorithm moving the separators to the wrong side.
    c.cd.textContent = this.search ? '\u200E' + parentPath(row.path) + '\u200E' : '';
    c.cs.textContent = row.dir ? (row.count >= 0 ? row.count + ' items' : '') : fmtSize(row.size);
    c.ct.textContent = fmtDate(row.mtime, true);
    c.cy.textContent = row.dir ? 'Folder' : extOf(row.name);
  }

  // ------------------------------------------------------------ selection

  setFocus(idx, how) {
    if (!this.n) return;
    idx = Math.max(0, Math.min(this.n - 1, idx));
    if (how === 'extend' && this.anchor >= 0) {
      this.sel.clear();
      const a = Math.min(this.anchor, idx);
      const b = Math.max(this.anchor, idx);
      for (let i = a; i <= b; i++) this.sel.add(this.ids[i]);
    } else if (how === 'toggle') {
      const id = this.ids[idx];
      if (this.sel.has(id)) this.sel.delete(id); else this.sel.add(id);
      this.anchor = idx;
    } else if (how !== 'keep') {
      this.sel.clear();
      this.sel.add(this.ids[idx]);
      this.anchor = idx;
    }
    this.focus = idx;
    this.reveal(idx);
    this.renderNow();
    this.h.focusChanged(this.ids[idx]);
  }

  selectAll() {
    for (let i = 0; i < this.n; i++) this.sel.add(this.ids[i]);
    this.renderNow();
    this.h.focusChanged(this.focus >= 0 ? this.ids[this.focus] : -1);
  }

  move(key, how) {
    const cols = this.cols;
    let i = this.focus < 0 ? -1 : this.focus;
    const page = this.visibleRows() * cols;
    switch (key) {
      case 'ArrowRight': i = this.mode === 'grid' ? i + 1 : i; break;
      case 'ArrowLeft': i = this.mode === 'grid' ? i - 1 : i; break;
      case 'ArrowDown': i = i < 0 ? 0 : i + cols; break;
      case 'ArrowUp': i = i - cols; break;
      case 'PageDown': i += page; break;
      case 'PageUp': i -= page; break;
      case 'Home': i = 0; break;
      case 'End': i = this.n - 1; break;
      default: return false;
    }
    // Down from the last full row lands on the last item rather than nowhere.
    if (key === 'ArrowDown' && i >= this.n && Math.floor(this.focus / cols) < Math.floor((this.n - 1) / cols)) i = this.n - 1;
    if (i < 0 || i >= this.n) i = Math.max(0, Math.min(this.n - 1, i));
    this.setFocus(i, how);
    return true;
  }

  selectedIds() {
    return [...this.sel];
  }

  // ------------------------------------------------------------ pointer

  bindPointer() {
    const sc = this.sc;
    const cellOf = (e) => {
      const c = e.target.closest('.cell,.row');
      return c && c.parentNode === sc ? c : null;
    };
    // Right button held + wheel zooms (app.js). The context menu therefore
    // waits for the release, and is dropped if the wheel turned meanwhile.
    // Windows sends contextmenu after mouseup, Linux and macOS before it, so
    // both orders are handled.
    this.rmb = false;
    this.rmbUsed = false;
    this.pendingCtx = null;
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 2 || !this.rmb) return;
      this.rmb = false;
      const p = this.pendingCtx;
      this.pendingCtx = null;
      if (p && !this.rmbUsed) this.h.context(p.id, p.e);
    }, true);
    sc.addEventListener('mousedown', (e) => {
      if (e.button === 2) { this.rmb = true; this.rmbUsed = false; }
      if (e.button !== 0 && e.button !== 2) return;
      const c = cellOf(e);
      if (!c) {
        if (e.button === 0 && !e.ctrlKey && !e.shiftKey) { this.sel.clear(); this.renderNow(); this.h.focusChanged(-1); }
        return;
      }
      const id = this.ids[c.idx];
      if (e.button === 2) {
        if (!this.sel.has(id)) this.setFocus(c.idx);
        return;
      }
      // A plain press on something already selected keeps the selection, so
      // a multi-selection can be dragged out; the click below narrows it.
      if (e.shiftKey) this.setFocus(c.idx, 'extend');
      else if (e.ctrlKey || e.metaKey) this.setFocus(c.idx, 'toggle');
      else if (!this.sel.has(id)) this.setFocus(c.idx);
      else { this.focus = c.idx; this.renderNow(); this.h.focusChanged(id); }
    });
    sc.addEventListener('click', (e) => {
      const c = cellOf(e);
      if (!c || e.shiftKey || e.ctrlKey || e.metaKey || e.button !== 0) return;
      if (this.sel.size > 1) this.setFocus(c.idx);
    });
    sc.addEventListener('dblclick', (e) => {
      const c = cellOf(e);
      if (c) this.h.activate(this.ids[c.idx], e);
    });
    sc.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const c = cellOf(e);
      const id = c ? this.ids[c.idx] : -1;
      if (this.rmb) this.pendingCtx = { id, e };
      else if (!this.rmbUsed) this.h.context(id, e);
    });
    sc.addEventListener('dragstart', (e) => {
      const c = cellOf(e);
      e.preventDefault();
      if (!c) return;
      const id = this.ids[c.idx];
      this.h.drag(this.sel.has(id) ? [...this.sel] : [id]);
    });
  }
}

function parentName(p) {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const par = i > 0 ? s.slice(0, i) : s;
  const j = Math.max(par.lastIndexOf('/'), par.lastIndexOf('\\'));
  return 'in ' + (j >= 0 ? par.slice(j + 1) || par : par);
}

function parentPath(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}
