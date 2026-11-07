import { icon } from './icons.js';
import { api } from './net.js';
import { engineName, saveSettings, saveShortcuts, state, DEFAULT_SHORTCUTS } from './store.js';
import { refreshLibrary, renderSpaces, saveCurrentSpace } from './library.js';
import { toast } from './ui.js';

const dom = {};
let initialized = false;
let category = 'appearance';

const HOME_TOGGLES = [
  ['homeClock', 'home-clock-toggle'],
  ['homeGreeting', 'home-greeting-toggle'],
  ['homeRecent', 'home-recent-toggle'],
  ['homeFrequent', 'home-frequent-toggle'],
  ['homeBookmarks', 'home-bookmarks-toggle'],
];

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const initSettings = () => {
  if (initialized) return;
  initialized = true;

  dom.panel = document.getElementById('settings-panel');
  dom.backdrop = document.getElementById('settings-backdrop');
  dom.body = document.getElementById('settings-body');
  dom.nav = document.getElementById('settings-nav');
  dom.themeButtons = Array.from(document.querySelectorAll('[data-theme-value]'));
  dom.accentButtons = Array.from(document.querySelectorAll('[data-accent-value]'));
  dom.engineSelect = document.getElementById('engine-select');
  dom.customWrap = document.getElementById('custom-template-wrap');
  dom.customTemplate = document.getElementById('custom-template');
  dom.quality = document.getElementById('quality-range');
  dom.qualityLabel = document.getElementById('quality-label');
  dom.clearHistory = document.getElementById('clear-history');
  dom.logout = document.getElementById('logout');
  dom.version = document.getElementById('version-label');
  dom.versionFoot = document.getElementById('version-label-foot');
  dom.resetShortcuts = document.getElementById('reset-shortcuts');
  dom.startup = document.getElementById('startup-select');
  dom.historyEnabled = document.getElementById('history-enabled');
  dom.reduceMotion = document.getElementById('reduce-motion');
  dom.bgMode = document.getElementById('home-bg-mode');
  dom.bgUrl = document.getElementById('home-bg-url');
  dom.bgUrlWrap = document.getElementById('home-bg-url-wrap');
  dom.bgFile = document.getElementById('home-bg-file');
  dom.bgUploadWrap = document.getElementById('home-bg-upload-wrap');
  dom.bgClear = document.getElementById('home-bg-clear');
  dom.workspaceName = document.getElementById('workspace-name');
  dom.audioAutostart = document.getElementById('audio-autostart');
  dom.tabClose = document.getElementById('tab-close-toggle');
  dom.tabGroups = document.getElementById('tab-groups-toggle');
  dom.bookmarksNewTab = document.getElementById('bookmarks-newtab-toggle');

  dom.backdrop?.addEventListener('click', closeSettings);
  document.getElementById('settings-close')?.addEventListener('click', closeSettings);
  document.getElementById('settings-btn')?.addEventListener('click', openSettings);
  document.getElementById('home-customize')?.addEventListener('click', () => {
    openSettings();
    showCategory('appearance');
  });

  dom.nav?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-settings-cat]');
    if (button) showCategory(button.dataset.settingsCat);
  });

  dom.themeButtons.forEach((button) => {
    button.addEventListener('click', () => setTheme(button.dataset.themeValue));
  });

  dom.accentButtons.forEach((button) => {
    button.addEventListener('click', () => setAccent(button.dataset.accentValue));
  });

  for (const [key, id] of HOME_TOGGLES) {
    document.getElementById(id)?.addEventListener('change', (event) => {
      state.settings[key] = event.target.checked;
      saveSettings();
      if (key === 'homeBookmarks') refreshLibrary();
      document.dispatchEvent(new CustomEvent('velocity:home'));
    });
  }

  dom.bgMode?.addEventListener('change', () => {
    state.settings.homeBg = dom.bgMode.value;
    saveSettings();
    syncBackgroundFields();
    applyHomeBackground();
    document.dispatchEvent(new CustomEvent('velocity:home'));
  });

  dom.bgUrl?.addEventListener('change', () => {
    const value = dom.bgUrl.value.trim();
    state.settings.homeBgUrl = value;
    saveSettings();
    applyHomeBackground();
    toast(value ? 'Home background updated' : 'Background cleared', { tone: 'info' });
  });

  dom.bgFile?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      toast('Choose an image file', { tone: 'warn' });
      return;
    }
    if (file.size > 1.6 * 1024 * 1024) {
      toast('Keep the image under 1.6 MB so preferences stay small', { tone: 'warn' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.settings.homeImage = String(reader.result || '');
      state.settings.homeBg = 'upload';
      saveSettings();
      dom.bgMode.value = 'upload';
      syncBackgroundFields();
      applyHomeBackground();
      document.dispatchEvent(new CustomEvent('velocity:home'));
      toast('Background saved in this browser', { tone: 'success' });
    };
    reader.onerror = () => toast('That image could not be read', { tone: 'warn' });
    reader.readAsDataURL(file);
  });

  dom.bgClear?.addEventListener('click', () => {
    state.settings.homeBg = 'none';
    state.settings.homeBgUrl = '';
    state.settings.homeImage = '';
    saveSettings();
    if (dom.bgMode) dom.bgMode.value = 'none';
    if (dom.bgUrl) dom.bgUrl.value = '';
    syncBackgroundFields();
    applyHomeBackground();
    document.dispatchEvent(new CustomEvent('velocity:home'));
    toast('Background reset', { tone: 'info' });
  });

  dom.startup?.addEventListener('change', () => {
    state.settings.startup = dom.startup.value;
    saveSettings();
    toast(dom.startup.value === 'restore' ? 'Tabs will be restored on launch' : 'Velocity opens on the home page', {
      tone: 'info',
    });
  });

  dom.tabClose?.addEventListener('change', () => {
    state.settings.tabCloseAlways = dom.tabClose.checked;
    saveSettings();
    applyTabChrome();
  });

  dom.tabGroups?.addEventListener('change', () => {
    state.settings.tabGroups = dom.tabGroups.checked;
    saveSettings();
    applyTabChrome();
    document.dispatchEvent(new CustomEvent('velocity:settings', { detail: { key: 'tabGroups' } }));
  });

  dom.bookmarksNewTab?.addEventListener('change', () => {
    state.settings.bookmarksNewTab = dom.bookmarksNewTab.checked;
    saveSettings();
  });

  dom.reduceMotion?.addEventListener('change', () => {
    state.settings.reduceMotion = dom.reduceMotion.checked;
    saveSettings();
    applyMotion();
  });

  dom.audioAutostart?.addEventListener('change', () => {
    state.settings.audioAutostart = dom.audioAutostart.checked;
    saveSettings();
  });

  dom.engineSelect?.addEventListener('change', () => {
    state.settings.engine = dom.engineSelect.value;
    saveSettings();
    if (dom.customWrap) dom.customWrap.hidden = state.settings.engine !== 'custom';
    document.dispatchEvent(new CustomEvent('velocity:settings', { detail: { key: 'engine' } }));
    toast(`Search engine: ${state.settings.engine === 'custom' ? 'Custom' : engineName()}`, { tone: 'info' });
  });

  dom.customTemplate?.addEventListener('change', () => {
    const value = dom.customTemplate.value.trim();
    if (value && !value.includes('%s')) {
      toast('The template must contain %s where the query goes', { tone: 'warn' });
      return;
    }
    state.settings.customTemplate = value;
    saveSettings();
    document.dispatchEvent(new CustomEvent('velocity:settings', { detail: { key: 'customTemplate' } }));
    toast('Custom search template saved', { tone: 'success' });
  });

  dom.quality?.addEventListener('input', () => {
    const value = Number(dom.quality.value);
    state.settings.quality = value;
    if (dom.qualityLabel) dom.qualityLabel.textContent = describeQuality(value);
    document.dispatchEvent(new CustomEvent('velocity:quality', { detail: value }));
  });
  dom.quality?.addEventListener('change', () => saveSettings());

  dom.historyEnabled?.addEventListener('change', async () => {
    const enabled = dom.historyEnabled.checked;
    try {
      await api.post('/api/history/settings', { enabled });
      state.settings.historyEnabled = enabled;
      saveSettings();
      toast(enabled ? 'History recording on' : 'History recording off', { tone: 'info' });
    } catch (error) {
      dom.historyEnabled.checked = !enabled;
      toast(error.message || 'Could not change history settings', { tone: 'warn' });
    }
  });

  dom.clearHistory?.addEventListener('click', async () => {
    try {
      await api.del('/api/history');
      state.history = [];
      document.dispatchEvent(new CustomEvent('velocity:history'));
      toast('Browsing history cleared', { tone: 'success' });
    } catch (error) {
      toast(error.message || 'Could not clear history', { tone: 'warn' });
    }
  });

  dom.resetShortcuts?.addEventListener('click', () => {
    state.shortcuts = DEFAULT_SHORTCUTS.slice();
    saveShortcuts();
    document.dispatchEvent(new CustomEvent('velocity:shortcuts'));
    toast('Shortcuts restored', { tone: 'success' });
  });

  document.getElementById('open-shortcuts')?.addEventListener('click', () => {
    closeSettings();
    document.dispatchEvent(new CustomEvent('velocity:open-shortcuts'));
  });

  document.getElementById('open-perf')?.addEventListener('click', () => {
    closeSettings();
    document.dispatchEvent(new CustomEvent('velocity:open-perf'));
  });

  document.getElementById('workspace-save')?.addEventListener('click', () => {
    saveCurrentSpace(dom.workspaceName?.value.trim());
    if (dom.workspaceName) dom.workspaceName.value = '';
  });

  dom.logout?.addEventListener('click', async () => {
    try {
      await api.post('/api/logout');
    } catch {
      /* ignore */
    }
    window.location.reload();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dom.panel?.classList.contains('is-open')) {
      event.preventDefault();
      closeSettings();
    }
  });

  document.addEventListener('velocity:settings-cat', (event) => showCategory(event.detail));

  dom.engineSelect.innerHTML = [
    ...state.engines.map((engine) => `<option value="${escapeAttr(engine.id)}">${escapeAttr(engine.name)}</option>`),
    '<option value="custom">Custom…</option>',
  ].join('');

  const searchIcon = document.getElementById('bookmarks-search-icon');
  if (searchIcon && !searchIcon.innerHTML) searchIcon.innerHTML = icon('search', 14);

  applyAppearance();
  showCategory(category);
  sync();
};

export const showCategory = (next) => {
  category = next || 'appearance';
  dom.nav?.querySelectorAll('[data-settings-cat]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.settingsCat === category);
  });
  dom.body?.querySelectorAll('.settings-group').forEach((group) => {
    group.classList.toggle('is-active', group.dataset.cat === category);
  });
};

export const openSettings = () => {
  initSettings();
  sync();
  if (category === 'workspaces') renderSpaces();
  dom.panel?.classList.add('is-open');
  dom.panel?.setAttribute('aria-hidden', 'false');
  document.body.classList.add('panel-open');
  if (dom.backdrop) dom.backdrop.hidden = false;
  loadAbout();
};

export const closeSettings = () => {
  dom.panel?.classList.remove('is-open');
  dom.panel?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('panel-open');
  if (dom.backdrop) dom.backdrop.hidden = true;
};

export const setTheme = (value) => {
  state.settings.theme = value;
  saveSettings();
  applyThemePreference();
  sync();
};

export const setAccent = (value) => {
  state.settings.accent = value;
  saveSettings();
  applyAccent();
  sync();
};

export const applyThemePreference = () => {
  const preference = state.settings.theme || 'dark';
  const resolved =
    preference === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.body.classList.toggle('is-light', resolved === 'light');
  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.innerHTML = icon(resolved === 'light' ? 'moon' : 'sun', 18);
    toggle.title = resolved === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f4f3ef' : '#08090a');
  sync();
};

const applyAccent = () => {
  const accent = state.settings.accent || 'ember';
  document.documentElement.dataset.accent = accent;
  sync();
};

const applyMotion = () => {
  document.body.classList.toggle('reduce-motion', Boolean(state.settings.reduceMotion));
};

const applyTabChrome = () => {
  document.body.classList.toggle('hide-tab-groups', !state.settings.tabGroups);
  document.body.classList.toggle('hide-tab-close', !state.settings.tabCloseAlways);
};

export const applyHomeBackground = () => {
  const mode = state.settings.homeBg || 'none';
  document.body.dataset.homeBg = mode;
  let url = '';
  if (mode === 'image') url = state.settings.homeBgUrl || '';
  else if (mode === 'upload') url = state.settings.homeImage || '';
  if (url) {
    const safe = String(url).replace(/"/g, '%22').replace(/\)/g, '%29');
    document.documentElement.style.setProperty('--home-image', `url("${safe}")`);
  } else {
    document.documentElement.style.removeProperty('--home-image');
  }
};

const applyAppearance = () => {
  applyThemePreference();
  applyAccent();
  applyMotion();
  applyTabChrome();
  applyHomeBackground();
};

const syncBackgroundFields = () => {
  const mode = state.settings.homeBg || 'none';
  if (dom.bgMode) dom.bgMode.value = mode;
  if (dom.bgUrlWrap) dom.bgUrlWrap.hidden = mode !== 'image';
  if (dom.bgUploadWrap) dom.bgUploadWrap.hidden = mode !== 'upload';
  if (dom.bgUrl) dom.bgUrl.value = state.settings.homeBgUrl || '';
};

const sync = () => {
  if (!initialized) return;
  dom.themeButtons?.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.themeValue === (state.settings.theme || 'dark'));
  });
  dom.accentButtons?.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.accentValue === (state.settings.accent || 'ember'));
  });
  if (dom.engineSelect) dom.engineSelect.value = state.settings.engine;
  if (dom.customWrap) dom.customWrap.hidden = state.settings.engine !== 'custom';
  if (dom.customTemplate) dom.customTemplate.value = state.settings.customTemplate || '';
  if (dom.quality) {
    dom.quality.value = String(state.settings.quality || 62);
    if (dom.qualityLabel) dom.qualityLabel.textContent = describeQuality(state.settings.quality || 62);
  }
  if (dom.startup) dom.startup.value = state.settings.startup || 'restore';
  if (dom.historyEnabled) dom.historyEnabled.checked = state.settings.historyEnabled !== false;
  if (dom.reduceMotion) dom.reduceMotion.checked = Boolean(state.settings.reduceMotion);
  if (dom.tabClose) dom.tabClose.checked = Boolean(state.settings.tabCloseAlways);
  if (dom.tabGroups) dom.tabGroups.checked = state.settings.tabGroups !== false;
  if (dom.bookmarksNewTab) dom.bookmarksNewTab.checked = Boolean(state.settings.bookmarksNewTab);
  if (dom.audioAutostart) dom.audioAutostart.checked = state.settings.audioAutostart !== false;
  for (const [key, id] of HOME_TOGGLES) {
    const input = document.getElementById(id);
    if (input) input.checked = state.settings[key] !== false;
  }
  syncBackgroundFields();
  if (dom.version) dom.version.textContent = state.version ? `v${state.version}` : 'v1.0.0';
  if (dom.versionFoot) dom.versionFoot.textContent = state.version ? `v${state.version}` : 'v1.0.0';
  const limit = document.getElementById('tab-limit-note');
  if (limit) {
    limit.textContent = state.limits?.maxTabs
      ? `This workspace allows ${state.limits.maxTabs} tabs at once. Groups, pinning and reordering are kept in this browser.`
      : 'Tabs are limited by the server to keep each browser session responsive.';
  }
};

const loadAbout = async () => {
  try {
    const health = await api.get('/api/health');
    const runtime = document.getElementById('about-runtime');
    const browser = document.getElementById('about-browser');
    const sandbox = document.getElementById('about-sandbox');
    if (runtime) runtime.textContent = health.uptime ? `Node · up ${Math.round(health.uptime / 60)}m` : 'Node';
    if (browser) browser.textContent = health.browser === 'ready' ? 'Chromium ready' : 'Chromium starting';
    if (sandbox) sandbox.textContent = health.sandbox === 'enabled' ? 'Enabled' : 'Disabled';
  } catch {
    /* the about section is informational */
  }
};

const describeQuality = (value) => {
  if (value <= 45) return `Data saver · ${value}%`;
  if (value <= 68) return `Balanced · ${value}%`;
  return `Sharp · ${value}%`;
};

export const refreshSettings = () => {
  if (initialized) sync();
};
