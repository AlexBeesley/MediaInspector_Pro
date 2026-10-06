'use strict';
// The page's only way out. Two channels: `mx` for the main process (menus,
// opening files, places), and a MessagePort straight to the indexer, which is
// passed into the page's world as soon as it arrives.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mx', {
  invoke: (name, payload) => ipcRenderer.invoke('mx', name, payload),
  drag: (files) => ipcRenderer.send('drag', files),
  on: (channel, cb) => ipcRenderer.on(channel, (e, data) => cb(data)),
  pathForFile: (file) => webUtils.getPathForFile(file),
});

// A MessagePort cannot cross contextBridge, but it can be transferred with
// window.postMessage into the page's own world.
// Held until the page's own scripts have run, or the message would arrive
// before anything is listening for it.
ipcRenderer.on('index-port', (e) => {
  const send = () => window.postMessage('mx-index-port', '*', e.ports);
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', send, { once: true });
  else send();
});
ipcRenderer.send('want-port');
