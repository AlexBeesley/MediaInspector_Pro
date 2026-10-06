'use strict';
// Plain-Node checks of the indexer: no Electron needed. Builds a small tree in
// a temp folder, crawls it, searches it, changes it, and round-trips the file.
//   node test/run.js            correctness
//   node test/run.js --bench N  also time a synthetic index of N entries

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Indexer } = require('../indexer/core');
const { Store, parseQuery } = require('../indexer/store');
const { listDir } = require('../indexer/fsscan');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-test-'));
const data = path.join(tmp, 'data');
const tree = path.join(tmp, 'tree');

function touch(p, bytes = 10) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('ok   ', name);
  } catch (e) {
    failures++;
    console.log('FAIL ', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      '));
  }
}

function waitFor(cond, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function main() {
  touch(path.join(tree, 'Holiday 2023', 'beach 1.jpg'));
  touch(path.join(tree, 'Holiday 2023', 'beach 10.jpg'));
  touch(path.join(tree, 'Holiday 2023', 'beach 2.jpg'));
  touch(path.join(tree, 'Holiday 2023', 'clip.MP4', ), 5000);
  touch(path.join(tree, 'Holiday 2023', 'notes.txt'));
  touch(path.join(tree, 'Music', 'Album', 'track 01.flac'), 3000);
  touch(path.join(tree, 'Music', 'Album', 'cover.png'));
  touch(path.join(tree, 'node_modules', 'pkg', 'skip.jpg'));
  touch(path.join(tree, '.hidden', 'secret.jpg'));
  touch(path.join(tree, 'top.mov'), 20000);

  await check('listDir reads names, kinds and sizes', () => {
    const l = listDir(path.join(tree, 'Holiday 2023'));
    assert.strictEqual(l.n, 5);
    const i = l.names.indexOf('clip.MP4');
    assert.ok(i >= 0);
    assert.strictEqual(l.sizes[i], 5000);
  });

  await check('parseQuery operators', () => {
    const q = parseQuery('beach ext:jpg,png size:>1mb -draft "two words" video: path:holiday after:2023');
    assert.deepStrictEqual(q.terms, ['beach', 'two words']);
    assert.deepStrictEqual(q.not, ['draft']);
    assert.ok(q.exts.has('jpg') && q.exts.has('png'));
    assert.strictEqual(q.minSize, 1e6);
    assert.ok(q.kinds.has(1));
    assert.deepStrictEqual(q.paths, ['holiday']);
    assert.ok(q.after > 0);
  });

  const events = [];
  const ix = new Indexer({ dataDir: data, threads: 2, emit: (e, d) => events.push([e, d]) });
  ix.init();

  await check('browse an unindexed folder', async () => {
    const r = await ix.list({ path: path.join(tree, 'Holiday 2023') });
    assert.ok(!r.error, r.error);
    // media only by default: notes.txt is filtered out
    assert.deepStrictEqual(r.rows.map((x) => x.name), ['beach 1.jpg', 'beach 2.jpg', 'beach 10.jpg', 'clip.MP4']);
    const all = await ix.list({ path: path.join(tree, 'Holiday 2023'), show: 'all' });
    assert.strictEqual(all.ids.length, 5);
  });

  await check('missing folder is an error, not a crash', async () => {
    const r = await ix.list({ path: path.join(tree, 'nope') });
    assert.strictEqual(r.error, 'missing');
  });

  await check('index a location and search it', async () => {
    ix.addRoot({ path: tree });
    await waitFor(() => ix.roots[0].status === 'idle' && ix.roots[0].lastScan > 0);
    const r = ix.search({ q: 'beach' });
    assert.strictEqual(r.ids.length, 3);
    // node_modules is not crawled; hidden is hidden
    assert.strictEqual(ix.search({ q: 'skip' }).ids.length, 0);
    assert.strictEqual(ix.search({ q: 'secret' }).ids.length, 0);
    assert.strictEqual(ix.search({ q: 'secret', hidden: true }).ids.length, 1);
    assert.strictEqual(ix.search({ q: 'video:' }).ids.length, 2);
    assert.strictEqual(ix.search({ q: 'size:>4kb' }).ids.length, 2);
    assert.strictEqual(ix.search({ q: 'path:music cover' }).ids.length, 1);
    assert.strictEqual(ix.search({ q: 'beach', scope: path.join(tree, 'Music') }).ids.length, 0);
    const album = ix.search({ q: 'album' });
    assert.strictEqual(album.rows[0].name, 'Album');
    assert.ok(album.rows[0].dir);
    assert.ok(ix.roots[0].files >= 9, JSON.stringify(ix.roots[0]));
  });

  await check('relevance: exact and prefix before substring', async () => {
    touch(path.join(tree, 'x', 'my clip.mp4'));
    touch(path.join(tree, 'x', 'clip.mov'));
    touch(path.join(tree, 'x', 'clipboard.mp4'));
    await ix.list({ path: path.join(tree, 'x') });
    const names = ix.search({ q: 'clip' }).rows.map((r) => r.name);
    assert.strictEqual(names.indexOf('clip.mov') < names.indexOf('clipboard.mp4'), true, names.join());
    assert.strictEqual(names.indexOf('clipboard.mp4') < names.indexOf('my clip.mp4'), true, names.join());
  });

  await check('a revisit picks up a new file', async () => {
    const dir = path.join(tree, 'Holiday 2023');
    touch(path.join(dir, 'beach 3.jpg'));
    fs.unlinkSync(path.join(dir, 'beach 10.jpg'));
    ix.lastRead.clear();
    events.length = 0;
    await ix.list({ path: dir });
    await waitFor(() => events.some(([e]) => e === 'changed'));
    const r = await ix.list({ path: dir, cached: true });
    assert.deepStrictEqual(r.rows.map((x) => x.name), ['beach 1.jpg', 'beach 2.jpg', 'beach 3.jpg', 'clip.MP4']);
    assert.strictEqual(ix.search({ q: 'beach 10' }).ids.length, 0);
  });

  await check('sorting by size and date', async () => {
    const r = await ix.list({ path: tree, sort: 'size', desc: true, cached: true });
    const files = r.rows.filter((x) => !x.dir);
    assert.strictEqual(files[0].name, 'top.mov');
    assert.ok(r.rows[0].dir, 'folders first');
  });

  await check('folder rows carry a cover', async () => {
    const r = await ix.list({ path: tree, cached: true });
    const h = r.rows.find((x) => x.name === 'Holiday 2023');
    assert.ok(h.cover && h.cover.path.endsWith('beach 1.jpg'), JSON.stringify(h.cover));
  });

  await check('save and load round-trip', async () => {
    ix.store.version++;
    const bytes = ix.flush();
    assert.ok(bytes > 0);
    const { store, meta } = Store.load(ix.file);
    assert.strictEqual(meta.roots[0].path, tree);
    assert.strictEqual(store.live, ix.store.live);
    assert.strictEqual(store.search('beach', {}).length, 3);
    assert.strictEqual(store.pathOf(store.idOfPath(path.join(tree, 'Music', 'Album'), false)), path.join(tree, 'Music', 'Album'));
  });

  await check('remove a location forgets its contents', async () => {
    ix.removeRoot({ path: tree });
    assert.strictEqual(ix.search({ q: 'track' }).ids.length, 0);
    assert.strictEqual(ix.roots.length, 0);
  });

  await check('revalidating crawl re-reads only what changed (posix)', async () => {
    if (process.platform === 'win32') return;
    ix.addRoot({ path: tree });
    await waitFor(() => ix.roots[0] && ix.roots[0].status === 'idle' && ix.roots[0].lastScan > 0);
    touch(path.join(tree, 'Music', 'Album', 'track 02.flac'));
    let reads = 0;
    const orig = ix.handle.bind(ix);
    ix.handle = (job, res) => { if (res.listing) { reads++; if (process.env.DBG) console.log('read', job.path, job.ifMtime); } return orig(job, res); };
    ix.roots[0].lastScan = 0;
    ix.startCrawl(tree, true);
    await waitFor(() => ix.roots[0].status === 'idle' && ix.roots[0].lastScan > 0);
    ix.handle = orig;
    assert.strictEqual(ix.search({ q: 'track 02' }).ids.length, 1);
    // the top is always read, plus the folder that changed
    assert.ok(reads <= 2, 'read ' + reads + ' folders');
  });

  await ix.close();

  const bench = process.argv.indexOf('--bench');
  if (bench > 0) runBench(+process.argv[bench + 1] || 1000000);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

// A synthetic index the size of a big media drive, built straight into the
// store, to time the operations a user waits on.
function runBench(n) {
  const words = ['img', 'dsc', 'vid', 'holiday', 'beach', 'party', 'family', 'trip', 'raw', 'export', 'final', 'edit', 'clip', 'gopro', 'drone'];
  const exts = ['jpg', 'jpg', 'jpg', 'png', 'mp4', 'mov', 'cr2', 'mp3', 'txt', 'xmp'];
  const s = new Store();
  const top = s.idOfPath(s.win ? 'C:\\' : '/', true);
  let t = performance.now();
  const dirs = [top];
  for (let i = 0; i < n; i++) {
    if (i % 200 === 0) dirs.push(s.add(dirs[(Math.random() * dirs.length) | 0], words[i % words.length] + ' ' + i, 1, 0, 0));
    const name = words[(Math.random() * words.length) | 0] + '_' + ((Math.random() * 99999) | 0) + '.' + exts[i % exts.length];
    s.add(dirs[dirs.length - 1], name, 0, Math.random() * 1e8, Date.now() - Math.random() * 1e11);
  }
  console.log(`\nbench: built ${s.live.toLocaleString()} entries in ${(performance.now() - t).toFixed(0)}ms`);
  t = performance.now(); s.ensureBlob(); console.log(`bench: search text built in ${(performance.now() - t).toFixed(0)}ms`);
  for (const q of ['beach', 'gopro 12', 'dsc_4', 'video:', 'ext:cr2 size:>50mb', 'zzzz']) {
    t = performance.now();
    const r = s.search(q, {});
    console.log(`bench: search ${JSON.stringify(q).padEnd(22)} ${String(r.length).padStart(8)} hits in ${(performance.now() - t).toFixed(1)}ms`);
  }
  t = performance.now();
  const r = s.search('beach', {});
  s.sortIds(r, 'name', false);
  console.log(`bench: sort ${r.length} hits by name in ${(performance.now() - t).toFixed(0)}ms`);
  const file = path.join(tmp, 'bench.bin');
  t = performance.now(); const bytes = s.save(file); console.log(`bench: saved ${(bytes / 1e6).toFixed(1)}MB in ${(performance.now() - t).toFixed(0)}ms`);
  t = performance.now(); const { store } = Store.load(file); console.log(`bench: loaded ${store.live.toLocaleString()} entries in ${(performance.now() - t).toFixed(0)}ms`);
  const big = dirs[dirs.length - 1];
  t = performance.now(); s.list(big, { show: 'all' }); console.log(`bench: list a folder in ${(performance.now() - t).toFixed(2)}ms`);
  console.log(`bench: heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)}MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
