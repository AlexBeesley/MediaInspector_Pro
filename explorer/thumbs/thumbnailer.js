'use strict';
// Runs in a hidden window. Main hands it jobs; it answers with encoded bytes.
//
// Decoding happens in Web Workers, so several images are decoded at once and
// none of it is on this page's thread. The worker is made from a Blob URL
// because a page loaded from file:// cannot start a worker from a file URL.

function workerMain() {
  self.onmessage = async (e) => {
    const { id, bytes, w, type } = e.data;
    try {
      // EXIF orientation is applied by default, so portrait phone photos
      // come out upright.
      const bmp = await createImageBitmap(new Blob([bytes]));
      const s = Math.min(1, w / Math.max(bmp.width, bmp.height));
      const tw = Math.max(1, Math.round(bmp.width * s));
      const th = Math.max(1, Math.round(bmp.height * s));
      const c = new OffscreenCanvas(tw, th);
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, tw, th);
      bmp.close();
      const blob = await c.convertToBlob({ type, quality: 0.82 });
      const buf = await blob.arrayBuffer();
      self.postMessage({ id, buf }, [buf]);
    } catch (err) {
      self.postMessage({ id, err: String(err && err.message || err) });
    }
  };
}

const src = URL.createObjectURL(new Blob(['(' + workerMain.toString() + ')()'], { type: 'text/javascript' }));
const COUNT = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) >> 1));
const workers = [];
const pending = new Map();
let seq = 0;

for (let i = 0; i < COUNT; i++) {
  const wk = new Worker(src);
  wk.load = 0;
  wk.onmessage = (e) => {
    wk.load--;
    const p = pending.get(e.data.id);
    pending.delete(e.data.id);
    if (p) p(e.data);
  };
  workers.push(wk);
}

function decode(bytes, w, type) {
  const wk = workers.reduce((a, b) => (b.load < a.load ? b : a));
  wk.load++;
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    wk.postMessage({ id, bytes, w, type }, [bytes.buffer]);
  });
}

tn.onJob(async (job) => {
  try {
    if (job.kind === 'shell') {
      tn.done(job.jid, await tn.shell(job.path, job.w), null);
      return;
    }
    const bytes = await tn.read(job.path);
    const r = await decode(bytes, job.w, job.type);
    if (r.err) tn.done(job.jid, null, r.err);
    else tn.done(job.jid, new Uint8Array(r.buf), null);
  } catch (e) {
    tn.done(job.jid, null, String(e && e.message || e));
  }
});

tn.ready();
