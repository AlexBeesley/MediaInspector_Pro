'use strict';
// The renderer talks to the player through this and nothing else: no Node in
// the page, one narrow surface, every call named after what it does.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mi', {
  cmd: (...args) => ipcRenderer.send('mpv', { kind: 'command', args }),
  set: (prop, value) => ipcRenderer.send('mpv', { kind: 'set', prop, value }),
  setting: (name, value) => ipcRenderer.send('mpv', { kind: 'setting', name, value }),
  binding: (name) => ipcRenderer.send('mpv', { kind: 'binding', name }),
  scriptMessage: (...args) => ipcRenderer.send('mpv', { kind: 'script-message', args }),
  keypress: (key) => ipcRenderer.send('mpv', { kind: 'keypress', key }),

  videoRect: (r) => ipcRenderer.send('video-rect', r),
  focusVideo: () => ipcRenderer.send('focus-video'),

  // Electron 32 removed File.path; this is the supported way to learn where
  // a dropped file actually lives.
  pathForFile: (file) => webUtils.getPathForFile(file),

  invoke: (name, payload) => ipcRenderer.invoke('invoke', name, payload),
  on: (channel, cb) => ipcRenderer.on(channel, (e, data) => cb(data)),
});
