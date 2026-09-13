'use strict';
// The few Win32 calls that embedding mpv needs. mpv draws into a window we
// give it (--wid) but does not resize itself to follow that window, and it
// creates its child disabled on the assumption the host owns all input - so
// the host has to move it and re-enable it. Ported straight from the
// WinForms shell's Player.cs, where all of this was learned the hard way.

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

// HWNDs are declared as uint64 rather than void*: on x64 they travel in the
// same registers, and JS gets a plain BigInt it can compare and store.
const FindWindowExW = user32.func('uint64 FindWindowExW(uint64 parent, uint64 after, str16 cls, str16 title)');
const MoveWindow = user32.func('bool MoveWindow(uint64 hwnd, int x, int y, int w, int h, bool repaint)');
const EnableWindow = user32.func('bool EnableWindow(uint64 hwnd, bool enable)');
const IsWindowEnabled = user32.func('bool IsWindowEnabled(uint64 hwnd)');
const IsWindow = user32.func('bool IsWindow(uint64 hwnd)');
const SetFocus = user32.func('uint64 SetFocus(uint64 hwnd)');
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32 from, uint32 to, bool attach)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(uint64 hwnd, _Out_ uint32 *pid)');
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()');

// An Electron window's handle arrives as an 8-byte buffer.
function handleOf(win) {
  try {
    return win.getNativeWindowHandle().readBigUInt64LE(0);
  } catch (e) {
    return 0n;
  }
}

let cached = 0n;

// mpv's own window, living inside the host window we handed it.
function mpvChild(host) {
  if (cached && IsWindow(cached)) return cached;
  cached = 0n;
  if (!host) return 0n;
  const h = FindWindowExW(host, 0n, 'mpv', null);
  cached = h || 0n;
  return cached;
}

function forgetChild() {
  cached = 0n;
}

// mpv marks its child WS_DISABLED, and Windows skips disabled windows when it
// decides where a click lands - which silently killed every button on mpv's
// own on-video bar. It re-applies the style on some state changes, so this is
// re-asserted rather than done once.
function enableInput(child) {
  if (!child || IsWindowEnabled(child)) return;
  EnableWindow(child, true);
}

function resizeChild(host, width, height) {
  if (width <= 0 || height <= 0) return false;
  const child = mpvChild(host);
  if (!child) return false;
  enableInput(child);
  MoveWindow(child, 0, 0, Math.round(width), Math.round(height), true);
  return true;
}

// Keyboard goes where focus is, and focus starts on the UI - so the player's
// key bindings stay dead until the picture is clicked. SetFocus only reaches
// windows on the caller's input queue and mpv is another process, so its
// thread has to be attached for the length of the call.
function focusVideo(host) {
  const child = mpvChild(host);
  if (!child) return false;
  enableInput(child);

  const pid = [0];
  const mpvThread = GetWindowThreadProcessId(child, pid);
  const self = GetCurrentThreadId();
  if (!mpvThread || mpvThread === self) {
    SetFocus(child);
    return true;
  }
  if (!AttachThreadInput(self, mpvThread, true)) return false;
  try {
    SetFocus(child);
  } finally {
    AttachThreadInput(self, mpvThread, false);
  }
  return true;
}

module.exports = { handleOf, mpvChild, forgetChild, resizeChild, focusVideo };
