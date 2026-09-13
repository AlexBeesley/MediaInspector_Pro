'use strict';
// Owns the mpv process. The picture is mpv's own window living inside one we
// give it, so the player and the controls share a frame.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PIPE_NAME = 'mediainspector_pro';

function findMpv() {
  const fixed = 'C:\\Program Files\\MPV Player\\mpv.exe';
  if (fs.existsSync(fixed)) return fixed;
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue;
    try {
      const c = path.join(dir.trim(), 'mpv.exe');
      if (fs.existsSync(c)) return c;
    } catch (e) {
      /* an unreadable PATH entry is not worth failing over */
    }
  }
  return null;
}

class Player {
  constructor(configDir) {
    this.configDir = configDir;
    this.proc = null;
    this.exePath = null;
  }

  get alive() {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  // hostHandle is the window mpv should draw into. The config dir carries the
  // project's mpv.conf, input.conf and the Lua script, so the on-video bar,
  // the key bindings and the GPU settings are the same as ever.
  start(hostHandle, file) {
    this.exePath = findMpv();
    if (!this.exePath) return false;

    const args = [
      '--config-dir=' + this.configDir,
      '--wid=' + hostHandle.toString(),
      '--input-ipc-server=\\\\.\\pipe\\' + PIPE_NAME,
      // The host owns window sizing, so the script must not also try to drive
      // it: a child window cannot resize the frame around it.
      '--script-opts=mi-embedded=yes',
    ];
    if (file) args.push(file);

    this.proc = spawn(this.exePath, args, {
      cwd: this.configDir,
      windowsHide: true,
      stdio: 'ignore',
    });
    this.proc.on('exit', () => { this.proc = null; });
    return true;
  }

  async quit(ipc) {
    try {
      if (ipc && ipc.connected) await ipc.command(['quit']);
    } catch (e) {
      /* going away anyway */
    }
    const proc = this.proc;
    if (!proc) return;
    await new Promise((resolve) => {
      const kill = setTimeout(() => {
        try { proc.kill(); } catch (e) { /* already gone */ }
        resolve();
      }, 1500);
      proc.once('exit', () => { clearTimeout(kill); resolve(); });
    });
  }
}

module.exports = { Player, findMpv, PIPE_NAME };
