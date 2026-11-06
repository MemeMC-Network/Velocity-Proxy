import { icon, brandMark } from './icons.js';
import {
  engineName,
  frequentSites,
  historyFor,
  orderedTabs,
  removeShortcut,
  saveSettings,
  saveShortcuts,
  state,
  updateShortcut,
} from './store.js';
import { createSuggester, faviconNode, menu, prettyHost, timeAgo, toast } from './ui.js';

let navigate = () => {};
let activateTab = () => {};
let shortcutEditingIndex = -1;
let clockTimer = null;
const dom = {};

export const initHome = ({ onNavigate, onActivateTab }) => {
  navigate = onNavigate || (() => {});
  activateTab = onActivateTab || (() => {});

  dom.newtab = document.getElementById('newtab');
  dom.shortcuts = document.getElementById('shortcuts');
  dom.continueSection = document.getElementById('continue-section');
  dom.continueList = document.getElementById('continue');
  dom.continueCount = document.getElementById('continue-count');
  dom.recent = document.getElementById('recent');
  dom.recentCount = document.getElementById('recent-count');
  dom.frequent = document.getElementById('frequent');
  dom.input = document.getElementById('nt-input');
  dom.suggest = document.getElementById('nt-suggest');
  dom.form = document.getElementById('nt-search');
  dom.engineChip = document.getElementById('engine-chip');
  dom.engineName = document.getElementById('engine-name');
  dom.greeting = document.getElementById('greeting');
  dom.clock = document.getElementById('nt-clock');
  dom.date = document.getElementById('nt-date');
  dom.brand = document.getElementById('nt-brand');
  dom.modal = document.getElementById('shortcut-modal');
  dom.modalTitle = document.getElementById('shortcut-modal-title');
  dom.modalName = document.getElementById('shortcut-name');
  dom.modalUrl = document.getElementById('shortcut-url');
  dom.modalSave = document.getElementById('shortcut-save');
  dom.modalCancel = document.getElementById('shortcut-cancel');

  if (dom.brand && !dom.brand.dataset.ready) {
    dom.brand.innerHTML = `${brandMark(26)}<span class="nt-brand-text">Velocity<em>Proxy</em></span>`;
    dom.brand.dataset.ready = '1';
  }

  createSuggester({
    input: dom.input,
    panel: dom.suggest,
    onSubmit: (value, options) => {
      if (!value.trim()) return;
      resetHomeInput();
      navigate(value, options);
    },
    getPrefixItems: () =>
      frequentSites(4).map((site) => ({
        type: 'history',
        label: site.title || site.host,
        hint: site.host,
        value: site.url,
      })),
  });

  dom.form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = dom.input.value.trim();
    if (!value) return;
    resetHomeInput();
    navigate(value);
  });

  dom.engineChip?.addEventListener('click', () => {
    const rect = dom.engineChip.getBoundingClientRect();
    const engines = [...state.engines, { id: 'custom', name: 'Custom…' }];
    menu.open(
      rect.left,
      rect.bottom + 8,
      engines.map((engine) => ({
        label: engine.name,
        icon: engine.id === state.settings.engine ? 'check' : 'search',
        onSelect: () => {
          state.settings.engine = engine.id;
          saveSettings();
          onEngineChanged();
          if (engine.id === 'custom') {
            document.getElementById('settings-btn')?.click();
          }
        },
      })),
    );
  });

  dom.modalCancel?.addEventListener('click', closeShortcutModal);
  dom.modalSave?.addEventListener('click', saveShortcutModal);
  dom.modalName?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveShortcutModal();
  });
  dom.modalUrl?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveShortcutModal();
  });
  dom.modal?.addEventListener('pointerdown', (event) => {
    if (event.target === dom.modal) closeShortcutModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dom.modal && !dom.modal.hidden) closeShortcutModal();
  });

  refreshHome();
  startClock();
};

const onEngineChanged = () => {
  dom.engineName.textContent = state.settings.engine === 'custom' ? 'Custom' : engineName();
  updatePlaceholder();
  document.dispatchEvent(new CustomEvent('velocity:settings', { detail: { key: 'engine' } }));
};

const resetHomeInput = () => {
  if (!dom.input) return;
  dom.input.value = '';
  dom.input.blur();
  if (dom.suggest) dom.suggest.hidden = true;
};

export const updatePlaceholder = () => {
  if (!dom.input) return;
  const name = state.settings.engine === 'custom' ? 'Custom' : engineName();
  dom.input.placeholder = `Search ${name} or enter an address`;
};

export const refreshHome = () => {
  if (!dom.shortcuts) return;
  dom.engineName.textContent = state.settings.engine === 'custom' ? 'Custom' : engineName();
  updatePlaceholder();
  renderContinue();
  renderShortcuts();
  renderRecent();
  renderFrequent();
};

/* ------------------------------------------------------------------ continue */

const renderContinue = () => {
  if (!dom.continueSection || !dom.continueList) return;
  const tabs = orderedTabs().filter((tab) => tab.url || tab.lastUrl);
  dom.continueSection.hidden = tabs.length === 0;
  dom.continueList.innerHTML = '';
  if (dom.continueCount) dom.continueCount.textContent = tabs.length ? `${tabs.length} open` : '';

  for (const tab of tabs.slice(0, 6)) {
    const target = tab.url || tab.lastUrl;
    const host = prettyHost(tab.host || safeHost(target));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'continue-row';
    const fav = document.createElement('span');
    fav.className = 'site-fav';
    fav.appendChild(faviconNode(tab.favicon || (host ? `/api/favicon?host=${encodeURIComponent(host)}` : null), host, 18));
    const text = document.createElement('span');
    text.className = 'site-text';
    const title = document.createElement('strong');
    title.textContent = (tab.url ? tab.title : tab.lastTitle) || tab.title || host || 'New tab';
    const meta = document.createElement('span');
    meta.textContent = host;
    text.append(title, meta);
    const kind = document.createElement('span');
    kind.className = 'continue-kind';
    kind.textContent = tab.url ? (tab.loading ? 'Loading' : 'Open') : 'Resume';
    button.append(fav, text, kind);
    button.addEventListener('click', () => activateTab(tab.id));
    dom.continueList.appendChild(button);
  }
};

/* -------------------------------------------------------------------- recent */

const dayLabel = (timestamp) => {
  const date = new Date(timestamp || 0);
  const now = new Date();
  const startOf = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0 || !timestamp) return 'Earlier';
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
};

const renderRecent = () => {
  if (!dom.recent) return;
  const entries = historyFor(14);
  dom.recent.innerHTML = '';
  if (dom.recentCount) dom.recentCount.textContent = entries.length ? `${entries.length} visits` : '';

  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'site-empty';
    empty.textContent = 'Pages you open will show up here, grouped by day.';
    dom.recent.appendChild(empty);
    return;
  }

  let label = '';
  for (const entry of entries) {
    const next = dayLabel(entry.ts);
    if (next !== label) {
      label = next;
      const heading = document.createElement('li');
      heading.className = 'site-day';
      heading.textContent = label;
      dom.recent.appendChild(heading);
    }
    dom.recent.appendChild(siteRow(entry));
  }
};

const siteRow = (entry) => {
  const host = entry.host || safeHost(entry.url);
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'site-row';
  const favWrap = document.createElement('span');
  favWrap.className = 'site-fav';
  favWrap.appendChild(faviconNode(`/api/favicon?host=${encodeURIComponent(host)}`, prettyHost(host), 18));
  const text = document.createElement('span');
  text.className = 'site-text';
  const title = document.createElement('strong');
  title.textContent = entry.title || prettyHost(host);
  const meta = document.createElement('span');
  meta.textContent = `${prettyHost(host)}${entry.visits > 1 ? ` · ${entry.visits} visits` : entry.ts ? ` · ${timeAgo(entry.ts)}` : ''}`;
  text.append(title, meta);
  const arrow = document.createElement('span');
  arrow.className = 'site-open';
  arrow.innerHTML = icon('arrowRight', 15);
  button.append(favWrap, text, arrow);
  button.addEventListener('click', () => navigate(entry.url));
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    menu.open(event.clientX, event.clientY, [
      { label: 'Open', icon: 'arrowRight', onSelect: () => navigate(entry.url) },
      { label: 'Copy link', icon: 'link', onSelect: () => copyText(entry.url) },
    ]);
  });
  item.appendChild(button);
  return item;
};

const renderFrequent = () => {
  if (!dom.frequent) return;
  dom.frequent.innerHTML = '';
  const sites = frequentSites(8);
  if (!sites.length) {
    const empty = document.createElement('p');
    empty.className = 'freq-empty';
    empty.textContent = 'Visit a few sites and the ones you return to will appear here.';
    dom.frequent.appendChild(empty);
    return;
  }
  for (const site of sites) {
    const host = prettyHost(site.host);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'freq-chip';
    chip.title = site.url;
    chip.appendChild(faviconNode(`/api/favicon?host=${encodeURIComponent(site.host)}`, host, 14));
    const label = document.createElement('span');
    label.textContent = host;
    chip.appendChild(label);
    chip.addEventListener('click', () => navigate(site.url));
    dom.frequent.appendChild(chip);
  }
};

/* ----------------------------------------------------------------- shortcuts */

const renderShortcuts = () => {
  dom.shortcuts.innerHTML = '';
  state.shortcuts.forEach((shortcut, index) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.title = shortcut.url;
    const iconWrap = document.createElement('span');
    iconWrap.className = 'tile-icon';
    const host = prettyHost(safeHost(shortcut.url));
    iconWrap.appendChild(faviconNode(`/api/favicon?host=${encodeURIComponent(safeHost(shortcut.url) || '')}`, host, 24));
    const label = document.createElement('span');
    label.className = 'tile-label';
    label.textContent = shortcut.title || host;
    tile.append(iconWrap, label);
    tile.addEventListener('click', () => navigate(shortcut.url));
    tile.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      menu.open(event.clientX, event.clientY, [
        { label: 'Open', icon: 'arrowRight', onSelect: () => navigate(shortcut.url) },
        { label: 'Edit', icon: 'edit', onSelect: () => openShortcutModal(index) },
        { label: 'Copy link', icon: 'link', onSelect: () => copyText(shortcut.url) },
        { separator: true },
        {
          label: 'Remove',
          icon: 'trash',
          danger: true,
          onSelect: () => {
            removeShortcut(index);
            saveShortcuts();
            renderShortcuts();
            toast(`Removed ${shortcut.title}`, { tone: 'info' });
          },
        },
      ]);
    });
    dom.shortcuts.appendChild(tile);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'tile tile-add';
  add.innerHTML = `<span class="tile-icon">${icon('plus', 20)}</span><span class="tile-label">Add shortcut</span>`;
  add.addEventListener('click', () => openShortcutModal(-1));
  dom.shortcuts.appendChild(add);
};

/* ------------------------------------------------------------------- modal */

const openShortcutModal = (index) => {
  shortcutEditingIndex = index;
  const shortcut = state.shortcuts[index];
  dom.modalTitle.textContent = shortcut ? 'Edit shortcut' : 'Add shortcut';
  dom.modalName.value = shortcut?.title || '';
  dom.modalUrl.value = shortcut?.url || '';
  dom.modal.hidden = false;
  requestAnimationFrame(() => dom.modalName.focus());
};

const closeShortcutModal = () => {
  dom.modal.hidden = true;
  shortcutEditingIndex = -1;
};

const saveShortcutModal = () => {
  const wasEditing = shortcutEditingIndex >= 0;
  const title = dom.modalName.value.trim();
  let url = dom.modalUrl.value.trim();
  if (!url) {
    toast('A shortcut needs a URL', { tone: 'warn' });
    return;
  }
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
  } catch {
    toast('That URL is not valid', { tone: 'warn' });
    return;
  }
  const label = title || prettyHost(safeHost(url));
  if (shortcutEditingIndex >= 0) updateShortcut(shortcutEditingIndex, label, url);
  else {
    if (state.shortcuts.some((item) => item.url === url)) {
      toast('That shortcut already exists', { tone: 'warn' });
      return;
    }
    state.shortcuts.push({ title: label, url });
    saveShortcuts();
  }
  renderShortcuts();
  closeShortcutModal();
  toast(wasEditing ? 'Shortcut updated' : 'Shortcut added', { tone: 'success' });
};

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied', { tone: 'success' });
  } catch {
    toast('Clipboard access was blocked', { tone: 'warn' });
  }
};

const safeHost = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

const startClock = () => {
  clearInterval(clockTimer);
  const tick = () => {
    const now = new Date();
    if (dom.clock) {
      dom.clock.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(now);
    }
    if (dom.date) {
      dom.date.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(now);
    }
    if (dom.greeting) {
      const hour = now.getHours();
      dom.greeting.textContent =
        hour < 5 ? 'Good night.' : hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
    }
  };
  tick();
  clockTimer = setInterval(tick, 20000);
};

export const focusHomeSearch = () => {
  dom.input?.focus();
};
