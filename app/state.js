'use strict';
// Panel state: window bounds, the divide between cards and picture, and every
// card setting, as JSON so nested groups (the colour sliders, the shader list)
// do not have to be flattened into key=value.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  win: null,                 // {x, y, width, height, maximized}
  panelWidth: 0,             // 0 = derive it from the media's shape
  autoPanel: true,
  fitWindow: true,
  exportDir: '',
  exportFormat: 'jpg',
  exportScale: '100',
  exportScaler: 'lanczos',
  upscaleMode: 'Off',
  upscaleFactor: '2',
  rtxHdr: false,
  scaler: 'ewa_lanczos4sharpest',
  dscaler: 'mitchell',
  renderApi: 'D3D11 (RTX VSR)',
  shaders: [],
  look: {},
};

class State {
  constructor(file) {
    this.file = file;
    // Structured clone, not Object.assign: `shaders` and `look` are mutated in
    // place, and a shallow copy would edit DEFAULTS itself.
    this.data = structuredClone(DEFAULTS);
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      Object.assign(this.data, JSON.parse(raw));
    } catch (e) {
      /* first run, or a file someone edited into nonsense: defaults stand */
    }
    return this.data;
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.saveSoon();
  }

  merge(obj) {
    Object.assign(this.data, obj);
    this.saveSoon();
  }

  // Settings change on every slider drag; coalesce the writes.
  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 400);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      /* nothing here is worth interrupting playback for */
    }
  }
}

// The player writes its own half of the session (last file, UI scale, browse
// scope); this is the one field the shell needs back out of it.
function lastFileFrom(statePlayerJson) {
  try {
    const raw = fs.readFileSync(statePlayerJson, 'utf8');
    const m = raw.match(/"file"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return null;
    const file = JSON.parse('"' + m[1] + '"');
    return fs.existsSync(file) ? file : null;
  } catch (e) {
    return null;
  }
}

module.exports = { State, lastFileFrom, DEFAULTS };
