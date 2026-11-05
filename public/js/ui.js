import { icon, monogram } from './icons.js';
import { engineName, state } from './store.js';
import { api } from './net.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export const el = (tag, className, html) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
};

let toastHost = null;

export const toast = (message, { tone = 'info', timeout = 3400 } = {}) => {
  if (!toastHost) toastHost = document.getElementById('toasts');
  if (!toastHost) return;
  const node = el('div', `toast toast-${tone}`);
  node.innerHTML = `<span class="toast-dot"></span><span class="toast-text"></span>`;
  node.querySelector('.toast-text').textContent = message;
  toastHost.appendChild(node);
  requestAnimationFrame(() => node.classList.add('is-visible'));
  const remove = () => {
    node.classList.remove('is-visible');
    setTimeout(() => node.remove(), 240);
  };
  setTimeout(remove, timeout);
  node.addEventListener('click', remove);
};

export const hostColor = (seed) => {
  let hash = 0;
  const text = String(seed || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 360;
  }
  return hash;
};

export const fallbackIcon = (label, seed, size = 16) => {
  const node = el('span', 'favicon-fallback');
  node.style.setProperty('--mono-h', hostColor(seed || label));
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  node.style.fontSize = `${Math.max(9, Math.round(size * 0.58))}px`;
  node.textContent = String(label || '?').trim().charAt(0).toUpperCase() || '?';
  return node;
};

export const faviconNode = (url, host, size = 16) => {
  const wrap = el('span', 'favicon');
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  if (url) {
    const image = document.createElement('img');
    image.src = url;
    image.alt = '';
    image.width = size;
    image.height = size;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => {
      image.remove();
      wrap.appendChild(fallbackIcon(host || '?', host, size));
    });
    wrap.appendChild(image);
  } else {
    wrap.appendChild(fallbackIcon(host || '?', host, size));
  }
  return wrap;
};

export const timeAgo = (timestamp) => {
  const seconds = Math.max(0, Math.round((Date.now() - (timestamp || Date.now())) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

export const prettyHost = (host) => String(host || '').replace(/^www\./, '');

export const debounce = (fn, wait = 160) => {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
};

export const loadImage = (src) =>
  new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });

export const svgButton = (name, label, size = 18) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = icon(name, size);
  return button;
};

/** Positioned popup menu shared by tabs, shortcuts and quick actions. */
export class ContextMenu {
  constructor(element) {
    this.element = element;
    this.onClose = null;
    document.addEventListener('pointerdown', (event) => {
      if (!this.isOpen()) return;
      if (!this.element.contains(event.target)) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen()) {
        event.preventDefault();
        this.close();
      }
    });
    window.addEventListener('resize', () => this.close());
    window.addEventListener('blur', () => this.close());
  }

  isOpen() {
    return this.element.classList.contains('is-open');
  }

  open(x, y, items) {
    this.element.innerHTML = '';
    for (const item of items) {
      if (item.separator) {
        this.element.appendChild(el('div', 'menu-separator'));
        continue;
      }
      const button = el('button', `menu-item${item.danger ? ' danger' : ''}`);
      button.type = 'button';
      button.innerHTML = `${item.icon ? icon(item.icon, 16) : ''}<span></span>${item.hint ? `<kbd>${item.hint}</kbd>` : ''}`;
      button.querySelector('span').textContent = item.label;
      button.addEventListener('click', () => {
        this.close();
        item.onSelect?.();
      });
      this.element.appendChild(button);
    }
    this.element.classList.add('is-open');
    this.element.style.visibility = 'hidden';
    this.element.style.left = '0px';
    this.element.style.top = '0px';
    const rect = this.element.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 12);
    const top = Math.min(Math.max(8, y), window.innerHeight - rect.height - 12);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
    this.element.style.visibility = 'visible';
  }

  close() {
    this.element.classList.remove('is-open');
  }
}

/** Shared singleton menu bound to the element in the app shell. */
export const menu = new ContextMenu(document.getElementById('context-menu'));

/** Search suggestion engine shared by the omnibox and the new tab page. */
export const createSuggester = ({ input, panel, onSubmit, getPrefixItems }) => {
  let items = [];
  let selected = -1;
  let requestToken = 0;
  let lastQuery = '';
  let remote = [];

  const hide = () => {
    items = [];
    selected = -1;
    panel.innerHTML = '';
    panel.classList.remove('is-open');
  };

  const render = () => {
    panel.innerHTML = '';
    if (!items.length) {
      panel.classList.remove('is-open');
      return;
    }
    items.forEach((item, index) => {
      const button = el('button', `suggest-item${index === selected ? ' is-selected' : ''}`);
      button.type = 'button';
      button.dataset.index = String(index);
      const iconNode = el('span', 'suggest-icon');
      if (item.type === 'url') iconNode.innerHTML = icon('arrowRight', 16);
      else if (item.type === 'history') iconNode.innerHTML = icon('clock', 16);
      else if (item.type === 'shortcut') iconNode.innerHTML = icon('grid', 16);
      else iconNode.innerHTML = icon('search', 16);
      const text = el('span', 'suggest-text');
      const strong = document.createElement('strong');
      strong.textContent = item.label;
      text.appendChild(strong);
      if (item.hint) {
        const hint = el('span', 'suggest-hint');
        hint.textContent = item.hint;
        text.appendChild(hint);
      }
      button.append(iconNode, text);
      if (item.action) {
        const action = el('span', 'suggest-action');
        action.textContent = item.action;
        button.appendChild(action);
      }
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        submit(index);
      });
      panel.appendChild(button);
    });
    panel.classList.add('is-open');
  };

  const build = (query) => {
    const value = query.trim();
    const local = [];
    if (value) {
      const lower = value.toLowerCase();
      for (const shortcut of state.shortcuts) {
        if (local.length >= 2) break;
        if (shortcut.title.toLowerCase().includes(lower) || shortcut.url.toLowerCase().includes(lower)) {
          local.push({ type: 'shortcut', label: shortcut.title, hint: shortcut.url, value: shortcut.url });
        }
      }
      for (const entry of state.history) {
        if (local.length >= 4) break;
        if (entry.title?.toLowerCase().includes(lower) || entry.url.toLowerCase().includes(lower)) {
          local.push({ type: 'history', label: entry.title || entry.url, hint: entry.host, value: entry.url });
        }
      }
      const looksUrl = !/\s/.test(value) && /^(https?:\/\/|localhost|[\w-]+(\.[\w-]+)+)/i.test(value);
      const first = looksUrl
        ? { type: 'url', label: value, hint: 'Open address', value }
        : { type: 'url', label: value, hint: `Search ${engineName()}`, value, isSearch: true };
      local.unshift(first);
    }
    return [...local, ...(getPrefixItems?.() || [])];
  };

  const refresh = async () => {
    const query = input.value;
    if (!query.trim()) {
      items = getPrefixItems?.() || [];
      selected = -1;
      render();
      return;
    }
    items = build(query);
    selected = -1;
    render();
    if (query.trim() === lastQuery) return;
    lastQuery = query.trim();
    const token = ++requestToken;
    if (!/^https?:\/\//i.test(query) && /\S/.test(query)) {
      try {
        const data = await api.get(`/api/suggest?q=${encodeURIComponent(query)}&engine=${encodeURIComponent(state.settings.engine)}`);
        if (token !== requestToken) return;
        remote = Array.isArray(data?.items) ? data.items.slice(0, 6) : [];
        items = [
          ...items.filter((item) => item.type !== 'search'),
          ...remote
            .filter((text) => text.toLowerCase() !== query.trim().toLowerCase())
            .map((text) => ({ type: 'search', label: text, value: text, isSearch: true })),
        ];
        render();
      } catch {
        /* suggestions are optional */
      }
    }
  };

  const submit = (index) => {
    const item = items[index];
    if (!item) {
      onSubmit(input.value);
      return;
    }
    if (item.isSearch) {
      onSubmit(item.value, { forceSearch: true });
    } else {
      onSubmit(item.value);
    }
    hide();
    input.blur();
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      if (!items.length) return;
      event.preventDefault();
      selected = (selected + 1) % items.length;
      render();
    } else if (event.key === 'ArrowUp') {
      if (!items.length) return;
      event.preventDefault();
      selected = (selected - 1 + items.length) % items.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      submit(selected >= 0 ? selected : 0);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hide();
      onClose?.();
    } else if (event.key === 'Tab' && items.length) {
      event.preventDefault();
      input.value = items[Math.max(0, selected)].value;
      refresh();
    }
  };

  let onClose = null;
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('blur', () => setTimeout(hide, 120));
  input.addEventListener('focus', () => {
    if (input.value.trim()) refresh();
  });

  return {
    refresh,
    hide,
    setOnClose(fn) {
      onClose = fn;
    },
  };
};
