import { audioEngine } from './audio.js';
import { api, connection } from './net.js';
import {
  activeTab,
  assignTabToGroup,
  createGroup,
  engineName,
  engineSearchTemplate,
  findBookmark,
  GROUP_COLORS,
  groupOfTab,
  groupsList,
  normalizeUrl,
  orderedTabs,
  pruneLayout,
  removeGroup,
  removeShortcut,
  saveLayout,
  saveSettings,
  saveShortcuts,
  setActiveId,
  setTabOrder,
  setTabTitle,
  state,
  tabDisplayTitle,
  toggleGroupCollapsed,
  upsertTab,
  removeTab,
} from './store.js';
import { brandMark, icon, starIcon } from './icons.js';
import { createSuggester, faviconNode, menu, prettyHost, toast } from './ui.js';
import {
  clearViewport,
  ensureSizePublished,
  focusViewport,
  forwardKey,
  getZoom,
  hasRenderedFrame,
  hideOverlay,
  initViewport,
  isEditableTarget,
  pasteFromClipboard,
  requestedSize,
  requestCopy,
  setActiveTab,
  setZoom,
  showError,
  showLoading,
  toggleFullscreen,
} from './viewport.js';
import { focusHomeSearch, initHome, refreshHome, updatePlaceholder } from './home.js';
import { hideLight, initLightView, showLight } from './light.js';
import { applyThemePreference, closeSettings, initSettings, openSettings, refreshSettings, setTheme } from './settings.js';
import { closePalette, initPalette, openPalette } from './palette.js';
import { initSystem, openSystem } from './system.js';
import {
  closeManagers,
  initLibrary,
  managersOpen,
  openBookmarks,
  openHistory,
  refreshLibrary,
  toggleBookmarkFor,
} from './library.js';

const els = {};
const tabNodes = new Map();
const closedTabs = [];
// Light-engine pages by tab id: the block model is the page, so switching tabs
// does not refetch it.
const lightPages = new Map();
let pendingActivation = null;
let currentDialog = null;
let omniEditing = false;
let pingTimer = null;
let boots = 0;
let dragTabId = null;

/* --------------------------------------------------------------------- boot */

const cacheElements = () => {
  const ids = [
    'app', 'tabs', 'new-tab', 'latency', 'theme-toggle', 'settings-btn',
    'back', 'forward', 'reload', 'home', 'omnibox-form', 'omni-display', 'omni-lock', 'omni-fav',
    'omni-title', 'omni-host', 'omni-input', 'omni-suggest', 'bookmark', 'copy-url', 'progress',
    'newtab', 'shortcuts', 'recent', 'frequent', 'nt-search', 'nt-input', 'nt-suggest', 'engine-chip',
    'engine-name', 'greeting', 'nt-clock', 'nt-date', 'add-shortcut', 'nt-brand',
    'viewer', 'screen', 'ime', 'viewer-overlay',
    'settings-panel', 'settings-backdrop', 'settings-close', 'engine-select', 'custom-template-wrap',
    'custom-template', 'quality-range', 'quality-label', 'clear-history', 'reset-shortcuts', 'logout',
    'version-label', 'context-menu', 'toasts',
    'activity-btn', 'fullscreen-btn', 'audio-btn', 'audio-notice', 'audio-notice-text', 'audio-enable', 'audio-status', 'volume-range', 'audio-mute',
    'login', 'login-form', 'login-password', 'login-error', 'login-submit', 'login-brand',
    'shortcut-modal', 'shortcut-modal-title', 'shortcut-name', 'shortcut-url', 'shortcut-cancel', 'shortcut-save',
    'dialog-modal', 'dialog-title', 'dialog-message', 'dialog-input', 'dialog-cancel', 'dialog-ok',
    'find-bar', 'find-input', 'find-count', 'find-prev', 'find-next', 'find-close', 'find-btn', 'find-glyph',
    'shortcuts-modal', 'shortcuts-close',
    'omni-clear', 'omni-send', 'omni-spinner', 'tab-search-btn', 'bookmarks-btn', 'history-btn',
    'engine-btn', 'light-view', 'light-shell',
    'tabstrip-scroll', 'tab-overflow', 'tab-overflow-count', 'tab-overflow-icon',
  ];
  for (const id of ids) {
    els[id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = document.getElementById(id);
  }

  els.engineBtn?.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab?.url) return;
    switchEngine(tab.engine === 'light' ? 'chromium' : 'light', tab.id);
  });

  initLightView({
    onNavigate: (url) => {
      const tab = activeTab();
      if (!tab || !url) return;
      tab.pendingNavigation = true;
      tab.loading = true;
      upsertTab({ ...tab });
      send({ t: 'nav', tabId: tab.id, input: url, viewport: requestedSize() });
      applyActiveView();
    },
  });

  window.addEventListener('velocity:engine-request', (event) => {
    switchEngine(event.detail?.engine, event.detail?.tabId);
  });
  window.addEventListener('velocity:light-retry', () => {
    const tab = activeTab();
    if (tab?.url) send({ t: 'reload', tabId: tab.id, viewport: requestedSize() });
  });
};

/** Switches one tab between the full browser and the lightweight engine. */
const switchEngine = (engine, tabId = state.activeId) => {
  const tab = tabId ? state.tabs.get(tabId) : null;
  if (!tab?.url) return;
  const next = engine === 'light' ? 'light' : 'chromium';
  tab.engine = next;
  tab.pendingNavigation = true;
  tab.loading = true;
  upsertTab({ ...tab });
  send({ t: 'engine:set', tabId: tab.id, engine: next, viewport: requestedSize() });
  applyActiveView();
};

const send = (message) => {
  if (!connection.isOpen) {
    toast('Not connected to the proxy — reconnecting…', { tone: 'warn' });
    connection.connect();
    return false;
  }
  return connection.send(message);
};

const sendTab = (message) => (state.activeId ? send({ ...message, tabId: state.activeId }) : false);

/* ------------------------------------------------------------------ session */

const loadSession = async () => {
  try {
    const session = await api.get('/api/session');
    applySession(session);
    els.login.hidden = true;
    document.body.classList.remove('is-locked');
    if (connection.status === 'denied' || !connection.isOpen) connection.connect();
    renderAll();
    applyActiveView();
  } catch (error) {
    if (error.status === 401) {
      showLogin();
    } else {
      showLogin('The proxy could not start your session. Is the service running?');
    }
  }
};

const applySession = (session) => {
  state.tabs.clear();
  state.order = [];
  for (const tab of Array.isArray(session.tabs) ? session.tabs : []) upsertTab(tab);
  state.history = Array.isArray(session.history) ? session.history : [];
  if (typeof session.historyEnabled === 'boolean') state.settings.historyEnabled = session.historyEnabled;
  if (Array.isArray(session.engines) && session.engines.length) state.engines = session.engines;
  if (session.limits) state.limits = { ...state.limits, ...session.limits };
  state.version = session.version || state.version;
  pruneLayout(state.order);

  const initial =
    (typeof session.activeTabId === 'string' && state.tabs.has(session.activeTabId) && session.activeTabId) ||
    orderedTabs()[0]?.id ||
    null;
  setActiveId(initial);
  if (session.audio) audioEngine.applyStatus(session.audio);
  if (initial) pendingActivation = initial;
  refreshSettings();
  refreshHome();
};

/* --------------------------------------------------------------- connection */

const wireConnection = () => {
  connection.addEventListener('ready', (event) => {
    const detail = event.detail;
    syncTabsFromServer(detail.tabs);
    if (Array.isArray(detail.history)) state.history = detail.history;
    if (detail.limits) state.limits = { ...state.limits, ...detail.limits };
    if (detail.version) state.version = detail.version;
    if (typeof detail.historyEnabled === 'boolean') state.settings.historyEnabled = detail.historyEnabled;
    pruneLayout(state.order);
    refreshSettings();
    refreshHome();
    refreshLibrary();

    // "Open the home page" keeps the restored tabs in the strip but starts the
    // view on the home surface instead of resuming the last page.
    const startOnHome = state.settings.startup === 'home';
    const preferred = startOnHome
      ? null
      : (pendingActivation && state.tabs.has(pendingActivation) && pendingActivation) ||
        (state.activeId && state.tabs.has(state.activeId) && state.activeId) ||
        state.order[0] ||
        null;

    if (preferred) {
      setActiveId(preferred);
      pendingActivation = null;
      send({ t: 'hello', tabId: preferred, viewport: requestedSize() });
    } else {
      setActiveId(null);
    }
    renderAll();
    applyActiveView();
    updateConnectionStatus('open');
    syncStripOverflow();
    startPings();
  });

  connection.addEventListener('tab', (event) => {
    const incoming = event.detail.tab;
    if (!incoming) return;
    const existing = state.tabs.get(incoming.id);
    const merged = upsertTab(incoming);
    if (existing?.pendingNavigation) delete merged.pendingNavigation;
    renderTabs();
    if (els.app.classList.contains('is-newtab')) refreshHome();
    if (state.activeId === incoming.id) {
      renderToolbar();
      renderOmnibox();
      applyActiveView();
    }
  });

  connection.addEventListener('light', (event) => {
    const { tabId, page } = event.detail || {};
    if (!tabId || !page) return;
    lightPages.set(tabId, page);
    if (state.activeId === tabId) showLight(state.tabs.get(tabId), page, state.tabs.get(tabId)?.light);
  });

  connection.addEventListener('light:state', (event) => {
    const detail = event.detail || {};
    if (!detail.tabId || state.activeId !== detail.tabId) return;
    const tab = state.tabs.get(detail.tabId);
    if (!tab) return;
    if (detail.loading) showLight(tab, null, { loading: true });
    else if (detail.error) {
      lightPages.delete(detail.tabId);
      showLight(tab, null, { error: detail.error });
    }
  });

  connection.addEventListener('engine', (event) => {
    const detail = event.detail || {};
    if (detail.tab) upsertTab(detail.tab);
    if (detail.engine !== 'light') lightPages.delete(detail.tabId);
    renderAll();
    applyActiveView();
  });

  connection.addEventListener('tab:active', (event) => {
    const detail = event.detail;
    if (!detail?.id) return;
    if (detail.tab) upsertTab(detail.tab);
    setActiveId(detail.id);
    pendingActivation = null;
    renderAll();
    applyActiveView();
    ensureSizePublished();
  });

  connection.addEventListener('tab:closed', (event) => {
    const id = event.detail.id;
    const before = orderedTabs();
    const index = before.findIndex((tab) => tab.id === id);
    const wasActive = state.activeId === id;
    removeTab(id);
    pruneLayout(state.order);
    const node = tabNodes.get(id);
    node?.remove();
    tabNodes.delete(id);
    renderTabs();
    refreshLibrary();
    if (els.app.classList.contains('is-newtab')) refreshHome();
    if (wasActive) {
      const remaining = orderedTabs();
      const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
      if (next) activateTab(next.id);
      else {
        setActiveId(null);
        renderAll();
        applyActiveView();
      }
    } else {
      renderToolbar();
    }
    document.title = activeTab()?.title ? `${activeTab().title} · Velocity Proxy` : 'Velocity Proxy';
  });

  connection.addEventListener('history', (event) => {
    state.history = event.detail.items || [];
    if (typeof event.detail.enabled === 'boolean') state.settings.historyEnabled = event.detail.enabled;
    refreshLibrary();
    if (!activeTab()?.url) refreshHome();
  });

  connection.addEventListener('error', (event) => {
    toast(event.detail.message || 'Something went wrong', { tone: 'warn' });
    const tab = activeTab();
    if (tab?.pendingNavigation) {
      delete tab.pendingNavigation;
      tab.loading = false;
      applyActiveView();
    }
  });

  connection.addEventListener('clipboard', async (event) => {
    const text = event.detail.text;
    if (!text) {
      toast('Nothing is selected on the page', { tone: 'info' });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`, { tone: 'success' });
    } catch {
      toast('Clipboard access was blocked by your browser', { tone: 'warn' });
    }
  });

  connection.addEventListener('dialog', (event) => showDialog(event.detail.dialog));
  connection.addEventListener('screenshot', (event) => saveScreenshot(event.detail));

  connection.addEventListener('find', (event) => {
    const detail = event.detail;
    if (!detail || (detail.tabId && detail.tabId !== state.activeId)) return;
    if ((els.findInput?.value || '') !== (detail.query || '')) return;
    renderFindState(Number(detail.matches) || 0, Number(detail.active) || 0);
  });

  connection.addEventListener('pong', (event) => {
    const sent = Number(event.detail.ts);
    if (Number.isFinite(sent)) {
      state.latency = Math.max(0, Date.now() - sent);
      renderLatency();
    }
  });

  connection.addEventListener('status', (event) => updateConnectionStatus(event.detail.status));
  connection.addEventListener('denied', () => {
    connection.close();
    showLogin('Your session expired. Sign in again.');
  });
};

const syncTabsFromServer = (tabs) => {
  const list = Array.isArray(tabs) ? tabs : [];
  const ids = new Set(list.map((tab) => tab.id));
  for (const id of [...state.tabs.keys()]) {
    if (!ids.has(id)) removeTab(id);
  }
  state.order = [];
  for (const tab of list) upsertTab(tab);
  pruneLayout(state.order);
};

const updateConnectionStatus = (status) => {
  state.connection = status;
  document.documentElement.dataset.connection = status;
  renderLatency();
};

const startPings = () => {
  clearInterval(pingTimer);
  const ping = () => {
    if (connection.isOpen) send({ t: 'ping', ts: Date.now() });
  };
  ping();
  pingTimer = setInterval(ping, 20000);
};

/* --------------------------------------------------------------------- tabs */

const renderAll = () => {
  renderTabs();
  renderToolbar();
  renderOmnibox();
  refreshSettings();
  document.title = activeTab()?.title ? `${activeTab().title} · Velocity Proxy` : 'Velocity Proxy';
};

const renderTabs = () => {
  if (!els.tabs) return;
  const tabs = orderedTabs();
  const ids = new Set(tabs.map((tab) => tab.id));
  for (const [id, node] of tabNodes) {
    if (id.startsWith('group:')) continue;
    if (!ids.has(id)) {
      node.remove();
      tabNodes.delete(id);
    }
  }

  const sequence = [];
  const grouped = new Set();
  for (const tab of tabs.filter((item) => item.pinned)) sequence.push({ tab });
  if (state.settings.tabGroups !== false) {
    for (const group of groupsList()) {
      const members = tabs.filter((tab) => !tab.pinned && (group.tabs || []).includes(tab.id));
      if (!members.length) continue;
      sequence.push({ group, members });
      members.forEach((tab) => grouped.add(tab.id));
    }
  }
  for (const tab of tabs.filter((item) => !item.pinned && !grouped.has(item.id))) sequence.push({ tab });

  const nodes = [];
  const liveGroups = new Set();
  for (const entry of sequence) {
    if (entry.group) {
      const key = `group:${entry.group.id}`;
      let chip = tabNodes.get(key);
      if (!chip) {
        chip = createGroupNode(entry.group);
        tabNodes.set(key, chip);
      }
      updateGroupNode(chip, entry.group, entry.members.length);
      nodes.push(chip);
      liveGroups.add(key);
      if (entry.group.collapsed) continue;
      for (const tab of entry.members) nodes.push(tabNodeFor(tab));
    } else {
      nodes.push(tabNodeFor(entry.tab));
    }
  }

  const keepNodes = new Set(nodes);
  for (const [id, node] of tabNodes) {
    if (keepNodes.has(node)) continue;
    if (id.startsWith('group:')) {
      if (liveGroups.has(id)) continue;
      node.remove();
      tabNodes.delete(id);
      continue;
    }
    // A tab inside a collapsed group stays in state but leaves the strip.
    node.remove();
    tabNodes.delete(id);
  }

  let previous = null;
  for (const node of nodes) {
    if (previous) {
      if (previous.nextElementSibling !== node) els.tabs.insertBefore(node, previous.nextElementSibling);
    } else if (els.tabs.firstElementChild !== node) {
      els.tabs.insertBefore(node, els.tabs.firstElementChild);
    }
    previous = node;
  }

  requestAnimationFrame(() => {
    syncStripOverflow();
    revealActiveTab();
    // Flex widths and font metrics can settle a frame after the nodes land, so
    // one cheap follow-up keeps the overflow affordance honest on first paint.
    setTimeout(syncStripOverflow, 150);
  });
};

const tabNodeFor = (tab) => {
  let node = tabNodes.get(tab.id);
  if (!node) {
    node = createTabNode(tab);
    tabNodes.set(tab.id, node);
  }
  updateTabNode(node, tab);
  return node;
};

const createTabNode = (tab) => {
  const node = document.createElement('div');
  node.className = 'tab';
  node.dataset.id = tab.id;
  node.setAttribute('role', 'tab');
  node.innerHTML = `
    <span class="tab-fav"></span>
    <span class="tab-title"></span>
    <span class="tab-spinner" hidden><i></i><i></i><i></i></span>
    <button class="tab-audio" type="button" tabindex="-1" aria-label="Tab audio" title="Mute this tab" hidden>${icon('volume', 13)}</button>
    <button class="tab-close" type="button" tabindex="-1" aria-label="Close tab">${icon('close', 13)}</button>
  `;
  node.draggable = true;
  node.addEventListener('dragstart', (event) => {
    dragTabId = tab.id;
    node.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tab.id);
  });
  node.addEventListener('dragend', () => {
    dragTabId = null;
    node.classList.remove('is-dragging');
    renderTabs();
  });
  node.addEventListener('dragover', (event) => {
    if (!dragTabId || dragTabId === tab.id) return;
    event.preventDefault();
    const rect = node.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    node.classList.toggle('is-drop-after', after);
    node.classList.toggle('is-drop-before', !after);
  });
  node.addEventListener('dragleave', () => node.classList.remove('is-drop-before', 'is-drop-after'));
  node.addEventListener('drop', (event) => {
    event.preventDefault();
    const after = node.classList.contains('is-drop-after');
    node.classList.remove('is-drop-before', 'is-drop-after');
    moveTab(dragTabId, tab.id, after);
    dragTabId = null;
  });
  node.addEventListener('click', () => activateTab(tab.id));
  node.addEventListener('auxclick', (event) => {
    if (event.button === 1) {
      event.preventDefault();
      closeTab(tab.id);
    }
  });
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openTabMenu(tab.id, event.clientX, event.clientY);
  });
  node.querySelector('.tab-audio').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTabMute(tab.id);
  });
  node.querySelector('.tab-close').addEventListener('click', (event) => {
    event.stopPropagation();
    closeTab(tab.id);
  });
  return node;
};

const updateTabNode = (node, tab) => {
  const isActive = state.activeId === tab.id;
  node.classList.toggle('is-active', isActive);
  node.classList.toggle('is-pinned', Boolean(tab.pinned));
  node.classList.toggle('is-loading', Boolean(tab.loading));
  node.setAttribute('aria-selected', isActive ? 'true' : 'false');
  const titleNode = node.querySelector('.tab-title');
  const label = tabDisplayTitle(tab, tab.url ? prettyHost(tab.host) : 'New Tab');
  if (titleNode.textContent !== label) titleNode.textContent = label;
  node.title = tab.url ? `${label}\n${tab.url}` : label;
  const group = groupOfTab(tab.id);
  if (group) {
    node.style.setProperty('--group-color', group.color);
    node.dataset.group = group.name;
  } else {
    node.style.removeProperty('--group-color');
    delete node.dataset.group;
  }

  const spinner = node.querySelector('.tab-spinner');
  spinner.hidden = !tab.loading;

  const fav = node.querySelector('.tab-fav');
  const key = `${tab.favicon || ''}|${tab.host || ''}`;
  if (fav.dataset.key !== key) {
    fav.dataset.key = key;
    fav.replaceChildren(faviconNode(tab.favicon, tab.host, 16));
  }
  fav.hidden = Boolean(tab.loading);

  const audioBtn = node.querySelector('.tab-audio');
  if (audioBtn) {
    audioBtn.hidden = !(tab.audible || tab.muted);
    audioBtn.classList.toggle('is-muted', Boolean(tab.muted));
    audioBtn.classList.toggle('is-audible', Boolean(tab.audible) && !tab.muted);
    audioBtn.innerHTML = icon(tab.muted ? 'volumeX' : 'volume', 13);
    audioBtn.title = tab.muted ? 'Unmute this tab' : 'Mute this tab';
  }
  node.classList.toggle('is-audible', Boolean(tab.audible) && !tab.muted);
};

const createGroupNode = (group) => {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'tab-group';
  chip.innerHTML =
    '<span class="tab-group-dot"></span><span class="tab-group-name"></span><span class="tab-group-count"></span>';
  chip.addEventListener('click', () => {
    toggleGroupCollapsed(group.id);
    renderTabs();
  });
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    menu.open(event.clientX, event.clientY, [
      {
        label: group.collapsed ? 'Expand group' : 'Collapse group',
        icon: 'chevronDown',
        onSelect: () => {
          toggleGroupCollapsed(group.id);
          renderTabs();
        },
      },
      {
        label: 'Rename group…',
        icon: 'edit',
        onSelect: () => {
          const value = promptText('Group name', group.name);
          if (value === null) return;
          group.name = value || group.name;
          saveLayout();
          renderTabs();
        },
      },
      {
        label: 'Change colour',
        icon: 'spark',
        onSelect: () => {
          const index = GROUP_COLORS.indexOf(group.color);
          group.color = GROUP_COLORS[(index + 1) % GROUP_COLORS.length];
          saveLayout();
          renderTabs();
        },
      },
      { separator: true },
      {
        label: 'Ungroup tabs',
        icon: 'close',
        danger: true,
        onSelect: () => {
          removeGroup(group.id);
          renderTabs();
        },
      },
    ]);
  });
  return chip;
};

const updateGroupNode = (chip, group, count) => {
  chip.style.setProperty('--group-color', group.color);
  chip.style.setProperty('--group-line', `color-mix(in srgb, ${group.color} 42%, transparent)`);
  const nameNode = chip.querySelector('.tab-group-name');
  if (nameNode.textContent !== group.name) nameNode.textContent = group.name;
  chip.querySelector('.tab-group-count').textContent = String(count);
  chip.classList.toggle('is-collapsed', Boolean(group.collapsed));
  chip.title = group.collapsed ? `Expand “${group.name}”` : `Collapse “${group.name}”`;
};

const promptText = (message, fallback = '') => {
  try {
    const value = window.prompt(message, fallback);
    return value === null ? null : value.trim();
  } catch {
    return null;
  }
};

const moveTab = (dragId, targetId, after) => {
  if (!dragId || !targetId || dragId === targetId) return;
  const tabs = orderedTabs().filter((tab) => !tab.pinned);
  const ids = tabs.map((tab) => tab.id);
  const from = ids.indexOf(dragId);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1) return;
  ids.splice(from, 1);
  const insertAt = ids.indexOf(targetId) + (after ? 1 : 0);
  ids.splice(insertAt, 0, dragId);
  setTabOrder([...orderedTabs().filter((tab) => tab.pinned).map((tab) => tab.id), ...ids]);
  renderTabs();
};

const moveTabRelative = (id, delta) => {
  const tabs = orderedTabs().filter((tab) => !tab.pinned);
  const index = tabs.findIndex((tab) => tab.id === id);
  const target = tabs[index + delta];
  if (index === -1 || !target) return;
  moveTab(id, target.id, delta > 0);
};

const renameTab = (id) => {
  const tab = state.tabs.get(id);
  if (!tab) return;
  const value = promptText('Tab name', tabDisplayTitle(tab, tab.title || ''));
  if (value === null) return;
  setTabTitle(id, value === (tab.title || '') ? '' : value);
  renderTabs();
};

const addTabToNewGroup = (id) => {
  const tab = state.tabs.get(id);
  const name = promptText('Group name', tab ? prettyHost(tab.host) || 'Group' : 'Group');
  if (!name) return;
  const group = createGroup(name, GROUP_COLORS[groupsList().length % GROUP_COLORS.length]);
  assignTabToGroup(id, group.id);
  renderTabs();
};

const closeTabsToRight = (id) => {
  const tabs = orderedTabs();
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;
  for (const tab of tabs.slice(index + 1)) {
    if (!tab.pinned) closeTab(tab.id);
  }
};

const activateTab = (id) => {
  const tab = state.tabs.get(id);
  if (!tab) return;
  closeFind({ restoreFocus: false });
  setActiveId(id);
  renderAll();
  applyActiveView();
  if (!connection.isOpen) {
    pendingActivation = id;
  } else {
    send({ t: 'tab:activate', id, viewport: requestedSize() });
  }
};

const newTab = () => {
  if (state.tabs.size >= state.limits.maxTabs) {
    toast(`Tab limit reached (${state.limits.maxTabs}). Close a tab first.`, { tone: 'warn' });
    return;
  }
  if (!connection.isOpen) {
    toast('Still reconnecting to the proxy…', { tone: 'warn' });
    connection.connect();
    return;
  }
  send({ t: 'tab:create', viewport: requestedSize() });
};

const closeTab = (id) => {
  const tab = state.tabs.get(id);
  if (tab?.url) closedTabs.push({ url: tab.url, title: tab.title });
  if (closedTabs.length > 12) closedTabs.shift();
  send({ t: 'tab:close', id });
};

const duplicateTab = (id) => {
  if (state.tabs.size >= state.limits.maxTabs) {
    toast(`Tab limit reached (${state.limits.maxTabs}).`, { tone: 'warn' });
    return;
  }
  send({ t: 'tab:duplicate', tabId: id, viewport: requestedSize() });
};

const reopenClosed = () => {
  const entry = closedTabs.pop();
  if (!entry) {
    toast('No recently closed tabs', { tone: 'info' });
    return;
  }
  if (state.tabs.size >= state.limits.maxTabs) {
    toast(`Tab limit reached (${state.limits.maxTabs}).`, { tone: 'warn' });
    return;
  }
  send({ t: 'tab:create', input: entry.url, viewport: requestedSize() });
};

const openTabMenu = (id, x, y) => {
  const tab = state.tabs.get(id);
  if (!tab) return;
  const group = groupOfTab(id);
  const items = [
    { label: 'Reload', icon: 'reload', onSelect: () => { activateTab(id); setTimeout(() => sendTab({ t: 'reload' }), 60); } },
    { label: 'Duplicate', icon: 'copy', onSelect: () => duplicateTab(id) },
    { label: tab.pinned ? 'Unpin tab' : 'Pin tab', icon: 'pin', onSelect: () => send({ t: 'tab:pin', tabId: id, pinned: !tab.pinned }) },
    { label: 'Rename tab…', icon: 'edit', onSelect: () => renameTab(id) },
    { label: 'Move left', icon: 'back', onSelect: () => moveTabRelative(id, -1) },
    { label: 'Move right', icon: 'forward', onSelect: () => moveTabRelative(id, 1) },
    { label: 'Copy destination', icon: 'link', onSelect: () => copyText(tab.url || '') },
    { separator: true },
    { label: 'Add to new group…', icon: 'grid', onSelect: () => addTabToNewGroup(id) },
  ];
  for (const candidate of groupsList()) {
    if (candidate.id === group?.id) continue;
    items.push({
      label: `Move to “${candidate.name}”`,
      icon: 'grid',
      onSelect: () => {
        assignTabToGroup(id, candidate.id);
        renderTabs();
      },
    });
  }
  if (group) {
    items.push({
      label: `Remove from “${group.name}”`,
      icon: 'close',
      onSelect: () => {
        assignTabToGroup(id, null);
        renderTabs();
      },
    });
  }
  items.push(
    { separator: true },
    { label: 'Close tab', icon: 'close', danger: true, onSelect: () => closeTab(id) },
    {
      label: 'Close other tabs',
      icon: 'trash',
      danger: true,
      onSelect: () => {
        for (const other of orderedTabs()) if (other.id !== id) closeTab(other.id);
      },
    },
    { label: 'Close tabs to the right', icon: 'trash', danger: true, onSelect: () => closeTabsToRight(id) },
  );
  menu.open(x, y, items);
};

/* ----------------------------------------------------------------- tab strip */

const stripScroll = () =>
  els.tabstripScroll || document.getElementById('tabstrip-scroll') || document.querySelector('.tabstrip-scroll');

/**
 * The strip is the only flexible thing in the bar, so it absorbs whatever the
 * buttons leave behind. Once the tabs cannot shrink any further it scrolls
 * instead, and this tells the user that: faded edges plus a chevron that
 * counts how many tabs are out of view.
 */
const syncStripOverflow = () => {
  const scroll = stripScroll();
  if (!scroll) return;
  const max = scroll.scrollWidth - scroll.clientWidth;
  const overflowing = max > 2;
  scroll.classList.toggle('fade-left', overflowing && scroll.scrollLeft > 2);
  scroll.classList.toggle('fade-right', overflowing && scroll.scrollLeft < max - 2);
  if (!els.tabOverflow) return;
  els.tabOverflow.hidden = !overflowing;
  if (!overflowing) {
    if (els.tabOverflowCount) els.tabOverflowCount.hidden = true;
    return;
  }
  const view = scroll.getBoundingClientRect();
  let outOfView = 0;
  for (const node of tabNodes.values()) {
    if (!node.isConnected) continue;
    const rect = node.getBoundingClientRect();
    if (rect.left < view.left - 1 || rect.right > view.right + 1) outOfView += 1;
  }
  if (els.tabOverflowCount) {
    els.tabOverflowCount.textContent = String(outOfView);
    els.tabOverflowCount.hidden = outOfView === 0;
  }
  const total = scroll.querySelectorAll('.tab').length;
  els.tabOverflow.title = `${outOfView} of ${total} tabs out of view — show all tabs`;
};

/** Keeps the selected tab on screen when it is activated from elsewhere. */
const revealActiveTab = () => {
  const scroll = stripScroll();
  const node = state.activeId ? tabNodes.get(state.activeId) : null;
  if (!scroll || !node || !node.isConnected) return;
  const view = scroll.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  if (rect.left < view.left) scroll.scrollLeft -= view.left - rect.left + 14;
  else if (rect.right > view.right) scroll.scrollLeft += rect.right - view.right + 14;
};

/** Every open tab in one list, then the ones that were just closed. */
const openAllTabsMenu = () => {
  const anchor = els.tabOverflow?.getBoundingClientRect();
  const items = orderedTabs().map((tab, index) => ({
    label: `${index + 1}. ${tabDisplayTitle(tab, tab.url ? prettyHost(tab.host) : 'New Tab')}`.slice(0, 64),
    icon: tab.id === state.activeId ? 'check' : tab.pinned ? 'pin' : 'globe',
    onSelect: () => activateTab(tab.id),
  }));
  if (closedTabs.length) {
    items.push({ separator: true });
    for (const entry of closedTabs.slice(-4).reverse()) {
      items.push({
        label: `Reopen · ${entry.title || entry.url}`.slice(0, 64),
        icon: 'clock',
        onSelect: () => newTabWithUrl(entry.url),
      });
    }
  }
  if (items.length) {
    items.push({
      label: `Copy all ${orderedTabs().length} tab links`,
      icon: 'link',
      onSelect: () => copyText(orderedTabs().map((tab) => tab.url).filter(Boolean).join('\n'), 'Tab links copied'),
    });
  }
  items.push(
    { separator: true },
    { label: 'Search tabs…', icon: 'search', hint: 'Ctrl+Shift+A', onSelect: () => openTabSearch() },
    { label: 'Reopen closed tab', icon: 'clock', hint: 'Ctrl+Shift+T', onSelect: () => reopenClosed() },
  );
  menu.open(anchor ? anchor.left - 120 : 12, anchor ? anchor.bottom + 6 : 52, items);
};

const newTabWithUrl = (url) => {
  if (!connection.isOpen) {
    toast('Still reconnecting to the proxy…', { tone: 'warn' });
    connection.connect();
    return;
  }
  if (state.tabs.size >= state.limits.maxTabs) {
    toast(`Tab limit reached (${state.limits.maxTabs}).`, { tone: 'warn' });
    return;
  }
  send({ t: 'tab:create', input: url, viewport: requestedSize() });
};

const openTabSearch = () => openPalette();

/* ---------------------------------------------------------------- navigation */

const navigate = (input, { forceSearch = false } = {}) => {
  const value = String(input || '').trim();
  if (!value) return;
  const engine = state.settings.engine;
  const template = engine === 'custom' ? state.settings.customTemplate : null;
  const payload = { engine, template, viewport: requestedSize() };
  if (forceSearch) {
    payload.input = value;
    payload.forceSearch = true;
  } else {
    payload.input = value;
  }

  if (!state.activeId) {
    if (state.tabs.size >= state.limits.maxTabs) {
      toast(`Tab limit reached (${state.limits.maxTabs}).`, { tone: 'warn' });
      return;
    }
    send({ t: 'tab:create', ...payload });
    return;
  }

  const tab = activeTab();
  if (tab) {
    tab.pendingNavigation = true;
    tab.loading = true;
    tab.status = 'loading';
    tab.error = null;
  }
  send({ t: 'nav', tabId: state.activeId, ...payload });
  renderAll();
  applyActiveView();
};

const reload = () => {
  const tab = activeTab();
  if (!tab?.url) return;
  sendTab({ t: 'reload' });
};

const stop = () => sendTab({ t: 'stop' });
const goBack = () => sendTab({ t: 'back' });
const goForward = () => sendTab({ t: 'forward' });
const goHome = () => {
  const tab = activeTab();
  if (tab) {
    if (tab.url) {
      tab.lastUrl = tab.url;
      tab.lastTitle = tab.title;
    }
    tab.url = null;
    tab.title = 'New Tab';
    tab.pendingNavigation = false;
    tab.error = null;
    tab.loading = false;
  }
  sendTab({ t: 'home' });
  applyActiveView();
  renderAll();
};

const resumeTab = (id) => {
  const tab = state.tabs.get(id);
  if (!tab) return;
  if (!tab.url && tab.lastUrl) {
    tab.url = tab.lastUrl;
    tab.title = tab.lastTitle || tab.title;
    send({ t: 'nav', tabId: id, input: tab.lastUrl });
    activateTab(id);
    return;
  }
  activateTab(id);
};

/* ------------------------------------------------------------------- render */

const applyActiveView = () => {
  const tab = activeTab();
  const showHome = !tab || (!tab.url && !tab.pendingNavigation);
  const light = Boolean(tab && tab.engine === 'light' && !showHome);
  els.app.classList.toggle('is-newtab', showHome);
  els.app.classList.toggle('is-light', light);

  if (showHome) {
    hideLight();
    setActiveTab(null);
    hideOverlay();
    refreshHome();
    updatePlaceholder();
    if (document.activeElement === document.body) focusHomeSearch();
  } else if (light) {
    // The light engine paints its own DOM: this tab has no canvas, no frames and
    // no server browser at all.
    setActiveTab(tab);
    hideOverlay();
    showLight(tab, lightPages.get(tab.id) || null, tab.light);
  } else {
    hideLight();
    setActiveTab(tab);
    if (tab.status === 'error' && tab.error) {
      showError(tab.error, { actionLabel: 'Reload', action: reload });
    } else if (!hasRenderedFrame()) {
      // Nothing has been painted for this tab. The navigation watchdog clears
      // `loading` after 30s, which used to hide this overlay and leave a black
      // canvas with no explanation when the server browser was slow to produce
      // its first frame. Keep telling the viewer it is still rendering.
      showLoading(tab.title ? `Rendering ${tab.title}` : 'Rendering page…');
    } else if (!tab.loading) {
      hideOverlay();
    } else {
      showLoading(tab.title ? `Loading ${tab.title}` : 'Loading page…');
    }
  }
  renderToolbar();
  renderOmnibox();
  document.title = tab?.title ? `${tab.title} · Velocity Proxy` : 'Velocity Proxy';
};

const renderToolbar = () => {
  const tab = activeTab();
  els.back.disabled = !tab?.canGoBack;
  els.forward.disabled = !tab?.canGoForward;
  els.home.disabled = !tab?.url;

  const reloading = Boolean(tab?.loading);
  if (els.reload.dataset.state !== (reloading ? 'loading' : 'idle')) {
    els.reload.dataset.state = reloading ? 'loading' : 'idle';
    els.reload.innerHTML = icon(reloading ? 'stop' : 'reload', 18);
    els.reload.title = reloading ? 'Stop loading' : 'Reload';
    els.reload.setAttribute('aria-label', reloading ? 'Stop loading' : 'Reload');
  }

  const bookmarked = Boolean(tab?.url && findBookmark(tab.url));
  if (els.bookmark.dataset.state !== (bookmarked ? 'on' : 'off')) {
    els.bookmark.dataset.state = bookmarked ? 'on' : 'off';
    els.bookmark.innerHTML = starIcon(bookmarked, 18);
    els.bookmark.title = bookmarked ? 'Remove bookmark' : 'Bookmark this page (Ctrl+D)';
  }
  els.bookmark.disabled = !tab?.url;
  els.copyUrl.disabled = !tab?.url;

  const loading = Boolean(tab?.loading);
  els.progress.classList.toggle('is-active', loading);
  els.progress.classList.toggle('is-done', Boolean(tab) && !loading);
  renderEngineButton();
  renderLatency();
};

const renderEngineButton = () => {
  if (!els.engineBtn) return;
  const tab = activeTab();
  const engine = tab?.engine === 'light' ? 'light' : 'chromium';
  els.engineBtn.dataset.engine = engine;
  els.engineBtn.textContent = engine === 'light' ? 'Light' : 'Full';
  els.engineBtn.disabled = !tab?.url;
  els.engineBtn.title =
    engine === 'light'
      ? 'Lightweight engine, no server browser — switch this tab to the full browser'
      : 'Full browser engine — switch this tab to lightweight mode';
  els.engineBtn.setAttribute('aria-label', els.engineBtn.title);
};

const renderOmnibox = () => {
  const tab = activeTab();
  const title = tab?.pendingNavigation ? 'Opening…' : tab?.title || 'New Tab';
  const host = tab?.url && !tab.pendingNavigation ? prettyHost(tab.host) : tab?.pendingNavigation ? 'Connecting' : 'Search or enter address';
  if (!omniEditing) {
    els.omniTitle.textContent = title;
    els.omniHost.textContent = host;
    const secure = Boolean(tab?.secure);
    const lockKey = tab?.url ? (secure ? 'lock' : 'globe') : 'search';
    if (els.omniLock.dataset.key !== lockKey) {
      els.omniLock.dataset.key = lockKey;
      els.omniLock.innerHTML = icon(lockKey, 14);
    }
    els.omniLock.classList.toggle('is-secure', secure);
    const key = `${tab?.favicon || ''}|${tab?.host || ''}`;
    if (els.omniFav.dataset.key !== key) {
      els.omniFav.dataset.key = key;
      els.omniFav.replaceChildren(faviconNode(tab?.favicon, tab?.host, 16));
      els.omniFav.hidden = !tab?.url;
    }
    els.omniDisplay.dataset.mode = tab?.url ? 'site' : 'search';
  }
  els.omniInput.placeholder = `Search ${state.settings.engine === 'custom' ? 'the web' : engineName()} or enter an address`;
  els.omniDisplay.title = tab?.url ? `Destination: ${tab.url}` : 'Type a URL or search';
  if (els.omniSpinner) els.omniSpinner.hidden = !tab?.loading;
};

const renderLatency = () => {
  if (!els.latency) return;
  const value = els.latency.querySelector('em');
  if (value) value.textContent = state.latency != null ? `${state.latency} ms` : '—';
  els.latency.dataset.status = state.connection;
  els.latency.title =
    state.connection === 'open'
      ? `Connected · round trip ${state.latency != null ? `${state.latency} ms` : 'measuring'}`
      : `Connection: ${state.connection}`;
};

/* ------------------------------------------------------------------ omnibox */

const startOmniEdit = () => {
  if (!els.omniboxForm) return;
  omniEditing = true;
  els.omniboxForm.classList.add('is-editing');
  els.omniInput.value = activeTab()?.url || '';
  if (els.omniClear) els.omniClear.hidden = !els.omniInput.value;
  requestAnimationFrame(() => {
    els.omniInput.focus();
    els.omniInput.select();
  });
};

const endOmniEdit = () => {
  omniEditing = false;
  els.omniboxForm.classList.remove('is-editing');
  els.omniInput.blur();
  els.omniInput.value = '';
  if (els.omniClear) els.omniClear.hidden = true;
  if (els.omniSuggest) {
    els.omniSuggest.hidden = true;
    els.omniSuggest.innerHTML = '';
  }
  renderOmnibox();
};

const wireOmnibox = () => {
  els.omniDisplay.addEventListener('click', startOmniEdit);
  els.omniDisplay.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      startOmniEdit();
    }
  });
  els.omniboxForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = els.omniInput.value.trim();
    if (!value) return;
    navigate(value);
    endOmniEdit();
  });

  els.omniInput.addEventListener('input', () => {
    if (els.omniClear) els.omniClear.hidden = !els.omniInput.value;
  });

  els.omniClear?.addEventListener('click', () => {
    els.omniInput.value = '';
    els.omniClear.hidden = true;
    els.omniInput.focus();
  });

  els.omniSend?.addEventListener('click', (event) => {
    event.preventDefault();
    els.omniboxForm.requestSubmit();
  });

  const suggester = createSuggester({
    input: els.omniInput,
    panel: els.omniSuggest,
    onSubmit: (value, options) => {
      navigate(value, options);
      endOmniEdit();
    },
    getPrefixItems: () => {
      const tab = activeTab();
      if (!tab?.url) return [];
      return [
        { type: 'url', label: tab.url, hint: 'Current destination', value: tab.url },
        ...orderedTabs()
          .filter((other) => other.url && other.id !== tab.id)
          .slice(0, 3)
          .map((other) => ({ type: 'history', label: other.title, hint: prettyHost(other.host), value: other.url })),
      ];
    },
  });
  suggester.setOnClose(endOmniEdit);

  els.omniInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      endOmniEdit();
    }
  });
  els.omniInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== els.omniInput) {
        omniEditing = false;
        els.omniboxForm.classList.remove('is-editing');
        renderOmnibox();
      }
    }, 140);
  });
};

/* ------------------------------------------------------------------ toolbar */

const wireChrome = () => {
  els.newTab.addEventListener('click', newTab);
  els.back.addEventListener('click', goBack);
  els.forward.addEventListener('click', goForward);
  els.reload.addEventListener('click', () => {
    const tab = activeTab();
    if (tab?.loading) stop();
    else reload();
  });
  els.home.addEventListener('click', goHome);
  els.bookmark.addEventListener('click', toggleBookmark);
  els.copyUrl.addEventListener('click', () => {
    const tab = activeTab();
    if (tab?.url) copyText(tab.url);
  });
  els.activityBtn?.addEventListener('click', () => openSystem());
  els.fullscreenBtn?.addEventListener('click', () => toggleFullscreen());
  els.findBtn?.addEventListener('click', () => openFind());
  els.bookmarksBtn?.addEventListener('click', () => openBookmarks());
  els.historyBtn?.addEventListener('click', () => openHistory());
  els.tabSearchBtn?.addEventListener('click', () => openTabSearch());
  els.tabOverflow?.addEventListener('click', () => openAllTabsMenu());
  els.tabstripScroll?.addEventListener('scroll', syncStripOverflow, { passive: true });
  els.tabstripScroll?.addEventListener(
    'wheel',
    (event) => {
      const strip = els.tabstripScroll;
      if (!strip || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      if (strip.scrollWidth <= strip.clientWidth) return;
      strip.scrollLeft += event.deltaY;
      event.preventDefault();
    },
    { passive: false },
  );
  // Middle-clicking the empty part of the strip opens a tab, like a browser.
  els.tabs?.addEventListener('auxclick', (event) => {
    if (event.button !== 1 || event.target?.closest?.('.tab, .tab-group')) return;
    event.preventDefault();
    newTab();
  });
  window.addEventListener('resize', syncStripOverflow);
  // Tab widths settle a frame after the nodes are inserted, so watch the strip
  // itself instead of trusting a single measurement.
  if (typeof ResizeObserver === 'function' && els.tabstripScroll) {
    const stripObserver = new ResizeObserver(() => syncStripOverflow());
    stripObserver.observe(els.tabstripScroll);
    if (els.tabs) stripObserver.observe(els.tabs);
  }
  els.findClose?.addEventListener('click', () => closeFind());
  els.findPrev?.addEventListener('click', () => stepFind(false));
  els.findNext?.addEventListener('click', () => stepFind(true));
  els.findInput?.addEventListener('input', () => scheduleFind());
  els.findInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      stepFind(!event.shiftKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });
  els.shortcutsClose?.addEventListener('click', () => closeShortcuts());
  els.shortcutsModal?.addEventListener('pointerdown', (event) => {
    if (event.target === els.shortcutsModal) closeShortcuts();
  });
  els.themeToggle.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    setTheme(current === 'light' ? 'dark' : 'light');
    toast(`${current === 'light' ? 'Dark' : 'Light'} theme`, { tone: 'info', timeout: 1600 });
  });

  els.back.innerHTML = icon('back', 18);
  els.forward.innerHTML = icon('forward', 18);
  els.reload.innerHTML = icon('reload', 18);
  els.home.innerHTML = icon('home', 18);
  els.newTab.innerHTML = icon('plus', 17);
  if (els.tabOverflowIcon) els.tabOverflowIcon.innerHTML = icon('chevronDown', 15);
  els.themeToggle.innerHTML = icon('sun', 18);
  els.settingsBtn.innerHTML = icon('settings', 18);
  els.bookmark.innerHTML = starIcon(false, 18);
  els.copyUrl.innerHTML = icon('link', 18);
  if (els.activityBtn) els.activityBtn.innerHTML = icon('activity', 18);
  if (els.fullscreenBtn) els.fullscreenBtn.innerHTML = icon('expand', 18);
  if (els.findBtn) els.findBtn.innerHTML = icon('search', 18);
  if (els.bookmarksBtn) els.bookmarksBtn.innerHTML = icon('star', 17);
  if (els.historyBtn) els.historyBtn.innerHTML = icon('clock', 17);
  if (els.tabSearchBtn) els.tabSearchBtn.innerHTML = icon('search', 15);
  if (els.findGlyph) els.findGlyph.innerHTML = icon('search', 15);
  if (els.findPrev) els.findPrev.innerHTML = icon('chevronDown', 15);
  if (els.findNext) els.findNext.innerHTML = icon('chevronDown', 15);
  if (els.findClose) els.findClose.innerHTML = icon('close', 15);
};

const toggleBookmark = () => {
  const tab = activeTab();
  if (!tab?.url) return;
  toggleBookmarkFor(tab);
  renderToolbar();
  refreshHome();
};

const copyText = async (text, message = 'Destination URL copied') => {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(message, { tone: 'success' });
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    try {
      document.execCommand('copy');
      toast(message, { tone: 'success' });
    } catch {
      toast('Could not access the clipboard', { tone: 'warn' });
    }
    helper.remove();
  }
};

const saveScreenshot = (detail) => {
  const data = detail?.data;
  if (!data) return;
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    const link = document.createElement('a');
    const tab = activeTab();
    const name = prettyHost(tab?.host) || 'page';
    link.href = url;
    link.download = `${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Screenshot saved', { tone: 'success' });
  } catch {
    toast('Could not save the screenshot', { tone: 'warn' });
  }
};

const applyZoom = (value) => {
  const next = setZoom(value);
  state.settings.zoom = next;
  saveSettings();
  toast(`Zoom ${Math.round(next * 100)}%`, { tone: 'info', timeout: 1500 });
};

/* -------------------------------------------------------------------- find */

const findState = { open: false, timer: null, query: '' };

const renderFindState = (matches, active) => {
  const hasQuery = Boolean(els.findInput?.value);
  els.findBar?.classList.toggle('is-empty', hasQuery && matches === 0);
  if (!els.findCount) return;
  els.findCount.textContent = hasQuery ? (matches ? `${active}/${matches}` : '0/0') : '';
};

const closeFind = ({ restoreFocus = true } = {}) => {
  if (!findState.open) return;
  findState.open = false;
  clearTimeout(findState.timer);
  if (els.findBar) els.findBar.hidden = true;
  if (els.findInput) els.findInput.value = '';
  if (state.activeId) send({ t: 'find:stop', tabId: state.activeId });
  if (restoreFocus) focusViewport();
};

const openFind = () => {
  const tab = activeTab();
  if (!tab?.url) {
    toast('Open a page to search inside it', { tone: 'info' });
    return;
  }
  findState.open = true;
  if (els.findBar) els.findBar.hidden = false;
  els.findInput?.focus({ preventScroll: true });
  els.findInput?.select();
  if (els.findInput?.value && state.activeId) {
    send({ t: 'find', tabId: state.activeId, text: els.findInput.value });
  }
};

const scheduleFind = (delay = 140) => {
  clearTimeout(findState.timer);
  findState.timer = setTimeout(() => {
    if (!state.activeId) return;
    findState.query = els.findInput?.value || '';
    send({ t: 'find', tabId: state.activeId, text: findState.query });
    if (!findState.query) renderFindState(0, 0);
  }, delay);
};

const stepFind = (forward) => {
  const text = els.findInput?.value || '';
  if (!text || !state.activeId) return;
  send({ t: 'find', tabId: state.activeId, text, findNext: true, forward });
};

const openShortcuts = () => {
  if (!els.shortcutsModal) return;
  els.shortcutsModal.hidden = false;
  els.shortcutsClose?.focus();
};

const closeShortcuts = () => {
  if (els.shortcutsModal) els.shortcutsModal.hidden = true;
};

/* ------------------------------------------------------------------- keys */

const wireGlobalKeys = () => {
  document.addEventListener(
    'keydown',
    (event) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const target = event.target;
      const inIme = target === els.ime;
      const editingField = isEditableTarget(target) && !inIme;
      const inOmni = target === els.omniInput;

      if (mod && !event.shiftKey && key === 't') {
        event.preventDefault();
        newTab();
        return;
      }
      if (mod && key === 'w') {
        event.preventDefault();
        if (state.activeId) closeTab(state.activeId);
        return;
      }
      if (mod && event.shiftKey && key === 't') {
        event.preventDefault();
        reopenClosed();
        return;
      }
      if (mod && key === 'l') {
        event.preventDefault();
        startOmniEdit();
        return;
      }
      if (mod && key === 'k') {
        event.preventDefault();
        openPalette();
        return;
      }
      if (mod && !event.shiftKey && key === 'h') {
        event.preventDefault();
        closeSettings();
        openHistory();
        return;
      }
      if (mod && event.shiftKey && key === 'b') {
        event.preventDefault();
        closeSettings();
        openBookmarks();
        return;
      }
      if (mod && event.shiftKey && key === 'a') {
        event.preventDefault();
        openTabSearch();
        return;
      }
      if (mod && event.key === ',') {
        event.preventDefault();
        closeManagers();
        openSettings();
        return;
      }
      if (mod && key === 'f') {
        event.preventDefault();
        openFind();
        return;
      }
      if (mod && (event.key === '/' || event.key === '?')) {
        event.preventDefault();
        openShortcuts();
        return;
      }
      if (mod && key === 'r') {
        event.preventDefault();
        reload();
        return;
      }
      if (mod && key === 'd') {
        event.preventDefault();
        toggleBookmark();
        return;
      }
      if (event.key === 'F5') {
        event.preventDefault();
        reload();
        return;
      }
      if (event.key === 'F11') {
        event.preventDefault();
        toggleFullscreen();
        return;
      }
      if (mod && ['+', '=', '-', '_', '0'].includes(event.key)) {
        event.preventDefault();
        if (event.key === '0') applyZoom(1);
        else applyZoom(getZoom() + (event.key === '-' || event.key === '_' ? -0.1 : 0.1));
        return;
      }
      if (mod && event.key === 'Tab') {
        event.preventDefault();
        cycleTab(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        goBack();
        return;
      }
      if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault();
        goForward();
        return;
      }
      if (mod && !event.shiftKey && /^[1-8]$/.test(event.key)) {
        event.preventDefault();
        const tabs = orderedTabs();
        const tab = tabs[Number(event.key) - 1];
        if (tab) activateTab(tab.id);
        return;
      }
      if (event.key === 'Escape') {
        if (findState.open) {
          closeFind();
          return;
        }
        if (!els.shortcutsModal?.hidden) {
          closeShortcuts();
          return;
        }
        if (closePalette()) return;
        if (managersOpen()) {
          closeManagers();
          return;
        }
        if (els.settingsPanel.classList.contains('is-open')) {
          closeSettings();
          return;
        }
        if (!els.shortcutModal.hidden) {
          els.shortcutModal.hidden = true;
          return;
        }
        if (menu.isOpen()) {
          menu.close();
          return;
        }
        if (inOmni) {
          endOmniEdit();
          return;
        }
        if (activeTab()?.loading) stop();
        return;
      }

      if (inIme || editingField) return;
      if (!state.activeId || !activeTab()?.url) return;

      if (mod && (key === 'v' || key === 'x')) {
        event.preventDefault();
        pasteFromClipboard();
        return;
      }
      if (mod && key === 'c') {
        event.preventDefault();
        requestCopy();
        return;
      }
      if (forwardKey(event, 'down')) event.preventDefault();
    },
    { capture: true },
  );

  document.addEventListener(
    'keyup',
    (event) => {
      if (event.target === els.ime) return;
      if (isEditableTarget(event.target)) return;
      if (!state.activeId || !activeTab()?.url) return;
      forwardKey(event, 'up');
    },
    { capture: true },
  );

};

const toggleTabMute = (id) => {
  const tab = state.tabs.get(id);
  if (!tab) return;
  const muted = !tab.muted;
  upsertTab({ ...tab, muted });
  renderTabs();
  send({ t: 'tab:mute', id, muted });
};

const cycleTab = (direction) => {
  const tabs = orderedTabs();
  if (!tabs.length) return;
  const index = tabs.findIndex((tab) => tab.id === state.activeId);
  const next = tabs[((index < 0 ? 0 : index) + direction + tabs.length) % tabs.length];
  if (next) activateTab(next.id);
};

/* ------------------------------------------------------------------ dialogs */

const wireDialogs = () => {
  els.dialogOk.addEventListener('click', () => respondDialog(true));
  els.dialogCancel.addEventListener('click', () => respondDialog(false));
  els.dialogModal.addEventListener('pointerdown', (event) => {
    if (event.target === els.dialogModal) respondDialog(false);
  });
  els.dialogInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') respondDialog(true);
  });
};

const showDialog = (dialog) => {
  if (!dialog) return;
  currentDialog = dialog;
  els.dialogTitle.textContent =
    dialog.type === 'alert' ? 'The page says' : dialog.type === 'confirm' ? 'Confirm' : 'The page asks';
  els.dialogMessage.textContent = dialog.message;
  els.dialogInput.hidden = dialog.type !== 'prompt';
  els.dialogInput.value = dialog.defaultValue || '';
  els.dialogCancel.hidden = dialog.type === 'alert';
  els.dialogModal.hidden = false;
  requestAnimationFrame(() => {
    if (dialog.type === 'prompt') els.dialogInput.focus();
    else els.dialogOk.focus();
  });
};

const respondDialog = (accept) => {
  if (!currentDialog) return;
  send({
    t: 'dialog',
    tabId: currentDialog.tabId || state.activeId,
    id: currentDialog.id,
    accept,
    text: accept ? els.dialogInput.value : undefined,
  });
  currentDialog = null;
  els.dialogModal.hidden = true;
};

/* -------------------------------------------------------------------- login */

const showLogin = (message) => {
  els.login.hidden = false;
  document.body.classList.add('is-locked');
  if (message) setLoginError(message);
  setTimeout(() => els.loginPassword?.focus(), 80);
};

const setLoginError = (message) => {
  els.loginError.hidden = !message;
  els.loginError.textContent = message || '';
};

const wireLogin = () => {
  if (els.loginBrand) {
    els.loginBrand.innerHTML = `${brandMark(30)}<span>Velocity<em>Proxy</em></span>`;
  }
  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = els.loginPassword.value;
    if (!password) return;
    els.loginSubmit.disabled = true;
    els.loginSubmit.textContent = 'Signing in…';
    setLoginError('');
    try {
      await api.post('/api/login', { password });
      els.loginPassword.value = '';
      boots += 1;
      await loadSession();
    } catch (error) {
      setLoginError(error.message || 'Sign in failed');
      els.loginForm.classList.remove('is-shaking');
      void els.loginForm.offsetWidth;
      els.loginForm.classList.add('is-shaking');
    } finally {
      els.loginSubmit.disabled = false;
      els.loginSubmit.textContent = 'Continue';
    }
  });
};

/* -------------------------------------------------------------------- audio */

const renderAudio = () => {
  const snap = audioEngine.snapshot();
  if (els.audioBtn) {
    els.audioBtn.innerHTML = icon(snap.muted ? 'volumeX' : 'volume', 18);
    els.audioBtn.dataset.state = snap.available === false ? 'off' : snap.status;
    els.audioBtn.classList.toggle('is-muted', snap.muted);
    els.audioBtn.title =
      snap.available === false
        ? `Audio unavailable: ${snap.reason}`
        : snap.muted
          ? 'Unmute audio'
          : 'Mute audio';
  }
  if (els.audioStatus) {
    els.audioStatus.textContent =
      snap.available === false
        ? snap.reason || 'Audio is unavailable on this server.'
        : snap.status === 'live'
          ? `Live · ${snap.backend || 'Opus'} · ${Math.round(snap.volume * 100)}%`
          : snap.status === 'starting'
            ? 'Starting audio capture…'
            : snap.status === 'reconnecting'
              ? 'Reconnecting audio…'
              : 'Ready · starts when you interact with the page';
  }
  if (els.audioMute) {
    els.audioMute.textContent = snap.muted ? 'Unmute audio' : 'Mute audio';
    els.audioMute.disabled = snap.available === false;
  }
  if (els.volumeRange && document.activeElement !== els.volumeRange) {
    els.volumeRange.value = String(Math.round(snap.volume * 100));
  }
  const volumeLabel = document.getElementById('audio-volume-label');
  if (volumeLabel) volumeLabel.textContent = `${Math.round(snap.volume * 100)}%`;
  if (els.audioNotice) {
    const show = snap.blocked && snap.started;
    els.audioNotice.hidden = !show;
    document.body.classList.toggle('has-audio-notice', show);
    if (show && els.audioNoticeText) {
      els.audioNoticeText.textContent = 'Your browser blocked autoplay. Enable audio to hear this page.';
    }
  }
};

const wireAudio = () => {
  audioEngine.setVolume(state.settings.volume ?? 0.8, { silent: true });
  audioEngine.setMuted(Boolean(state.settings.muted));
  renderAudio();
  audioEngine.init().then(renderAudio).catch(() => {});
  audioEngine.addEventListener('state', renderAudio);

  els.audioBtn?.addEventListener('click', () => {
    if (!audioEngine.started) {
      audioEngine.enable().then(renderAudio).catch(() => {});
      return;
    }
    audioEngine.setMuted(!audioEngine.muted);
    state.settings.muted = audioEngine.muted;
    saveSettings();
    renderAudio();
  });

  els.audioMute?.addEventListener('click', () => {
    audioEngine.setMuted(!audioEngine.muted);
    state.settings.muted = audioEngine.muted;
    saveSettings();
    renderAudio();
  });

  els.audioEnable?.addEventListener('click', () => {
    audioEngine.enable().then(renderAudio).catch(() => {});
  });

  els.volumeRange?.addEventListener('input', () => {
    audioEngine.setVolume(Number(els.volumeRange.value) / 100, { silent: true });
    state.settings.volume = audioEngine.volume;
    saveSettings();
    renderAudio();
  });

  // Browsers only allow audio after a gesture. One click anywhere is enough.
  document.addEventListener(
    'pointerdown',
    () => {
      if (state.settings.audioAutostart === false) return;
      audioEngine.enable().then(renderAudio).catch(() => {});
    },
    { once: true, capture: true },
  );
};

/* --------------------------------------------------------------------- init */

const wireSettingsEvents = () => {
  document.addEventListener('velocity:settings', () => {
    updatePlaceholder();
    refreshHome();
    renderOmnibox();
  });
  document.addEventListener('velocity:quality', (event) => {
    const value = Number(event.detail);
    if (state.activeId) sendTab({ t: 'quality', value });
  });
  document.addEventListener('velocity:history', () => {
    refreshHome();
  });
  document.addEventListener('velocity:shortcuts', () => {
    refreshHome();
    renderToolbar();
  });
  document.addEventListener('velocity:open-shortcuts', openShortcuts);
  document.addEventListener('velocity:home', () => refreshHome());
};

const paletteActions = {
  activateTab,
  findInPage: openFind,
  shortcuts: openShortcuts,
  newTab,
  closeTab,
  navigate,
  reload,
  goBack,
  goForward,
  goHome,
  openSettings,
  openSystem,
  reopenClosed,
  toggleFullscreen,
  zoomIn: () => applyZoom(getZoom() + 0.1),
  zoomOut: () => applyZoom(getZoom() - 0.1),
  resetZoom: () => applyZoom(1),
  screenshot: () => sendTab({ t: 'screenshot' }),
  bookmark: toggleBookmark,
  copyUrl: () => {
    const tab = activeTab();
    if (tab?.url) copyText(tab.url);
  },
  toggleMute: () => {
    if (!audioEngine.started) {
      audioEngine.enable().then(renderAudio).catch(() => {});
      return;
    }
    audioEngine.setMuted(!audioEngine.muted);
    state.settings.muted = audioEngine.muted;
    saveSettings();
    renderAudio();
  },
  toggleTheme: () => {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    setTheme(current === 'light' ? 'dark' : 'light');
  },
  releaseIdle: async () => {
    try {
      const result = await api.post('/api/reclaim');
      const released = Number(result?.released) || 0;
      toast(
        released ? `Released ${released} idle browser${released === 1 ? '' : 's'}` : 'Nothing idle to release',
        { tone: released ? 'success' : 'info' },
      );
    } catch (error) {
      toast(error.message || 'Could not release browsers', { tone: 'warn' });
    }
  },
};

const start = async () => {
  cacheElements();
  applyThemePreference();
  initSettings();
  wireAudio();
  initViewport({ send });
  setZoom(state.settings.zoom || 1);
  initHome({ onNavigate: navigate, onActivateTab: resumeTab });
  initPalette({ actions: paletteActions });
  initLibrary({ navigate, openInNewTab: newTabWithUrl });
  initSystem();
  wireChrome();
  wireOmnibox();
  wireDialogs();
  wireLogin();
  wireConnection();
  wireGlobalKeys();
  wireSettingsEvents();
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (state.settings.theme === 'system') applyThemePreference();
  });
  await loadSession();
  if (!els.app.classList.contains('is-newtab')) applyActiveView();
};

start().catch((error) => {
  console.error(error);
  toast('Velocity failed to initialise. Check the console.', { tone: 'warn' });
});
