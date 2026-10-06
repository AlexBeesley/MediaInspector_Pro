'use strict';
// What counts as media, by extension. Mirrors the tables at the top of
// config/scripts/mediainspector.lua so the explorer shows exactly the files the
// player will step through - keep the two in step.
//
// Kinds are small integers because they live in a Uint8Array column of the
// index, one byte per file, millions of files.

const KIND = { OTHER: 0, VIDEO: 1, PHOTO: 2, AUDIO: 3 };
const KIND_NAME = ['other', 'video', 'photo', 'audio'];

const VIDEO = [
  'mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'wmv', 'flv', 'mpg', 'mpeg',
  'm2ts', 'mts', 'ts', 'm2v', 'vob', '3gp', '3g2', 'ogv', 'ogm', 'mxf',
  'asf', 'rm', 'rmvb', 'divx', 'f4v', 'y4m', 'gif', 'apng', 'dv', 'amv',
  'nut', 'roq', 'h264', 'h265', 'hevc', 'av1', 'ivf',
];

const PHOTO = [
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'bmp', 'webp', 'tif', 'tiff',
  'heic', 'heif', 'avif', 'jxl', 'jp2', 'j2k', 'jpf', 'jxr', 'tga',
  'targa', 'exr', 'hdr', 'pic', 'dds', 'ppm', 'pgm', 'pbm', 'pnm', 'pam',
  'pcx', 'sgi', 'xbm', 'xpm', 'ico', 'cur', 'qoi',
  // camera raw
  'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf',
  'rw2', 'pef', 'raw', '3fr', 'erf', 'kdc', 'mos', 'mrw', 'x3f',
];

const AUDIO = [
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'm4b', 'ogg', 'oga', 'opus', 'wma',
  'aiff', 'aif', 'aifc', 'alac', 'ape', 'wv', 'mka', 'dsf', 'dff', 'ac3',
  'eac3', 'dts', 'dtshd', 'thd', 'mp2', 'mpa', 'spx', 'tta', 'caf', 'au',
  'amr', 'awb', 'gsm', 'shn', 'mpc', 'ra', 'voc', 'w64', '8svx', 'aa3',
  'oma', 'mid', 'midi',
];

const KIND_OF_EXT = new Map();
for (const e of VIDEO) KIND_OF_EXT.set(e, KIND.VIDEO);
for (const e of PHOTO) KIND_OF_EXT.set(e, KIND.PHOTO);
for (const e of AUDIO) KIND_OF_EXT.set(e, KIND.AUDIO);

// What Chromium decodes itself, so a thumbnail can be made in a worker
// without a process spawn. Everything else goes to the OS or to mpv/ffmpeg.
const BROWSER_DECODES = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'bmp', 'webp', 'gif', 'avif', 'ico', 'cur']);

// Video Chromium can play in the preview pane. Anything else previews as its
// thumbnail and opens in the player.
const BROWSER_PLAYS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv']);

function extOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  const e = name.slice(dot + 1);
  return e.length > 8 ? '' : e.toLowerCase();
}

function kindOf(name) {
  return KIND_OF_EXT.get(extOf(name)) || KIND.OTHER;
}

module.exports = { KIND, KIND_NAME, KIND_OF_EXT, BROWSER_DECODES, BROWSER_PLAYS, extOf, kindOf };
