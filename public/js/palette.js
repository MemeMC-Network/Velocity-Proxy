import { icon } from './icons.js';
import { orderedTabs, state } from './store.js';
import { prettyHost, timeAgo } from './ui.js';

const hostOf = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return prettyHost(url);
  }
};

const dom = {};
let actions = {};
let entries = [];
let selection = 0;
let initialized = false;

/** Cheap fuzzy score: direct substring first, then subsequence with gap penalty. */
const score = (text, query) => {
  const haystack = String(text || '').toLowerCase();
  const needle = String(query || '').toLowerCase();
  if (!needle) return 0;
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return 2000 - direct - haystack.length;
  let cursor = 0;
  let gaps = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return -1;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return 400 - gaps;
};

const commands = () => [
  { label: 'New tab', meta: 'Open a fresh tab', icon: 'plus', hint: 'Ctrl T', keywords: 'create open add', run: () => actions.newTab?.() },
  { label: 'Reopen closed tab', meta: 'Restore the last closed page', icon: 'back', hint: 'Ctrl ⇧ T', keywords: 'undo restore', run: () => actions.reopenClosed?.() },
  { label: 'Find in page', meta: 'Highlight and step through matches', icon: 'search', hint: 'Ctrl F', keywords: 'search text highlight', run: () => actions.findInPage?.() },
  { label: 'Keyboard shortcuts', meta: 'Every shortcut in one place', icon: 'keyboard', hint: 'Ctrl /', keywords: 'keys help cheatsheet', run: () => actions.shortcuts?.() },
  { label: 'Reload page', icon: 'reload', hint: 'Ctrl R', keywords: 'refresh', run: () => actions.reload?.() },
  { label: 'Back', icon: 'back', hint: 'Alt ←', keywords: 'history previous', run: () => actions.goBack?.() },
  { label: 'Forward', icon: 'forward', hint: 'Alt →', keywords: 'history next', run: () => actions.goForward?.() },
  { label: 'Go home', icon: 'home', keywords: 'new tab page start', run: () => actions.goHome?.() },
  { label: 'Copy destination URL', icon: 'link', keywords: 'clipboard address link', run: () => actions.copyUrl?.() },
  { label: 'Bookmark this page', icon: 'star', hint: 'Ctrl D', keywords: 'shortcut save tile', run: () => actions.bookmark?.() },
  { label: 'Zoom in', icon: 'search', hint: 'Ctrl +', keywords: 'larger magnify', run: () => actions.zoomIn?.() },
  { label: 'Zoom out', icon: 'search', hint: 'Ctrl −', keywords: 'smaller shrink', run: () => actions.zoomOut?.() },
  { label: 'Reset zoom', icon: 'search', hint: 'Ctrl 0', keywords: '100 percent', run: () => actions.resetZoom?.() },
  { label: 'Toggle fullscreen', icon: 'expand', hint: 'F11', keywords: 'immersive window', run: () => actions.toggleFullscreen?.() },
  { label: 'Capture screenshot', icon: 'camera', keywords: 'save image jpeg page', run: () => actions.screenshot?.() },
  { label: 'Mute or unmute audio', icon: 'volume', keywords: 'sound volume', run: () => actions.toggleMute?.() },
  { label: 'Switch theme', icon: 'sun', keywords: 'dark light appearance', run: () => actions.toggleTheme?.() },
  { label: 'Activity', meta: 'Memory, browsers and pages', icon: 'activity', keywords: 'system resources cpu ram', run: () => actions.openSystem?.() },
  { label: 'Release idle browsers', meta: 'Free Chromium processes with no visitors', icon: 'activity', keywords: 'memory ram cleanup free', run: () => actions.releaseIdle?.() },
  { label: 'Settings', icon: 'settings', keywords: 'preferences options engine quality', run: () => actions.openSettings?.() },
];

const collect = (query) => {
  const value = String(query || '').trim();
  const tabs = orderedTabs().map((tab) => ({
    label: tab.title || prettyHost(tab.host) || 'New tab',
    meta: tab.url ? prettyHost(tab.host) : 'New tab',
    icon: tab.loading ? 'reload' : 'grid',
    keywords: `${tab.title || ''} ${tab.url || ''}`,
    dedupe: tab.url ? `url:${tab.url}` : null,
    run: () => actions.activateTab?.(tab.id),
  }));

  const history = state.history.slice(0, 80).map((entry) => ({
    label: entry.title || entry.url,
    meta: `${prettyHost(entry.host)}${entry.ts ? ` · ${timeAgo(entry.ts)}` : ''}`,
    icon: 'clock',
    keywords: entry.url,
    dedupe: `url:${entry.url}`,
    run: () => actions.navigate?.(entry.url),
  }));

  const shortcuts = state.shortcuts.map((shortcut) => ({
    label: shortcut.title || prettyHost(shortcut.url),
    meta: hostOf(shortcut.url),
    icon: 'star',
    keywords: shortcut.url,
    dedupe: `url:${shortcut.url}`,
    run: () => actions.navigate?.(shortcut.url),
  }));

  const sources = [
    { name: 'Tabs', items: tabs },
    { name: 'History', items: history },
    { name: 'Shortcuts', items: shortcuts },
    { name: 'Commands', items: commands() },
  ];

  const seen = new Set();
  const out = [];
  let counter = 0;
  for (const source of sources) {
    const available = source.items.filter((item) => {
      if (!item.dedupe) return true;
      return !seen.has(item.dedupe);
    });
    let matched = available;
    if (value) {
      matched = available
        .map((item) => ({ item, rank: score(`${item.label} ${item.meta || ''} ${item.keywords || ''}`, value) }))
        .filter((entry) => entry.rank >= 0)
        .sort((a, b) => b.rank - a.rank)
        .map((entry) => entry.item);
    }
    const limit = value ? 5 : source.name === 'Commands' ? 6 : 5;
    const shown = matched.slice(0, limit);
    if (!shown.length) continue;
    out.push({ header: source.name });
    for (const item of shown) {
      if (item.dedupe) seen.add(item.dedupe);
      out.push({ item, index: counter });
      counter += 1;
    }
  }
  return out;
};

const paint = () => {
  const rows = dom.results.querySelectorAll('.palette-row');
  for (const row of rows) {
    const selected = Number(row.dataset.index) === selection;
    row.classList.toggle('is-selected', selected);
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) row.scrollIntoView({ block: 'nearest' });
  }
};

const updateHint = (count) => {
  if (!dom.footHint) return;
  dom.footHint.textContent = count ? `${count} result${count === 1 ? '' : 's'}` : 'No matches';
};

const render = () => {
  if (!dom.results) return;
  dom.results.innerHTML = '';
  let count = 0;
  for (const entry of entries) {
    if (entry.header) {
      const header = document.createElement('div');
      header.className = 'palette-group';
      header.textContent = entry.header;
      dom.results.appendChild(header);
      continue;
    }
    const { item } = entry;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'palette-row';
    row.dataset.index = String(entry.index);
    row.setAttribute('role', 'option');
    row.innerHTML = `
      <span class="palette-row-icon">${icon(item.icon || 'arrowRight', 15)}</span>
      <span class="palette-row-text"><strong></strong>${item.meta ? '<span></span>' : ''}</span>
      ${item.hint ? `<kbd>${item.hint}</kbd>` : ''}
    `;
    row.querySelector('strong').textContent = item.label;
    const meta = row.querySelector('.palette-row-text span');
    if (meta) meta.textContent = item.meta;
    row.addEventListener('pointermove', () => {
      if (selection === entry.index) return;
      selection = entry.index;
      paint();
    });
    row.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      run(entry.index);
    });
    dom.results.appendChild(row);
    count += 1;
  }

  if (!count) {
    const empty = document.createElement('div');
    empty.className = 'palette-empty';
    empty.textContent = dom.input?.value.trim() ? 'Nothing matches that search' : 'No tabs, history or commands yet';
    dom.results.appendChild(empty);
  }

  selection = Math.min(Math.max(0, selection), Math.max(0, count - 1));
  paint();
  updateHint(count);
};

const run = (index) => {
  const entry = entries.find((candidate) => candidate.item && candidate.index === index);
  if (!entry) return;
  const { item } = entry;
  closePalette();
  item.run?.();
};

const move = (delta) => {
  const count = entries.filter((entry) => entry.item).length;
  if (!count) return;
  selection = (selection + delta + count) % count;
  paint();
};

export const initPalette = (options = {}) => {
  if (options.actions) actions = options.actions;
  if (initialized) return;
  initialized = true;
  dom.layer = document.getElementById('palette-layer');
  dom.input = document.getElementById('palette-input');
  dom.results = document.getElementById('palette-results');
  dom.mark = document.getElementById('palette-mark');
  dom.footHint = document.getElementById('palette-foot-hint');
  if (!dom.layer || !dom.input || !dom.results) return;
  if (dom.mark) dom.mark.innerHTML = icon('search', 16);

  dom.layer.addEventListener('pointerdown', (event) => {
    if (event.target === dom.layer) closePalette();
  });

  dom.input.addEventListener('input', () => {
    selection = 0;
    entries = collect(dom.input.value);
    render();
  });

  dom.input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      selection = 0;
      paint();
    } else if (event.key === 'End') {
      event.preventDefault();
      selection = Math.max(0, entries.filter((entry) => entry.item).length - 1);
      paint();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(selection);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePalette();
    } else if (event.key === 'Tab') {
      event.preventDefault();
    }
  });
};

export const openPalette = () => {
  if (!initialized) initPalette();
  if (!dom.layer) return;
  dom.input.value = '';
  entries = collect('');
  selection = 0;
  dom.layer.hidden = false;
  render();
  requestAnimationFrame(() => dom.input.focus());
};

export const closePalette = () => {
  if (!initialized || !dom.layer || dom.layer.hidden) return false;
  dom.layer.hidden = true;
  dom.input.value = '';
  dom.input.blur();
  entries = [];
  selection = 0;
  dom.results.innerHTML = '';
  return true;
};
