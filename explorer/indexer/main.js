'use strict';
// Entry point of the indexer's utility process.
//
// The Electron main process starts this and then gets out of the way: the
// window is handed a MessagePort straight to it, so listings, searches and the
// rows behind them never pass through the main process at all. The parent port
// carries only lifecycle (init, flush) and the few questions main itself asks.

const { Indexer } = require('./core');

let indexer = null;
const ports = new Set();

function emit(event, data) {
  for (const p of ports) {
    try { p.postMessage({ event, data }); } catch (e) { ports.delete(p); }
  }
}

function serve(port) {
  ports.add(port);
  port.on('message', async (e) => {
    const { rid, op, args } = e.data || {};
    try {
      const result = await indexer.op(op, args || {});
      port.postMessage({ rid, result });
    } catch (err) {
      port.postMessage({ rid, error: String(err && err.message || err) });
    }
  });
  port.on('close', () => ports.delete(port));
  port.start();
}

process.parentPort.on('message', async (e) => {
  const msg = e.data || {};
  if (msg.type === 'init') {
    indexer = new Indexer({ dataDir: msg.dataDir, threads: msg.threads, emit });
    const info = indexer.init();
    process.parentPort.postMessage({ type: 'ready', info });
  } else if (msg.type === 'port') {
    serve(e.ports[0]);
  } else if (msg.type === 'call') {
    // Main's own questions (thumbnail pre-builds), answered on the same pipe.
    let result = null;
    let error = null;
    try { result = await indexer.op(msg.op, msg.args || {}); } catch (err) { error = String(err.message || err); }
    process.parentPort.postMessage({ type: 'reply', rid: msg.rid, result, error });
  } else if (msg.type === 'flush') {
    if (indexer) await indexer.close();
    process.parentPort.postMessage({ type: 'flushed' });
  }
});
