'use strict';
// mpv's JSON IPC over a Windows named pipe: real player commands, not
// simulated keypresses.
//
// The connection stays open and mpv pushes property changes as they happen, so
// the UI is a listener rather than a poller. A synchronous request/reply per
// property means polling a dozen of them a couple of times a second, which is
// both slower and visibly behind the player; this is what makes the panel feel
// attached to the picture rather than reporting on it.

const net = require('net');
const { EventEmitter } = require('events');

const PIPE_PREFIX = '\\\\.\\pipe\\';

class MpvIpc extends EventEmitter {
  constructor(pipeName) {
    super();
    this.path = PIPE_PREFIX + pipeName;
    this.sock = null;
    this.connected = false;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.observed = new Map(); // id -> property name
    this.props = {};
    this.retry = null;
  }

  connect() {
    if (this.sock || this.connected) return;
    const sock = net.connect({ path: this.path });
    this.sock = sock;

    sock.on('connect', () => {
      this.connected = true;
      this.buf = '';
      this.emit('connect');
    });
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => this._onData(chunk));
    sock.on('error', () => this._drop());
    sock.on('close', () => this._drop());
  }

  // mpv is started alongside us, so the pipe does not exist for the first
  // moment; keep knocking rather than failing the launch.
  connectWithRetry(intervalMs = 250) {
    const tick = () => {
      if (this.connected) return;
      this.connect();
      this.retry = setTimeout(tick, intervalMs);
    };
    tick();
  }

  stopRetry() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  // Public: the renderer's renderer-API switch tears the player down and
  // brings it back, and has to close this end deliberately.
  disconnect() {
    this._drop();
  }

  _drop() {
    const was = this.connected;
    this.connected = false;
    if (this.sock) {
      this.sock.removeAllListeners();
      this.sock.destroy();
    }
    this.sock = null;
    for (const [, p] of this.pending) p.reject(new Error('mpv connection closed'));
    this.pending.clear();
    this.observed.clear();
    if (was) this.emit('disconnect');
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.event === 'property-change') {
      const name = msg.name || this.observed.get(msg.id);
      if (name) {
        this.props[name] = msg.data;
        this.emit('property', name, msg.data);
      }
      return;
    }
    if (msg.event) {
      this.emit('mpv-event', msg);
      return;
    }
    if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
      const p = this.pending.get(msg.request_id);
      this.pending.delete(msg.request_id);
      if (msg.error && msg.error !== 'success') p.reject(new Error(msg.error));
      else p.resolve(msg.data);
    }
  }

  command(args) {
    if (!this.connected) return Promise.reject(new Error('mpv not connected'));
    const id = this.nextId++;
    const line = JSON.stringify({ command: args, request_id: id }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.sock.write(line);
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
      // A reply that never comes must not leak a promise or a Map entry.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('mpv did not answer'));
        }
      }, 4000);
    });
  }

  // Fire-and-forget: nothing in the UI waits on a set to come back.
  send(args) {
    this.command(args).catch(() => {});
  }

  get(prop) {
    return this.command(['get_property', prop]);
  }

  set(prop, value) {
    this.send(['set_property', prop, value]);
  }

  // The Lua side reads settings through its setting() helper, which prefixes
  // "set_" - writing the bare name lands on a property nothing reads.
  setting(name, value) {
    this.set('user-data/mi/set_' + name, String(value));
  }

  userData(name, value) {
    this.set('user-data/mi/' + name, String(value));
  }

  binding(name) {
    this.send(['script-binding', name]);
  }

  scriptMessage(...args) {
    this.send(['script-message', ...args.map(String)]);
  }

  observe(props) {
    for (const name of props) {
      const id = this.nextId++;
      this.observed.set(id, name);
      this.send(['observe_property', id, name]);
    }
  }
}

module.exports = MpvIpc;
