import { icon } from './icons.js';
import { api } from './net.js';
import { engineName, saveSettings, saveShortcuts, state, DEFAULT_SHORTCUTS } from './store.js';
import { toast } from './ui.js';

const dom = {};
let initialized = false;

export const initSettings = () => {
  if (initialized) return;
  initialized = true;

  dom.panel = document.getElementById('settings-panel');
  dom.backdrop = document.getElementById('settings-backdrop');
  dom.themeButtons = Array.from(document.querySelectorAll('[data-theme-value]'));
  dom.engineSelect = document.getElementById('engine-select');
  dom.customWrap = document.getElementById('custom-template-wrap');
  dom.customTemplate = document.getElementById('custom-template');
  dom.quality = document.getElementById('quality-range');
  dom.qualityLabel = document.getElementById('quality-label');
  dom.clearHistory = document.getElementById('clear-history');
  dom.logout = document.getElementById('logout');
  dom.version = document.getElementById('version-label');
  dom.resetShortcuts = document.getElementById('reset-shortcuts');

  dom.backdrop?.addEventListener('click', closeSettings);
  document.getElementById('settings-close')?.addEventListener('click', closeSettings);
  document.getElementById('settings-btn')?.addEventListener('click', openSettings);

  dom.themeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setTheme(button.dataset.themeValue);
    });
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

  dom.engineSelect.innerHTML = [
    ...state.engines.map((engine) => `<option value="${engine.id}">${engine.name}</option>`),
    '<option value="custom">Custom…</option>',
  ].join('');

  sync();
};

export const openSettings = () => {
  initSettings();
  sync();
  dom.panel?.classList.add('is-open');
  dom.panel?.setAttribute('aria-hidden', 'false');
  if (dom.backdrop) dom.backdrop.hidden = false;
};

export const closeSettings = () => {
  dom.panel?.classList.remove('is-open');
  dom.panel?.setAttribute('aria-hidden', 'true');
  if (dom.backdrop) dom.backdrop.hidden = true;
};

export const setTheme = (value) => {
  state.settings.theme = value;
  saveSettings();
  applyThemePreference();
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
  sync();
};

const sync = () => {
  dom.themeButtons?.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.themeValue === (state.settings.theme || 'dark'));
  });
  if (dom.engineSelect) dom.engineSelect.value = state.settings.engine;
  if (dom.customWrap) dom.customWrap.hidden = state.settings.engine !== 'custom';
  if (dom.customTemplate) dom.customTemplate.value = state.settings.customTemplate || '';
  if (dom.quality) {
    dom.quality.value = String(state.settings.quality || 62);
    if (dom.qualityLabel) dom.qualityLabel.textContent = describeQuality(state.settings.quality || 62);
  }
  if (dom.version) dom.version.textContent = state.version ? `v${state.version}` : 'v1.0.0';
};

const describeQuality = (value) => {
  if (value <= 45) return `Data saver · ${value}%`;
  if (value <= 68) return `Balanced · ${value}%`;
  return `Sharp · ${value}%`;
};

export const refreshSettings = () => {
  if (initialized) sync();
};
