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
let zoom = 1;
let frameSize = null;
let contentRect = { x: 0, y: 0, width: 0, height: 0, scale: 1 };
let pendingBitmap = null;
let pendingCaptureTs = null;
// The last painted frame is kept alive so a canvas resize (window resize,
// fullscreen, zoom, device-pixel-ratio change) can redraw it. Resizing clears
// the canvas, and a static page emits no new frames - without this the viewer
// went permanently black while audio kept playing.
let lastBitmap = null;
let paintScheduled = false;
let paintedRect = null;
// Server clock minus this clock, estimated from ping/pong round trips. The
// stream carries server capture times, so this is what turns them into lag.
// Null until the first pong: skew would otherwise look like lag.
let clockOffset = null;

// Live renderer counters for the performance panel. Cheap increments only.
const stats = {
  frames: 0,
  painted: 0,
  dropped: 0,
  decodeMs: 0,
  lastDecodeMs: 0,
  fps: 0,
  lagMs: null,
  kbps: 0,
  windowStart: 0,
  windowPainted: 0,
  windowBytes: 0,
};

export const viewportStats = () => ({
  frames: stats.frames,
  painted: stats.painted,
  dropped: stats.dropped,
  decodeMs: Math.round(stats.lastDecodeMs * 100) / 100,
  fps: stats.fps,
  lagMs: stats.lagMs,
  kbps: stats.kbps,
  width: dom.canvas ? dom.canvas.width : 0,
  height: dom.canvas ? dom.canvas.height : 0,
  zoom,
});

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

  // Hidden viewers should not pay for JPEG encoding on the server.
  document.addEventListener('visibilitychange', () => {
    publishStreaming();
    if (!document.hidden) applySize();
  });
  document.addEventListener('fullscreenchange', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => applySize(), 40);
  });

  connection.addEventListener('frame', (event) => {
    // A hidden embedding page has nowhere to paint: skipping the decode costs
    // nothing and saves the whole viewing cost while the tab is backgrounded.
    if (document.hidden) return;
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

  connection.addEventListener('fullscreen', (event) => {
    const detail = event.detail || {};
    if (detail.tabId && currentTabId && detail.tabId !== currentTabId) return;
    document.body.classList.toggle('is-remote-fullscreen', Boolean(detail.on));
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => applySize(), 60);
  });

  connection.addEventListener('pong', (event) => {
    const { serverTime, ts } = event.detail || {};
    if (!Number.isFinite(serverTime) || !Number.isFinite(ts)) return;
    const now = Date.now();
    // Half the round trip is the one-way delay; the rest of the difference is
    // the offset between the two clocks. Only the smallest sample is kept: a
    // pong delayed by a busy connection would otherwise inflate the offset and
    // make the stream look better than it is.
    const sample = serverTime - (ts + (now - ts) / 2);
    clockOffset = clockOffset == null ? sample : Math.min(clockOffset, sample);
  });

  connection.addEventListener('status', (event) => {
    const status = event.detail.status;
    if (status === 'open') clockOffset = null;
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
    frameSize = null;
    if (pendingBitmap) {
      pendingBitmap.close();
      pendingBitmap = null;
    }
    if (lastBitmap) {
      lastBitmap.close();
      lastBitmap = null;
    }
    contentRect = { x: 0, y: 0, width: 0, height: 0, scale: 1 };
    clearCanvas();
    hideOverlay();
    publishStreaming();
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
  frameSize = null;
  if (lastBitmap) {
    lastBitmap.close();
    lastBitmap = null;
  }
  clearCanvas();
  hideOverlay();
  document.body.classList.remove('is-remote-fullscreen');
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
  renderOverlay('loading', {
    title,
    text: 'Rendering on the server and streaming to you. A first visit can take a while on a slow host.',
  });
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
  paintedRect = null;
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
  // The screencast is captured at CSS size, so a 2x backing store only upscaled
  // a 1x image: it cost four times the canvas memory and a bigger drawImage per
  // frame for no extra detail. 1:1 is both sharper and cheaper.
  const ratio = 1;
  const bufferWidth = Math.round(cssWidth * ratio);
  const bufferHeight = Math.round(cssHeight * ratio);
  if (dom.canvas.width !== bufferWidth || dom.canvas.height !== bufferHeight) {
    dom.canvas.width = bufferWidth;
    dom.canvas.height = bufferHeight;
    clearCanvas();
    if (frameSize) fitContent();
    // Setting width/height wipes the bitmap. Redraw what was last shown and ask
    // the server for a fresh capture at the new size, so the view never goes
    // black just because the window changed.
    repaintLastFrame();
    if (currentTabId) sendMessage({ t: 'stream:refresh', tabId: currentTabId });
  }
  // Zoom narrows the remote CSS viewport so the page reflows for real instead of
  // being scaled blurrily on this side.
  const targetWidth = Math.max(320, Math.round(cssWidth / zoom));
  const targetHeight = Math.max(240, Math.round(cssHeight / zoom));
  if (Math.abs(targetWidth - requested.width) > 6 || Math.abs(targetHeight - requested.height) > 6) {
    requested = { width: targetWidth, height: targetHeight };
    publishViewport();
  }
};

const publishViewport = () => {
  if (!currentTabId) return;
  sendMessage({ t: 'viewport', tabId: currentTabId, width: requested.width, height: requested.height });
};

const publishStreaming = () => {
  if (!currentTabId) return;
  sendMessage({ t: 'stream', tabId: currentTabId, active: !document.hidden });
};

export const ensureSizePublished = () => publishViewport();

/** Maps a pointer event onto the letterboxed frame, not the whole canvas. */
const mapPoint = (event) => {
  const rect = dom.canvas.getBoundingClientRect();
  const canvasX = (event.clientX - rect.left) * (dom.canvas.width / Math.max(1, rect.width));
  const canvasY = (event.clientY - rect.top) * (dom.canvas.height / Math.max(1, rect.height));
  if (!contentRect.width) fitContent();
  const scale = contentRect.scale || 1;
  const width = frameSize?.width || remote.width;
  const height = frameSize?.height || remote.height;
  return {
    x: clamp((canvasX - contentRect.x) / scale, 0, width),
    y: clamp((canvasY - contentRect.y) / scale, 0, height),
  };
};

/** Fits the incoming frame inside the canvas, preserving its aspect ratio. */
const fitContent = () => {
  if (!dom.canvas) return;
  const width = frameSize?.width || remote.width || 1;
  const height = frameSize?.height || remote.height || 1;
  const scale = Math.min(dom.canvas.width / width, dom.canvas.height / height);
  const drawWidth = Math.max(1, width * scale);
  const drawHeight = Math.max(1, height * scale);
  contentRect = {
    x: Math.round((dom.canvas.width - drawWidth) / 2),
    y: Math.round((dom.canvas.height - drawHeight) / 2),
    width: Math.round(drawWidth),
    height: Math.round(drawHeight),
    scale,
  };
};

/** Redraws the most recent frame after the canvas was resized or cleared. */
const repaintLastFrame = () => {
  if (!lastBitmap || !dom.ctx || !currentTabId) return;
  fitContent();
  const { x, y, width, height } = contentRect;
  dom.ctx.fillStyle = '#07070a';
  dom.ctx.fillRect(0, 0, dom.canvas.width, dom.canvas.height);
  dom.ctx.drawImage(lastBitmap, x, y, width, height);
  paintedRect = { x, y, width, height };
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
  const version = view.getUint8(4);
  const idLength = view.getUint8(5);
  // v2 added the frame's pixel size, v3 the server capture time.
  const headerLength = version >= 3 ? 14 : 10;
  const sized = version >= 2 && buffer.byteLength >= headerLength + idLength;
  const idOffset = sized ? headerLength : 6;
  let tabId = '';
  try {
    tabId = new TextDecoder().decode(new Uint8Array(buffer, idOffset, idLength));
  } catch {
    return;
  }
  if (!currentTabId || tabId !== currentTabId) return;
  if (sized) {
    const width = view.getUint16(6);
    const height = view.getUint16(8);
    if (width && height) frameSize = { width, height };
  }
  const captureTs = version >= 3 ? view.getUint32(10) : null;

  const jpeg = new Uint8Array(buffer, idOffset + idLength);
  const blob = new Blob([jpeg], { type: 'image/jpeg' });
  stats.frames += 1;
  stats.windowBytes += buffer.byteLength;
  const decodeStart = performance.now();
  let bitmap = null;
  if (typeof createImageBitmap === 'function') {
    bitmap = await createImageBitmap(blob).catch(() => null);
  }
  stats.lastDecodeMs = performance.now() - decodeStart;
  if (!bitmap) return;
  if (tabId !== currentTabId) {
    bitmap.close();
    return;
  }
  if (!dom.ctx) {
    bitmap.close();
    return;
  }
  schedulePaint(bitmap, captureTs);
};

/**
 * One paint per animation frame: several frames can decode between paints, and
 * only the newest one is worth showing. The previous bitmap is released here so
 * a burst does not pile up GPU memory.
 */
const schedulePaint = (bitmap, captureTs = null) => {
  if (pendingBitmap) {
    pendingBitmap.close();
    stats.dropped += 1;
  }
  pendingBitmap = bitmap;
  pendingCaptureTs = captureTs;
  if (paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(paintPending);
};

const paintPending = () => {
  paintScheduled = false;
  const bitmap = pendingBitmap;
  const captureTs = pendingCaptureTs;
  pendingBitmap = null;
  pendingCaptureTs = null;
  if (!bitmap) return;
  if (!dom.ctx || !currentTabId) {
    bitmap.close();
    return;
  }
  fitContent();
  const { x, y, width, height } = contentRect;
  // The letterbox only moves when the frame or canvas changes; repainting the
  // whole canvas on every frame was a full-surface fill at the stream rate.
  if (
    !paintedRect ||
    paintedRect.x !== x ||
    paintedRect.y !== y ||
    paintedRect.width !== width ||
    paintedRect.height !== height
  ) {
    dom.ctx.fillStyle = '#07070a';
    dom.ctx.fillRect(0, 0, dom.canvas.width, dom.canvas.height);
    paintedRect = { x, y, width, height };
  }
  dom.ctx.drawImage(bitmap, x, y, width, height);
  if (lastBitmap && lastBitmap !== bitmap) lastBitmap.close();
  lastBitmap = bitmap;
  hasFrame = true;
  stats.painted += 1;
  stats.windowPainted += 1;
  // Capture-to-paint age: encoder time, network transit and decode together.
  // The timestamp is 32 bits and wraps every 49 days, so the difference is
  // folded back into a signed range before it is believed.
  if (captureTs != null && clockOffset != null) {
    // The timestamp is modulo 2^32, so the difference is taken modulo 2^32 too
    // and then folded into a signed range before it is believed.
    let age = ((Date.now() + clockOffset - captureTs) % 4294967296 + 4294967296) % 4294967296;
    if (age > 2147483647) age -= 4294967296;
    stats.lagMs = Math.max(0, Math.round(age));
  }
  const now = performance.now();
  if (!stats.windowStart) stats.windowStart = now;
  if (now - stats.windowStart >= 1000) {
    const elapsed = now - stats.windowStart;
    stats.fps = Math.round((stats.windowPainted * 1000) / elapsed);
    stats.kbps = Math.round((stats.windowBytes * 8) / elapsed);
    stats.windowPainted = 0;
    stats.windowBytes = 0;
    stats.windowStart = now;
  }
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

export const toggleFullscreen = () => {
  try {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.();
  } catch {
    /* fullscreen is unavailable inside some frames */
  }
};

export const setZoom = (value) => {
  const next = clamp(Number(value) || 1, 0.5, 2);
  if (Math.abs(next - zoom) < 0.01) return zoom;
  zoom = next;
  applySize();
  return zoom;
};

export const getZoom = () => zoom;

export const isEditableTarget = (target) => {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
};
