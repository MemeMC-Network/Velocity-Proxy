const SETTINGS_KEY = 'velocity.settings.v1';
const SHORTCUTS_KEY = 'velocity.shortcuts.v1';

export const DEFAULT_SHORTCUTS = [
  { title: 'YouTube', url: 'https://www.youtube.com/' },
  { title: 'Google', url: 'https://www.google.com/' },
  { title: 'GitHub', url: 'https://github.com/' },
  { title: 'Reddit', url: 'https://www.reddit.com/' },
  { title: 'Wikipedia', url: 'https://en.wikipedia.org/' },
  { title: 'Discord', url: 'https://discord.com/app' },
  { title: 'TikTok', url: 'https://www.tiktok.com/' },
  { title: 'Hacker News', url: 'https://news.ycombinator.com/' },
];

const read = (key, fallback) => {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const write = (key, value) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage disabled */
  }
};

const defaults = {
  theme: 'dark',
  engine: 'google',
  customTemplate: '',
  quality: 62,
  volume: 0.8,
  muted: false,
  zoom: 1,
};

export const state = {
  settings: { ...defaults, ...read(SETTINGS_KEY, {}) },
  shortcuts: Array.isArray(read(SHORTCUTS_KEY, null)) ? read(SHORTCUTS_KEY, []) : DEFAULT_SHORTCUTS.slice(),
  tabs: new Map(),
  order: [],
  activeId: null,
  history: [],
  engines: [
    { id: 'google', name: 'Google' },
    { id: 'duckduckgo', name: 'DuckDuckGo' },
    { id: 'bing', name: 'Bing' },
    { id: 'brave', name: 'Brave' },
    { id: 'startpage', name: 'Startpage' },
  ],
  limits: { maxTabs: 12 },
  connection: 'connecting',
  latency: null,
  version: null,
};

export const saveSettings = () => write(SETTINGS_KEY, state.settings);

export const saveShortcuts = () => write(SHORTCUTS_KEY, state.shortcuts);

export const engineName = (id = state.settings.engine) =>
  state.engines.find((engine) => engine.id === id)?.name || 'Custom';

export const engineSearchTemplate = (id = state.settings.engine) => {
  if (id === 'custom') return state.settings.customTemplate || 'https://www.google.com/search?q=%s';
  return (
    state.engines.find((engine) => engine.id === id)?.search ||
    'https://www.google.com/search?q=%s'
  );
};

export const orderedTabs = () => {
  const tabs = state.order.map((id) => state.tabs.get(id)).filter(Boolean);
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
};

export const activeTab = () => (state.activeId ? state.tabs.get(state.activeId) || null : null);

export const upsertTab = (tab) => {
  if (!tab || typeof tab.id !== 'string') return null;
  const previous = state.tabs.get(tab.id);
  const merged = { ...previous, ...tab };
  state.tabs.set(tab.id, merged);
  if (!state.order.includes(tab.id)) state.order.push(tab.id);
  return merged;
};

export const removeTab = (id) => {
  state.tabs.delete(id);
  state.order = state.order.filter((value) => value !== id);
  if (state.activeId === id) state.activeId = null;
};

export const setActiveId = (id) => {
  state.activeId = id;
};

export const tabIndex = (id) => orderedTabs().findIndex((tab) => tab.id === id);

export const shortcutHost = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export const findShortcut = (url) => {
  if (!url) return null;
  const normalized = normalizeUrl(url);
  return state.shortcuts.find((item) => normalizeUrl(item.url) === normalized) || null;
};

export const normalizeUrl = (url) => String(url || '').replace(/\/+$/, '').toLowerCase();

export const addShortcut = (title, url) => {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;
  if (state.shortcuts.some((item) => normalizeUrl(item.url) === normalized)) return false;
  state.shortcuts = [{ title: title || shortcutHost(url), url }, ...state.shortcuts].slice(0, 24);
  saveShortcuts();
  return true;
};

export const updateShortcut = (index, title, url) => {
  if (!state.shortcuts[index]) return;
  state.shortcuts[index] = { title, url };
  saveShortcuts();
};

export const removeShortcut = (index) => {
  state.shortcuts.splice(index, 1);
  saveShortcuts();
};

export const historyFor = (limit = 8) =>
  [...state.history].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, limit);

export const frequentSites = (limit = 8) => {
  const byHost = new Map();
  for (const entry of state.history) {
    const host = entry.host || shortcutHost(entry.url);
    if (!host) continue;
    const current = byHost.get(host) || { host, url: entry.url, title: entry.title, visits: 0, ts: 0 };
    current.visits += entry.visits || 1;
    if ((entry.ts || 0) > current.ts) {
      current.ts = entry.ts || 0;
      current.url = entry.url;
      current.title = entry.title;
    }
    byHost.set(host, current);
  }
  return [...byHost.values()].sort((a, b) => b.visits - a.visits).slice(0, limit);
};
