import { icon } from './icons.js';
import { connection } from './net.js';

const MAGIC = 0x56584650;

const dom = {};
let sendMessage = () => false;
let currentTabId = null;
let requested = { width: 1280, height: 800 };
let remote = { width: 1280, height: 800 };
let pendingFrame = null;
let decoding = false;
let hasFrame = false;
let overlayMode = 'none';
let overlayAction = null;
let resizeTimer = null;
let lastClick = { at: 0, x: 0, y: 0, count: 1 };
let touch = null;
let moveScheduled = false;
let pendingMove = null;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const initViewport = ({ send }) => {
  sendMessage = send;
  dom.viewer = document.getElementById('viewer');
  dom.canvas = document.getElementById('screen');
  dom.ctx = dom.canvas.getContext('2d', { alpha: false });
  dom.overlay = document.getElementById('viewer-overlay');
  dom.title = document.getElementById('vo-title');
  dom.text = document.getElementById('vo-text');
  dom.action = document.getElementById('vo-action');
  dom.spinner = document.getElementById('vo-spinner');
  dom.icon = document.getElementById('vo-icon');
  dom.ime = document.getElementById('ime');

  dom.action?.addEventListener('click', () => {
    if (typeof overlayAction === 'function') overlayAction();
  });

  if (!dom.canvas || !dom.ctx) return;

  dom.ctx.imageSmoothingEnabled = true;
  dom.ctx.imageSmoothingQuality = 'low';
  clearCanvas();

  bindPointerEvents();
  bindKeyboard();
  bindWheel();
  observeResize();
  applySize();

  connection.addEventListener('frame', (event) => {
    pendingFrame = event.detail;
    if (!decoding) pump();
  });

  connection.addEventListener('cursor', (event) => {
    setCursor(event.detail.cursor);
  });

  connection.addEventListener('viewport', (event) => {
    const detail = event.detail || {};
    if (detail.tabId && currentTabId && detail.tabId !== currentTabId) return;
    if (Number.isFinite(detail.width) && Number.isFinite(detail.height)) {
      remote = { width: detail.width, height: detail.height };
    }
  });

  connection.addEventListener('status', (event) => {
    const status = event.detail.status;
    if (status === 'offline' || status === 'connecting') {
      if (currentTabId) showOffline();
    } else if (status === 'open') {
      if (overlayMode === 'offline') hideOverlay();
    }
  });

  connection.addEventListener('denied', () => {
    window.location.reload();
  });

  window.addEventListener('beforeunload', () => {
    connection.close();
  });
};

/* --------------------------------------------------------------- lifecycle */

export const setActiveTab = (tab) => {
  const id = tab?.id || null;
  if (id !== currentTabId) {
    currentTabId = id;
    hasFrame = false;
    clearCanvas();
    hideOverlay();
  }
  if (!tab || !tab.url) {
    hideOverlay();
    return;
  }
  if (!hasFrame) showLoading(tab.title || 'Loading page…');
};

export const clearViewport = () => {
  currentTabId = null;
  hasFrame = false;
  clearCanvas();
  hideOverlay();
};

export const requestedSize = () => ({ ...requested });

export const hasRenderedFrame = () => hasFrame;

export const focusViewport = () => {
  try {
    dom.ime?.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
};

export const requestCopy = () => {
  sendMessage({ t: 'copy' });
};

/* ------------------------------------------------------------------ overlay */

export const showLoading = (title = 'Loading page…') => {
  if (hasFrame) return;
  renderOverlay('loading', { title, text: 'Rendering on the server and streaming to you.' });
};

export const showError = (message, { actionLabel = 'Try again', action = null } = {}) => {
  renderOverlay('error', {
    title: 'This page could not load',
    text: message || 'The destination refused the connection.',
    actionLabel,
    action,
  });
};

export const showOffline = () => {
  renderOverlay('offline', {
    title: 'Reconnecting to Velocity',
    text: 'The streaming connection dropped. Your session is still alive on the server.',
    actionLabel: 'Reconnect now',
    action: () => connection.connect(),
  });
};

export const hideOverlay = () => {
  renderOverlay('none');
};

const renderOverlay = (mode, { title = '', text = '', actionLabel = '', action = null } = {}) => {
  if (!dom.overlay) return;
  overlayMode = mode;
  overlayAction = action;
  if (mode === 'none') {
    dom.overlay.hidden = true;
    dom.overlay.className = 'viewer-overlay';
    return;
  }
  dom.overlay.hidden = false;
  dom.overlay.className = `viewer-overlay is-${mode}`;
  if (dom.title) dom.title.textContent = title;
  if (dom.text) dom.text.textContent = text;
  if (dom.spinner) dom.spinner.hidden = mode !== 'loading';
  if (dom.icon) {
    dom.icon.innerHTML = mode === 'error' ? icon('globe', 26) : mode === 'offline' ? icon('shield', 26) : '';
    dom.icon.hidden = mode === 'loading';
  }
  if (dom.action) {
    dom.action.hidden = !(actionLabel && action);
    dom.action.textContent = actionLabel || '';
  }
};

/* ------------------------------------------------------------------ canvas */

const clearCanvas = () => {
  if (!dom.ctx) return;
  dom.ctx.fillStyle = '#07080c';
  dom.ctx.fillRect(0, 0, dom.canvas.width || 1, dom.canvas.height || 1);
};

const setCursor = (cursor) => {
  if (!dom.canvas) return;
  const allowed = new Set([
    'default',
    'pointer',
    'text',
    'crosshair',
    'move',
    'grab',
    'grabbing',
    'wait',
    'help',
    'not-allowed',
    'progress',
    'cell',
    'copy',
    'alias',
    'zoom-in',
    'zoom-out',
    'col-resize',
    'row-resize',
    'n-resize',
    's-resize',
    'e-resize',
    'w-resize',
    'ns-resize',
    'ew-resize',
    'nesw-resize',
    'nwse-resize',
    'context-menu',
    'vertical-text',
    'all-scroll',
  ]);
  dom.canvas.style.cursor = allowed.has(cursor) ? cursor : 'default';
};

const observeResize = () => {
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => scheduleResize()).observe(dom.viewer);
  }
  window.addEventListener('resize', () => scheduleResize());
};

const scheduleResize = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => applySize(), 120);
};

const applySize = () => {
  if (!dom.viewer || !dom.canvas) return;
  const rect = dom.viewer.getBoundingClientRect();
  const cssWidth = Math.max(320, Math.round(rect.width));
  const cssHeight = Math.max(240, Math.round(rect.height));
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const bufferWidth = Math.round(cssWidth * ratio);
  const bufferHeight = Math.round(cssHeight * ratio);
  if (dom.canvas.width !== bufferWidth || dom.canvas.height !== bufferHeight) {
    dom.canvas.width = bufferWidth;
    dom.canvas.height = bufferHeight;
    clearCanvas();
  }
  if (Math.abs(cssWidth - requested.width) > 4 || Math.abs(cssHeight - requested.height) > 4) {
    requested = { width: cssWidth, height: cssHeight };
    if (currentTabId) {
      sendMessage({ t: 'viewport', tabId: currentTabId, width: cssWidth, height: cssHeight });
    }
  }
};

export const ensureSizePublished = () => {
  if (!currentTabId) return;
  sendMessage({ t: 'viewport', tabId: currentTabId, width: requested.width, height: requested.height });
};

const mapPoint = (event) => {
  const rect = dom.canvas.getBoundingClientRect();
  const sx = remote.width / Math.max(1, rect.width);
  const sy = remote.height / Math.max(1, rect.height);
  return {
    x: clamp((event.clientX - rect.left) * sx, 0, remote.width),
    y: clamp((event.clientY - rect.top) * sy, 0, remote.height),
  };
};

const pump = async () => {
  decoding = true;
  while (pendingFrame) {
    const buffer = pendingFrame;
    pendingFrame = null;
    await drawFrame(buffer).catch(() => {});
  }
  decoding = false;
  if (pendingFrame) queueMicrotask(pump);
};

const drawFrame = async (buffer) => {
  if (!buffer || buffer.byteLength < 8) return;
  const view = new DataView(buffer);
  if (view.getUint32(0) !== MAGIC) return;
  const idLength = view.getUint8(5);
  let tabId = '';
  try {
    tabId = new TextDecoder().decode(new Uint8Array(buffer, 6, idLength));
  } catch {
    return;
  }
  if (!currentTabId || tabId !== currentTabId) return;

  const jpeg = new Uint8Array(buffer, 6 + idLength);
  const blob = new Blob([jpeg], { type: 'image/jpeg' });
  let bitmap = null;
  if (typeof createImageBitmap === 'function') {
    bitmap = await createImageBitmap(blob).catch(() => null);
  }
  if (!bitmap) return;
  if (tabId !== currentTabId) {
    bitmap.close();
    return;
  }
  if (!dom.ctx) {
    bitmap.close();
    return;
  }
  dom.ctx.drawImage(bitmap, 0, 0, dom.canvas.width, dom.canvas.height);
  bitmap.close();
  hasFrame = true;
  if (overlayMode === 'loading') hideOverlay();
};

/* ------------------------------------------------------------------- input */

const bindPointerEvents = () => {
  const canvas = dom.canvas;

  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener('pointerdown', (event) => {
    if (!currentTabId) return;
    focusViewport();
    if (event.pointerType === 'touch') {
      touch = { x: event.clientX, y: event.clientY, startTime: Date.now(), moved: false, pointerId: event.pointerId };
      return;
    }
    if (event.button === 2) return; // right click handled on pointerup
    event.preventDefault();
    const { x, y } = mapPoint(event);
    const now = Date.now();
    const near = Math.abs(lastClick.x - x) < 6 && Math.abs(lastClick.y - y) < 6;
    const count = now - lastClick.at < 420 && near ? Math.min(3, lastClick.count + 1) : 1;
    lastClick = { at: now, x, y, count };
    sendMessage({
      t: 'mouse',
      tabId: currentTabId,
      type: 'down',
      x,
      y,
      button: event.button,
      clickCount: count,
    });
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!currentTabId) return;
    if (event.pointerType === 'touch' && touch) {
      const deltaY = event.clientY - touch.y;
      const deltaX = event.clientX - touch.x;
      if (Math.abs(deltaY) > 4 || Math.abs(deltaX) > 4) touch.moved = true;
      if (Date.now() - touch.startTime > 320) {
        if (Math.abs(deltaY) > 1) {
          sendMessage({
            t: 'wheel',
            tabId: currentTabId,
            x: 0,
            y: 0,
            deltaX: -deltaX * 1.2,
            deltaY: -deltaY * 1.6,
          });
          touch.x = event.clientX;
          touch.y = event.clientY;
        }
      }
      return;
    }
    pendingMove = mapPoint(event);
    if (moveScheduled) return;
    moveScheduled = true;
    requestAnimationFrame(() => {
      moveScheduled = false;
      if (!pendingMove || !currentTabId) return;
      const point = pendingMove;
      pendingMove = null;
      sendMessage({ t: 'mouse', tabId: currentTabId, type: 'move', x: point.x, y: point.y });
    });
  });

  const finish = (event) => {
    if (!currentTabId) return;
    if (event.pointerType === 'touch') {
      if (touch && !touch.moved) {
        const { x, y } = mapPoint(event);
        sendMessage({ t: 'mouse', tabId: currentTabId, type: 'down', x, y, button: 0, clickCount: 1 });
        sendMessage({ t: 'mouse', tabId: currentTabId, type: 'up', x, y, button: 0, clickCount: 1 });
      }
      touch = null;
      return;
    }
    const { x, y } = mapPoint(event);
    sendMessage({
      t: 'mouse',
      tabId: currentTabId,
      type: 'up',
      x,
      y,
      button: event.button,
      clickCount: Math.max(1, lastClick.count),
    });
  };

  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', () => {
    touch = null;
  });
};

const bindWheel = () => {
  dom.canvas.addEventListener(
    'wheel',
    (event) => {
      if (!currentTabId) return;
      event.preventDefault();
      const { x, y } = mapPoint(event);
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? remote.height : 1;
      sendMessage({
        t: 'wheel',
        tabId: currentTabId,
        x,
        y,
        deltaX: clamp(event.deltaX * factor, -4000, 4000),
        deltaY: clamp(event.deltaY * factor, -4000, 4000),
      });
    },
    { passive: false },
  );
};

const bindKeyboard = () => {
  const ime = dom.ime;
  if (!ime) return;

  ime.addEventListener('keydown', (event) => {
    if (event.isComposing || event.key === 'Unidentified' || event.keyCode === 229) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === 'v' || event.key === 'V')) return; // real paste event follows
    if (mod && (event.key === 'c' || event.key === 'C')) {
      event.preventDefault();
      requestCopy();
      return;
    }
    if (mod && (event.key === 'x' || event.key === 'X')) {
      event.preventDefault();
      requestCopy();
      return;
    }
    event.preventDefault();
    forwardKey(event, 'down');
  });

  ime.addEventListener('keyup', (event) => {
    if (event.isComposing || event.key === 'Unidentified' || event.keyCode === 229) return;
    forwardKey(event, 'up');
  });

  ime.addEventListener('input', () => {
    const value = ime.value;
    if (!value) return;
    if (currentTabId) sendMessage({ t: 'text', tabId: currentTabId, text: value });
    ime.value = '';
  });

  ime.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text');
    if (!text) return;
    event.preventDefault();
    if (currentTabId) sendMessage({ t: 'text', tabId: currentTabId, text });
  });

  dom.canvas.addEventListener('pointerdown', () => focusViewport());
};

export const forwardKey = (event, phase) => {
  if (!currentTabId) return false;
  const key = event.key;
  if (!key || key === 'Unidentified') return false;
  if (phase === 'up' && ['Shift', 'Control', 'Alt', 'Meta'].includes(key)) {
    // modifiers still need to be released remotely
  }
  sendMessage({
    t: 'key',
    tabId: currentTabId,
    event: phase,
    key,
    code: event.code,
    keyCode: event.keyCode,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    autoRepeat: event.repeat,
  });
  return true;
};

export const pasteFromClipboard = async () => {
  if (!currentTabId) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) sendMessage({ t: 'text', tabId: currentTabId, text });
  } catch {
    /* permission denied */
  }
};

export const isEditableTarget = (target) => {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
};
