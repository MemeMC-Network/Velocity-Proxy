import { icon } from './icons.js';
import { api } from './net.js';
import {
  addBookmark,
  bookmarkFolders,
  findBookmark,
  removeBookmark,
  removeSpace,
  reorderBookmarks,
  saveSpace,
  state,
  updateBookmark,
} from './store.js';
import { faviconNode, menu, toast } from './ui.js';

let navigate = () => {};
let openInNewTab = () => {};
let initialized = false;

const dom = {};
let editingId = null;
let activeFolder = '';
let dragId = null;

const hostOf = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return String(url || '');
  }
};

const faviconFor = (url, size = 14) => {
  const host = hostOf(url);
  return faviconNode(host ? `/api/favicon?host=${encodeURIComponent(host)}` : null, host, size);
};

const openUrl = (url) => {
  if (!url) return;
  if (state.settings.bookmarksNewTab) openInNewTab(url);
  else navigate(url);
};

/* ------------------------------------------------------------------- render */

export const renderBookmarkBar = () => {
  if (!dom.bar) return;
  const items = state.bookmarks.slice(0, 14);
  const visible = Boolean(state.settings.bookmarksBar) && items.length > 0;
  dom.bar.hidden = !visible;
  if (!visible) return;
  dom.bar.innerHTML = '';
  for (const bookmark of items) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bookmark-chip';
    chip.title = bookmark.url;
    chip.appendChild(faviconFor(bookmark.url, 13));
    const label = document.createElement('span');
    label.textContent = bookmark.title || hostOf(bookmark.url);
    chip.appendChild(label);
    chip.addEventListener('click', () => openUrl(bookmark.url));
    chip.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        openInNewTab(bookmark.url);
      }
    });
    chip.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      menu.open(event.clientX, event.clientY, [
        { label: 'Open', icon: 'arrowRight', onSelect: () => navigate(bookmark.url) },
        { label: 'Open in a new tab', icon: 'plus', onSelect: () => openInNewTab(bookmark.url) },
        { label: 'Copy link', icon: 'link', onSelect: () => copy(bookmark.url) },
        { separator: true },
        { label: 'Edit…', icon: 'edit', onSelect: () => openBookmarkModal(bookmark.id) },
        { label: 'Remove', icon: 'trash', danger: true, onSelect: () => deleteBookmark(bookmark.id) },
      ]);
    });
    dom.bar.appendChild(chip);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'bookmark-chip bookmark-more';
  more.innerHTML = `${icon('more', 14)}<span>All bookmarks</span>`;
  more.addEventListener('click', () => openBookmarks());
  dom.bar.appendChild(more);
};

export const renderHomeBookmarks = () => {
  const section = document.getElementById('bookmarks-home-section');
  const row = document.getElementById('bookmarks-home');
  if (!section || !row) return;
  const items = state.bookmarks.slice(0, 8);
  section.hidden = !state.settings.homeBookmarks || items.length === 0;
  if (section.hidden) return;
  row.innerHTML = '';
  for (const bookmark of items) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bookmark-item-chip';
    chip.title = bookmark.url;
    chip.appendChild(faviconFor(bookmark.url, 13));
    const label = document.createElement('span');
    label.textContent = bookmark.title || hostOf(bookmark.url);
    chip.appendChild(label);
    chip.addEventListener('click', () => openUrl(bookmark.url));
    chip.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      menu.open(event.clientX, event.clientY, [
        { label: 'Open in a new tab', icon: 'plus', onSelect: () => openInNewTab(bookmark.url) },
        { label: 'Edit…', icon: 'edit', onSelect: () => openBookmarkModal(bookmark.id) },
        { label: 'Remove', icon: 'trash', danger: true, onSelect: () => deleteBookmark(bookmark.id) },
      ]);
    });
    row.appendChild(chip);
  }
};

const bookmarkRow = (bookmark) => {
  const row = document.createElement('li');
  row.className = 'manager-row';
  row.draggable = true;
  row.dataset.id = bookmark.id;

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'manager-row-main';
  main.appendChild(faviconFor(bookmark.url, 16));
  const text = document.createElement('span');
  text.className = 'manager-row-text';
  const title = document.createElement('strong');
  title.textContent = bookmark.title || hostOf(bookmark.url);
  const meta = document.createElement('span');
  meta.textContent = bookmark.folder ? `${hostOf(bookmark.url)} · ${bookmark.folder}` : hostOf(bookmark.url);
  text.append(title, meta);
  main.appendChild(text);
  main.addEventListener('click', () => openUrl(bookmark.url));

  const actions = document.createElement('span');
  actions.className = 'manager-row-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'icon-btn';
  edit.setAttribute('aria-label', 'Edit bookmark');
  edit.innerHTML = icon('edit', 14);
  edit.addEventListener('click', () => openBookmarkModal(bookmark.id));
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn';
  del.setAttribute('aria-label', 'Remove bookmark');
  del.innerHTML = icon('trash', 14);
  del.addEventListener('click', () => deleteBookmark(bookmark.id));
  actions.append(edit, del);

  row.append(main, actions);

  row.addEventListener('dragstart', (event) => {
    dragId = bookmark.id;
    row.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => {
    dragId = null;
    row.classList.remove('is-dragging');
  });
  row.addEventListener('dragover', (event) => {
    if (!dragId || dragId === bookmark.id) return;
    event.preventDefault();
  });
  row.addEventListener('drop', (event) => {
    event.preventDefault();
    if (!dragId || dragId === bookmark.id) return;
    const ids = filteredBookmarks().map((item) => item.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(bookmark.id);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    reorderBookmarks(ids);
    renderBookmarks();
    renderBookmarkBar();
    renderHomeBookmarks();
    dragId = null;
  });

  return row;
};

const filteredBookmarks = () => {
  const query = (dom.search?.value || '').trim().toLowerCase();
  return state.bookmarks.filter((bookmark) => {
    if (activeFolder && bookmark.folder !== activeFolder) return false;
    if (!query) return true;
    return (
      bookmark.title.toLowerCase().includes(query) ||
      bookmark.url.toLowerCase().includes(query) ||
      (bookmark.folder || '').toLowerCase().includes(query)
    );
  });
};

export const renderBookmarks = () => {
  if (!dom.list) return;
  const folders = bookmarkFolders();
  dom.folders.innerHTML = '';
  const all = document.createElement('button');
  all.type = 'button';
  all.className = `folder-chip${activeFolder ? '' : ' is-active'}`;
  all.textContent = 'All';
  all.addEventListener('click', () => {
    activeFolder = '';
    renderBookmarks();
  });
  dom.folders.appendChild(all);
  for (const folder of folders) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `folder-chip${activeFolder === folder ? ' is-active' : ''}`;
    chip.textContent = folder;
    chip.addEventListener('click', () => {
      activeFolder = folder;
      renderBookmarks();
    });
    dom.folders.appendChild(chip);
  }

  dom.list.innerHTML = '';
  const items = filteredBookmarks();
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'manager-empty';
    empty.textContent = state.bookmarks.length
      ? 'No bookmark matches that filter.'
      : 'No bookmarks yet. Press Ctrl+D on a page, or add one here.';
    dom.list.appendChild(empty);
  } else {
    for (const bookmark of items) dom.list.appendChild(bookmarkRow(bookmark));
  }
  if (dom.count) {
    dom.count.textContent = `${items.length} of ${state.bookmarks.length}`;
  }
  if (dom.sub) {
    dom.sub.textContent = state.bookmarks.length
      ? `${state.bookmarks.length} saved · ${folders.length} folder${folders.length === 1 ? '' : 's'}`
      : 'Everything you save lives here.';
  }
  if (dom.folderList) {
    dom.folderList.innerHTML = folders.map((folder) => `<option value="${escapeAttr(folder)}"></option>`).join('');
  }
};

const escapeAttr = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* --------------------------------------------------------------- bookmarks */

export const openBookmarks = () => {
  initLibrary({});
  closeManagers();
  dom.bookmarks?.classList.add('is-open');
  dom.bookmarks?.setAttribute('aria-hidden', 'false');
  document.body.classList.add('panel-open');
  if (dom.backdrop) dom.backdrop.hidden = false;
  renderBookmarks();
  requestAnimationFrame(() => dom.search?.focus());
};

export const openHistory = () => {
  initLibrary({});
  closeManagers();
  dom.history?.classList.add('is-open');
  dom.history?.setAttribute('aria-hidden', 'false');
  document.body.classList.add('panel-open');
  if (dom.backdrop) dom.backdrop.hidden = false;
  renderHistory();
  requestAnimationFrame(() => dom.historySearch?.focus());
};

export const closeManagers = () => {
  for (const panel of [dom.bookmarks, dom.history]) {
    panel?.classList.remove('is-open');
    panel?.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('panel-open');
  if (dom.backdrop) dom.backdrop.hidden = true;
};

export const managersOpen = () =>
  Boolean(dom.bookmarks?.classList.contains('is-open') || dom.history?.classList.contains('is-open'));

const openBookmarkModal = (id) => {
  const bookmark = state.bookmarks.find((item) => item.id === id);
  editingId = bookmark ? bookmark.id : null;
  dom.modalTitle.textContent = bookmark ? 'Edit bookmark' : 'New bookmark';
  dom.name.value = bookmark?.title || '';
  dom.url.value = bookmark?.url || '';
  dom.folder.value = bookmark?.folder || activeFolder || '';
  dom.modal.hidden = false;
  requestAnimationFrame(() => (bookmark ? dom.name : dom.url).focus());
};

const closeBookmarkModal = () => {
  dom.modal.hidden = true;
  editingId = null;
};

const saveBookmarkModal = () => {
  let url = dom.url.value.trim();
  if (!url) {
    toast('A bookmark needs a URL', { tone: 'warn' });
    return;
  }
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    toast('That URL is not valid', { tone: 'warn' });
    return;
  }
  const title = dom.name.value.trim() || hostOf(url);
  const folder = dom.folder.value.trim();
  if (editingId) {
    updateBookmark(editingId, { title, url, folder });
    toast('Bookmark updated', { tone: 'success' });
  } else {
    if (findBookmark(url)) {
      toast('That page is already bookmarked', { tone: 'info' });
      return;
    }
    addBookmark({ title, url, folder });
    toast('Bookmark saved', { tone: 'success' });
  }
  closeBookmarkModal();
  renderBookmarks();
  renderBookmarkBar();
  renderHomeBookmarks();
};

const deleteBookmark = (id) => {
  const bookmark = state.bookmarks.find((item) => item.id === id);
  removeBookmark(id);
  renderBookmarks();
  renderBookmarkBar();
  renderHomeBookmarks();
  toast(bookmark ? `Removed ${bookmark.title}` : 'Bookmark removed', { tone: 'info' });
};

export const toggleBookmarkFor = (tab) => {
  if (!tab?.url) return false;
  const existing = findBookmark(tab.url);
  if (existing) {
    removeBookmark(existing.id);
    renderBookmarkBar();
    renderHomeBookmarks();
    renderBookmarks();
    toast('Bookmark removed', { tone: 'info' });
    return false;
  }
  addBookmark({ title: tab.title || hostOf(tab.url), url: tab.url, folder: '' });
  renderBookmarkBar();
  renderHomeBookmarks();
  renderBookmarks();
  toast('Bookmark saved', { tone: 'success' });
  return true;
};

export const exportBookmarks = () => {
  const payload = { version: 1, exportedAt: new Date().toISOString(), bookmarks: state.bookmarks };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `velocity-bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Exported ${state.bookmarks.length} bookmark${state.bookmarks.length === 1 ? '' : 's'}`, { tone: 'success' });
};

const parseNetscape = (text) => {
  const out = [];
  const pattern = /<DT><A[^>]*HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi;
  let match;
  while ((match = pattern.exec(text))) {
    out.push({ url: match[1], title: match[2] || match[1], folder: '' });
  }
  return out;
};

const importBookmarks = async (file) => {
  try {
    const text = await file.text();
    let entries = [];
    if (/<DT>|<A HREF/i.test(text)) {
      entries = parseNetscape(text);
    } else {
      const parsed = JSON.parse(text);
      entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.bookmarks) ? parsed.bookmarks : [];
    }
    let added = 0;
    for (const entry of entries) {
      if (!entry?.url || !/^https?:\/\//i.test(entry.url)) continue;
      if (findBookmark(entry.url)) continue;
      addBookmark({ title: entry.title || hostOf(entry.url), url: entry.url, folder: entry.folder || '' });
      added += 1;
    }
    renderBookmarks();
    renderBookmarkBar();
    renderHomeBookmarks();
    toast(added ? `Imported ${added} bookmark${added === 1 ? '' : 's'}` : 'Nothing new to import', {
      tone: added ? 'success' : 'info',
    });
  } catch {
    toast('That file could not be read as bookmarks', { tone: 'warn' });
  }
};

/* ----------------------------------------------------------------- history */

const dayLabel = (timestamp) => {
  const date = new Date(timestamp || 0);
  const now = new Date();
  const startOf = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (!timestamp || !Number.isFinite(days) || days < 0) return 'Earlier';
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
};

const historyEntries = () => {
  const query = (dom.historySearch?.value || '').trim().toLowerCase();
  const filter = dom.historyFilter?.value || 'all';
  const now = Date.now();
  const cutoff = filter === 'today' ? startOfDay(now) : filter === 'week' ? now - 7 * 86_400_000 : 0;
  return [...state.history]
    .filter((entry) => entry && entry.url)
    .filter((entry) => !cutoff || (entry.ts || 0) >= cutoff)
    .filter((entry) => {
      if (!query) return true;
      return (
        (entry.title || '').toLowerCase().includes(query) ||
        entry.url.toLowerCase().includes(query) ||
        (entry.host || '').toLowerCase().includes(query)
      );
    })
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
};

const startOfDay = (timestamp) => {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

const historyRow = (entry) => {
  const item = document.createElement('li');
  item.className = 'manager-row';
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'manager-row-main';
  main.appendChild(faviconFor(entry.url, 16));
  const text = document.createElement('span');
  text.className = 'manager-row-text';
  const title = document.createElement('strong');
  title.textContent = entry.title || hostOf(entry.url);
  const meta = document.createElement('span');
  const time = entry.ts
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(entry.ts))
    : '';
  meta.textContent = [hostOf(entry.url), time, entry.visits > 1 ? `${entry.visits} visits` : '']
    .filter(Boolean)
    .join(' · ');
  text.append(title, meta);
  main.appendChild(text);
  main.addEventListener('click', () => openUrl(entry.url));

  const actions = document.createElement('span');
  actions.className = 'manager-row-actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-btn';
  remove.setAttribute('aria-label', 'Remove from history');
  remove.innerHTML = icon('trash', 14);
  remove.addEventListener('click', () => deleteHistoryEntry(entry));
  actions.appendChild(remove);
  item.append(main, actions);
  return item;
};

const deleteHistoryEntry = async (entry) => {
  try {
    await api.del(`/api/history?url=${encodeURIComponent(entry.url)}`);
    state.history = state.history.filter((item) => item.url !== entry.url);
    renderHistory();
    document.dispatchEvent(new CustomEvent('velocity:history'));
    toast('Removed from history', { tone: 'info' });
  } catch (error) {
    toast(error.message || 'Could not remove that entry', { tone: 'warn' });
  }
};

export const renderHistory = () => {
  if (!dom.historyList) return;
  const entries = historyEntries();
  dom.historyList.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'manager-empty';
    empty.textContent = dom.historySearch?.value
      ? 'Nothing in history matches that search.'
      : 'No history in this period. Pages you visit will show up here.';
    dom.historyList.appendChild(empty);
  } else {
    let day = '';
    for (const entry of entries) {
      const label = dayLabel(entry.ts);
      if (label !== day) {
        day = label;
        const heading = document.createElement('li');
        heading.className = 'manager-day';
        heading.textContent = label;
        dom.historyList.appendChild(heading);
      }
      dom.historyList.appendChild(historyRow(entry));
    }
  }
  if (dom.historyCount) dom.historyCount.textContent = `${entries.length} visit${entries.length === 1 ? '' : 's'}`;
};

/* ------------------------------------------------------------- saved spaces */

export const renderSpaces = () => {
  if (!dom.spaceList) return;
  dom.spaceList.innerHTML = '';
  if (!state.spaces.length) {
    const empty = document.createElement('li');
    empty.className = 'settings-note';
    empty.textContent = 'No saved tab sets yet.';
    dom.spaceList.appendChild(empty);
    return;
  }
  for (const space of state.spaces) {
    const row = document.createElement('li');
    row.className = 'workspace-row';
    const name = document.createElement('strong');
    name.textContent = space.name;
    const count = document.createElement('span');
    count.textContent = `${space.tabs.length} tabs`;
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'btn ghost small';
    restore.textContent = 'Open';
    restore.addEventListener('click', async () => {
      closeManagers();
      for (const tab of space.tabs) {
        if (state.tabs.size >= (state.limits.maxTabs || 12)) break;
        openInNewTab(tab.url);
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
      toast(`Opening ${space.name}`, { tone: 'success' });
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn ghost small danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      removeSpace(space.id);
      renderSpaces();
      toast('Tab set deleted', { tone: 'info' });
    });
    row.append(name, count, restore, del);
    dom.spaceList.appendChild(row);
  }
};

export const saveCurrentSpace = (name) => {
  const tabs = state.order.map((id) => state.tabs.get(id)).filter((tab) => tab && tab.url);
  if (!tabs.length) {
    toast('There are no loaded tabs to save', { tone: 'info' });
    return;
  }
  saveSpace(name || `Tabs · ${new Date().toLocaleDateString()}`, tabs);
  renderSpaces();
  toast('Tab set saved', { tone: 'success' });
};

/* ---------------------------------------------------------------- utilities */

const copy = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied', { tone: 'success' });
  } catch {
    toast('Clipboard access was blocked', { tone: 'warn' });
  }
};

export const initLibrary = (options = {}) => {
  if (options.navigate) navigate = options.navigate;
  if (options.openInNewTab) openInNewTab = options.openInNewTab;
  if (initialized) return;
  initialized = true;

  dom.bar = document.getElementById('bookmarks-bar');
  dom.backdrop = document.getElementById('manager-backdrop');
  dom.bookmarks = document.getElementById('bookmarks-panel');
  dom.history = document.getElementById('history-panel');
  dom.list = document.getElementById('bookmarks-list');
  dom.folders = document.getElementById('bookmark-folders');
  dom.search = document.getElementById('bookmarks-search');
  dom.count = document.getElementById('bookmarks-count');
  dom.sub = document.getElementById('bookmarks-sub');
  dom.historyList = document.getElementById('history-list');
  dom.historySearch = document.getElementById('history-search');
  dom.historyFilter = document.getElementById('history-filter');
  dom.historyCount = document.getElementById('history-count');
  dom.modal = document.getElementById('bookmark-modal');
  dom.modalTitle = document.getElementById('bookmark-modal-title');
  dom.name = document.getElementById('bookmark-name');
  dom.url = document.getElementById('bookmark-url');
  dom.folder = document.getElementById('bookmark-folder');
  dom.folderList = document.getElementById('bookmark-folder-list');
  dom.spaceList = document.getElementById('workspace-list');

  const searchIcon = document.getElementById('bookmarks-search-icon');
  if (searchIcon) searchIcon.innerHTML = icon('search', 14);
  const historyIcon = document.getElementById('history-search-icon');
  if (historyIcon) historyIcon.innerHTML = icon('search', 14);

  document.getElementById('bookmarks-close')?.addEventListener('click', closeManagers);
  document.getElementById('history-close')?.addEventListener('click', closeManagers);
  dom.backdrop?.addEventListener('click', closeManagers);
  document.getElementById('bookmarks-btn')?.addEventListener('click', openBookmarks);
  document.getElementById('history-btn')?.addEventListener('click', openHistory);
  document.getElementById('bookmarks-home-all')?.addEventListener('click', openBookmarks);
  document.getElementById('bookmarks-new')?.addEventListener('click', () => openBookmarkModal(null));
  document.getElementById('bookmarks-export')?.addEventListener('click', exportBookmarks);
  document.getElementById('bookmarks-import')?.addEventListener('click', () =>
    document.getElementById('bookmarks-import-file')?.click(),
  );
  document.getElementById('bookmarks-import-file')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) importBookmarks(file);
    event.target.value = '';
  });
  dom.search?.addEventListener('input', renderBookmarks);
  dom.historySearch?.addEventListener('input', renderHistory);
  dom.historyFilter?.addEventListener('change', renderHistory);

  dom.name?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveBookmarkModal();
  });
  dom.url?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveBookmarkModal();
  });
  document.getElementById('bookmark-cancel')?.addEventListener('click', closeBookmarkModal);
  document.getElementById('bookmark-save')?.addEventListener('click', saveBookmarkModal);
  dom.modal?.addEventListener('pointerdown', (event) => {
    if (event.target === dom.modal) closeBookmarkModal();
  });

  document.getElementById('history-clear')?.addEventListener('click', async () => {
    try {
      await api.del('/api/history');
      state.history = [];
      renderHistory();
      document.dispatchEvent(new CustomEvent('velocity:history'));
      toast('Browsing history cleared', { tone: 'success' });
    } catch (error) {
      toast(error.message || 'Could not clear history', { tone: 'warn' });
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom.modal?.hidden) {
      event.preventDefault();
      closeBookmarkModal();
    }
  });

  renderBookmarkBar();
  renderHomeBookmarks();
  renderSpaces();
};

export const refreshLibrary = () => {
  if (!initialized) return;
  renderBookmarkBar();
  renderHomeBookmarks();
  if (dom.bookmarks?.classList.contains('is-open')) renderBookmarks();
  if (dom.history?.classList.contains('is-open')) renderHistory();
};
