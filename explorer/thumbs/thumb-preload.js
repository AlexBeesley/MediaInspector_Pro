'use strict';
// The hidden thumbnail window's bridge. It has Node (sandbox off) for two
// things only: reading a file's bytes without routing them through the main
// process, and the OS thumbnailer, which on Windows runs synchronously - here
// it blocks this hidden page, never the main process or the window you see.

const { contextBridge, ipcRenderer, nativeImage } = require('electron');
const fs = require('fs');

const canShell = !!(nativeImage && typeof nativeImage.createThumbnailFromPath === 'function')
  && (process.platform === 'win32' || process.platform === 'darwin');

contextBridge.exposeInMainWorld('tn', {
  canShell,
  onJob: (cb) => ipcRenderer.on('job', (e, job) => cb(job)),
  done: (jid, data, err) => ipcRenderer.send('thumb-done', { jid, data, err }),
  ready: () => ipcRenderer.send('thumb-ready', { canShell }),
  read: async (p) => {
    const b = await fs.promises.readFile(p);
    return new Uint8Array(b.buffer, b.byteOffset, b.length);
  },
  shell: async (p, w) => {
    const img = await nativeImage.createThumbnailFromPath(p, { width: w, height: w });
    if (!img || img.isEmpty()) throw new Error('empty');
    return new Uint8Array(img.toJPEG(82));
  },
});
