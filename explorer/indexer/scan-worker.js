'use strict';
// One scanning thread. It is handed batches of folders and sends back their
// listings; it keeps no state of its own, so any number can run side by side
// and the indexer decides how many a disk can take.

const { parentPort } = require('worker_threads');
const { listDir, dirMtime } = require('./fsscan');

parentPort.on('message', (batch) => {
  const out = [];
  const transfer = [];
  for (const job of batch.jobs) {
    // A revalidation pass can skip a folder whose own date has not moved:
    // nothing was added, removed or renamed in it.
    // The date is taken before the read, so a change landing mid-read leaves
    // the stored date stale and the next pass reads it again, never the reverse.
    let m;
    if (job.stamp || job.ifMtime !== undefined) {
      m = dirMtime(job.path);
      if (job.ifMtime !== undefined && m >= 0 && m === job.ifMtime) {
        out.push({ dir: job.dir, unchanged: true });
        continue;
      }
    }
    const l = listDir(job.path);
    if (l.error) {
      out.push({ dir: job.dir, error: l.error });
      continue;
    }
    out.push({ dir: job.dir, listing: l, mtime: m });
    transfer.push(l.flags.buffer, l.sizes.buffer, l.mtimes.buffer);
  }
  parentPort.postMessage({ batch: batch.id, results: out }, transfer);
});
