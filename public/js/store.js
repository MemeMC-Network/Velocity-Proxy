const SETTINGS_KEY = 'velocity.settings.v1';
const SHORTCUTS_KEY = 'velocity.shortcuts.v1';
const BOOKMARKS_KEY = 'velocity.bookmarks.v1';
const LAYOUT_KEY = 'velocity.layout.v1';
const SPACES_KEY = 'velocity.spaces.v1';

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
  accent: 'ember',
  engine: 'google',
  customTemplate: '',
  quality: 62,
  volume: 0.8,
  muted: false,
  zoom: 1,
  startup: 'restore',
  homeClock: true,
  homeGreeting: true,
  homeRecent: true,
  homeFrequent: true,
  homeBookmarks: true,
  homeBg: 'none',
  homeBgUrl: '',
  homeImage: '',
  bookmarksBar: true,
  bookmarksNewTab: false,
  tabGroups: true,
  tabCloseAlways: false,
  reduceMotion: false,
  historyEnabled: true,
  audioAutostart: true,
};

const layoutDefaults = { order: [], groups: {}, titles: {} };

const readLayout = () => {
  const raw = read(LAYOUT_KEY, null);
  if (!raw) return { ...layoutDefaults };
  return {
    order: Array.isArray(raw.order) ? raw.order.filter((id) => typeof id === 'string') : [],
    groups: raw.groups && typeof raw.groups === 'object' ? raw.groups : {},
    titles: raw.titles && typeof raw.titles === 'object' ? raw.titles : {},
  };
};

const readBookmarks = () => {
  const raw = read(BOOKMARKS_KEY, null);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item.url === 'string')
    .map((item, index) => ({
      id: typeof item.id === 'string' ? item.id : `bm-${index}-${Date.now()}`,
      title: typeof item.title === 'string' ? item.title : item.url,
      url: item.url,
      folder: typeof item.folder === 'string' ? item.folder : '',
      createdAt: Number(item.createdAt) || Date.now(),
    }));
};

export const state = {
  settings: { ...defaults, ...read(SETTINGS_KEY, {}) },
  shortcuts: Array.isArray(read(SHORTCUTS_KEY, null)) ? read(SHORTCUTS_KEY, []) : DEFAULT_SHORTCUTS.slice(),
  bookmarks: readBookmarks(),
  layout: readLayout(),
  spaces: (() => {
    const raw = read(SPACES_KEY, null);
    return Array.isArray(raw) ? raw.filter((space) => space && Array.isArray(space.tabs)) : [];
  })(),
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

export const saveBookmarks = () => write(BOOKMARKS_KEY, state.bookmarks);

export const saveLayout = () => write(LAYOUT_KEY, state.layout);

export const saveSpaces = () => write(SPACES_KEY, state.spaces);

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
  const rank = (tab) => {
    const index = state.layout.order.indexOf(tab.id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const byLayout = (a, b) => rank(a) - rank(b) || state.order.indexOf(a.id) - state.order.indexOf(b.id);
  return [...tabs.filter((tab) => tab.pinned).sort(byLayout), ...tabs.filter((tab) => !tab.pinned).sort(byLayout)];
};

/* --------------------------------------------------------------- bookmarks */

export const bookmarkId = () => `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const normalizeBookmarkUrl = (url) => normalizeUrl(url);

export const findBookmark = (url) =>
  url ? state.bookmarks.find((item) => normalizeBookmarkUrl(item.url) === normalizeBookmarkUrl(url)) || null : null;

export const addBookmark = ({ title, url, folder = '' }) => {
  if (!url || findBookmark(url)) return null;
  const bookmark = { id: bookmarkId(), title: title || shortcutHost(url), url, folder, createdAt: Date.now() };
  state.bookmarks = [bookmark, ...state.bookmarks];
  saveBookmarks();
  return bookmark;
};

export const updateBookmark = (id, patch) => {
  const bookmark = state.bookmarks.find((item) => item.id === id);
  if (!bookmark) return null;
  Object.assign(bookmark, patch);
  saveBookmarks();
  return bookmark;
};

export const removeBookmark = (id) => {
  const before = state.bookmarks.length;
  state.bookmarks = state.bookmarks.filter((item) => item.id !== id);
  if (state.bookmarks.length !== before) saveBookmarks();
};

export const reorderBookmarks = (ids) => {
  const byId = new Map(state.bookmarks.map((item) => [item.id, item]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const rest = state.bookmarks.filter((item) => !ids.includes(item.id));
  state.bookmarks = [...ordered, ...rest];
  saveBookmarks();
};

export const bookmarkFolders = () =>
  [...new Set(state.bookmarks.map((item) => item.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/* ------------------------------------------------------------- tab layout */

export const GROUP_COLORS = ['#e3b183', '#a9c6a3', '#93b8e8', '#b6a6ef', '#d98b8b', '#8fbfa0'];

export const groupsList = () =>
  Object.values(state.layout.groups).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

export const groupOfTab = (tabId) => {
  const groupId = state.layout.groups && Object.keys(state.layout.groups).find(
    (id) => Array.isArray(state.layout.groups[id].tabs) && state.layout.groups[id].tabs.includes(tabId),
  );
  return groupId ? state.layout.groups[groupId] : null;
};

export const createGroup = (name, color) => {
  const id = `grp-${Date.now().toString(36)}`;
  state.layout.groups[id] = {
    id,
    name: name || 'Group',
    color: color || GROUP_COLORS[groupsList().length % GROUP_COLORS.length],
    collapsed: false,
    tabs: [],
    createdAt: Date.now(),
  };
  saveLayout();
  return state.layout.groups[id];
};

export const assignTabToGroup = (tabId, groupId) => {
  for (const group of Object.values(state.layout.groups)) {
    group.tabs = (group.tabs || []).filter((id) => id !== tabId);
  }
  if (groupId && state.layout.groups[groupId]) {
    state.layout.groups[groupId].tabs.push(tabId);
  }
  saveLayout();
};

export const removeGroup = (groupId) => {
  delete state.layout.groups[groupId];
  saveLayout();
};

export const toggleGroupCollapsed = (groupId) => {
  const group = state.layout.groups[groupId];
  if (!group) return;
  group.collapsed = !group.collapsed;
  saveLayout();
};

export const pruneLayout = (ids) => {
  const live = new Set(ids);
  let changed = false;
  state.layout.order = state.layout.order.filter((id) => live.has(id));
  for (const id of Object.keys(state.layout.titles)) {
    if (!live.has(id)) {
      delete state.layout.titles[id];
      changed = true;
    }
  }
  for (const group of Object.values(state.layout.groups)) {
    const next = (group.tabs || []).filter((id) => live.has(id));
    if (next.length !== (group.tabs || []).length) {
      group.tabs = next;
      changed = true;
    }
  }
  if (changed) saveLayout();
};

export const setTabOrder = (ids) => {
  state.layout.order = [...ids];
  saveLayout();
};

export const setTabTitle = (tabId, title) => {
  if (title) state.layout.titles[tabId] = title;
  else delete state.layout.titles[tabId];
  saveLayout();
};

export const tabDisplayTitle = (tab, fallback) =>
  (tab && state.layout.titles[tab.id]) || fallback || (tab ? tab.title : '') || 'New Tab';

/* ---------------------------------------------------------------- spaces */

export const saveSpace = (name, tabs) => {
  if (!name || !tabs.length) return null;
  const space = {
    id: `space-${Date.now().toString(36)}`,
    name: name.slice(0, 60),
    createdAt: Date.now(),
    tabs: tabs.slice(0, 20).map((tab) => ({ url: tab.url || tab.lastUrl || '', title: tab.title || '' })).filter((tab) => tab.url),
  };
  state.spaces = [space, ...state.spaces].slice(0, 20);
  saveSpaces();
  return space;
};

export const removeSpace = (id) => {
  state.spaces = state.spaces.filter((space) => space.id !== id);
  saveSpaces();
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
