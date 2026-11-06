const PATHS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  forward: '<path d="M9 18l6-6-6-6"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  stop: '<path d="M6 6l12 12M18 6L6 18"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5S9.6 5.8 12 3.5z"/>',
  star: '<path d="M12 4.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.9l5.4-.8z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a2 2 0 0 0-2 2v6.5A2.5 2.5 0 0 0 6.5 14"/>',
  link: '<path d="M10 13a4.5 4.5 0 0 0 6.4 0l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4L11.4 5"/><path d="M14 11a4.5 4.5 0 0 0-6.4 0L5 13.6a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  settings: '<circle cx="12" cy="12" r="3.1"/><path d="M19.2 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  moon: '<path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  pin: '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z"/><path d="M12 14v7"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 13h9.4l.8-13"/>',
  logout: '<path d="M15 5.5V4a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 5 4v16a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 15 20v-1.5"/><path d="M10 12h11M18 8.5l3.5 3.5L18 15.5"/>',
  shield: '<path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><path d="M9.2 12.2l1.9 1.9 3.8-4"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  user: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13h.01M9.5 13h.01M13 13h.01M16.5 13h.01M7.5 16h9"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  bolt: '<path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z"/>',
  activity: '<path d="M3 12h3.6l2.4-6.2 3.6 12.4 2.4-6.2H21"/>',
  camera: '<path d="M4 8.5h3.2l1.5-2.2h6.6l1.5 2.2H20V19H4z"/><circle cx="12" cy="13.4" r="3.2"/>',
  expand: '<path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/>',
  volume: '<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M15 8.5a5 5 0 0 1 0 7"/><path d="M17.7 6a8.5 8.5 0 0 1 0 12"/>',
  volumeX: '<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
};

export const icon = (name, size = 18, extraClass = '') =>
  `<svg class="icon ${extraClass}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name] || ''}</svg>`;

export const starIcon = (filled, size = 18) =>
  `<svg class="icon star-icon ${filled ? 'is-filled' : ''}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS.star}</svg>`;

export const brandMark = (size = 26) => `
<svg class="brand-mark" viewBox="0 0 32 32" width="${size}" height="${size}" fill="none" aria-hidden="true" focusable="false">
  <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="9" stroke="currentColor" stroke-opacity="0.22"/>
  <path d="M10.6 9.8h3.3l4.1 10.4 4.1-10.4h1.7l-5 13.2h-3.6z" fill="currentColor"/>
</svg>`;

export const monogram = (label, seed, size = 18) => {
  let hash = 0;
  const text = String(seed || label || '?');
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 360;
  }
  const letter = String(label || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="monogram" style="--mono-h:${hash};--mono-size:${size}px" aria-hidden="true">${letter}</span>`;
};
