'use strict';
// Line icons, drawn on a 24-unit grid in currentColor so they take the text
// colour of whatever they sit in. Strings, so a cell sets one with a single
// innerHTML when its kind changes and never otherwise.

const ICON_PATHS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  fwd: '<path d="M9 5l7 7-7 7"/>',
  up: '<path d="M12 19V6M6 11l6-6 6 6"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="5" cy="6" r=".8"/><circle cx="5" cy="12" r=".8"/><circle cx="5" cy="18" r=".8"/>',
  preview: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>',
  asc: '<path d="M7 18V5M3.5 8.5L7 5l3.5 3.5"/><path d="M13 7h7M13 12h5M13 17h3"/>',
  desc: '<path d="M7 6v13M3.5 15.5L7 19l3.5-3.5"/><path d="M13 7h3M13 12h5M13 17h7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  drive: '<rect x="3" y="13" width="18" height="6" rx="1.5"/><path d="M5 13l2.5-7h9L19 13"/><circle cx="17" cy="16" r=".8"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
  pictures: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
  videos: '<rect x="3" y="6" width="13" height="12" rx="1.5"/><path d="M16 10l5-3v10l-5-3"/>',
  music: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  downloads: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 19h16"/>',
  exports: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 15v4h16v-4"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="1.5"/><path d="M16 10l5-3v10l-5-3"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
  audio: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  index: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 12l5.5-5.5"/>',
  offline: '<path d="M4 4l16 16"/><path d="M8.5 8.5A5 5 0 0 0 12 17h5a3.5 3.5 0 0 0 2.4-6"/><path d="M14.5 6.4A5 5 0 0 1 17 9.6"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};

function icon(name, cls) {
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ICON_PATHS.file}</svg>`;
}

const KIND_ICON = ['file', 'video', 'photo', 'audio'];
