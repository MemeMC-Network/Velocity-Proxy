import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { log } from '../logger.js';
import { assertPublicHttpUrl } from '../security/ip-guard.js';
import { buildKeyParams } from './keys.js';
import { clamp, hostOf } from '../util.js';

const MAGIC = 0x56584650; // "VXFP"

const friendlyNavError = (message) => {
  const value = String(message || '');
  const match = value.match(/net::(ERR_[A-Z_]+)/);
  const code = match?.[1] || '';
  const map = {
    ERR_NAME_NOT_RESOLVED: 'This site could not be found. The domain did not resolve.',
    ERR_NAME_RESOLUTION_FAILED: 'This site could not be found. The domain did not resolve.',
    ERR_CONNECTION_REFUSED: 'The site refused the connection.',
    ERR_CONNECTION_TIMED_OUT: 'The site took too long to respond.',
    ERR_TIMED_OUT: 'The site took too long to respond.',
    ERR_CONNECTION_RESET: 'The connection was reset by the site.',
    ERR_CONNECTION_CLOSED: 'The connection was closed unexpectedly.',
    ERR_INTERNET_DISCONNECTED: 'The proxy server has no internet connection.',
    ERR_TOO_MANY_REDIRECTS: 'This site redirected too many times.',
    ERR_BLOCKED_BY_CLIENT: 'That destination was blocked by the proxy security policy.',
    ERR_CERT_AUTHORITY_INVALID: 'This site has an invalid security certificate.',
    ERR_CERT_COMMON_NAME_INVALID: 'This site has an invalid security certificate.',
    ERR_CERT_DATE_INVALID: 'This site has an expired security certificate.',
    ERR_SSL_PROTOCOL_ERROR: 'The secure connection to this site failed.',
    ERR_ADDRESS_UNREACHABLE: 'The site is unreachable.',
    ERR_HTTP_RESPONSE_CODE_FAILURE: 'The site returned an error response.',
    ERR_EMPTY_RESPONSE: 'The site closed the connection without sending data.',
  };
  if (map[code]) return map[code];
  if (/ERR_ABORTED/i.test(value)) return null;
  return 'This page could not be loaded.';
};

/**
 * One live tab: a Chromium page inside an isolated browser context, streamed to
 * the client over a CDP screencast and driven by forwarded input events.
 */
export class TabSession extends EventEmitter {
  constructor({ id, workspace, context, page, config, meta = {} }) {
    super();
    this.setMaxListeners(0);
    this.id = id;
    this.workspace = workspace;
    this.context = context;
    this.page = page;
    this.config = config;

    this.clients = new Set();
    this.cdp = null;
    this.closed = false;
    this.closing = false;
    this.intentionalClose = false;
    this.streaming = false;
    this.quality = config.frameQuality;
    this.viewport = { width: 1280, height: 800 };
    this.pinned = Boolean(meta.pinned);

    this.inflight = 0;
    this.settleTimer = null;
    this.loadingTimer = null;
    this.pollTimer = null;
    this.faviconTimer = null;
    this.dialogTimer = null;
    this.pendingDialog = null;

    this.polling = false;
    this.mouseBusy = false;
    this.navSeq = 0;
    this.lastActivity = Date.now();
    this.lastRecorded = { url: null, title: null, at: 0 };
    this.lastCursor = '';
    this.lastCursorAt = 0;

    this.faviconUrl = null;
    this.frameSizeEma = 0;
    this.lastQualityChange = 0;

    this.muted = Boolean(meta.muted);
    this.audible = false;

    this.state = {
      url: meta.url && /^https?:/.test(meta.url) ? meta.url : null,
      title: meta.title || 'New Tab',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      status: 'idle',
      error: null,
    };
    this.lastSnapshotJson = '';
  }

  /* ------------------------------------------------------------------ setup */

  async init() {
    this.cdp = await this.context.newCDPSession(this.page);
    const { page } = this;

    this.cdp.on('Page.screencastFrame', (event) => this.handleScreencastFrame(event));
    this.cdp.on('Page.javascriptDialogOpening', () => {});

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (/^https?:/.test(url)) {
        this.state.url = url;
        this.scheduleFaviconRefresh();
      }
      this.lastActivity = Date.now();
      this.emitState();
    });

    page.on('load', () => {
      this.lastActivity = Date.now();
      this.refreshMeta();
    });

    page.on('domcontentloaded', () => {
      this.lastActivity = Date.now();
    });

    page.on('request', () => {
      this.inflight += 1;
      this.lastActivity = Date.now();
      if (!this.state.loading) {
        this.state.loading = true;
        this.state.status = 'loading';
        this.state.error = null;
        this.armLoadingWatchdog();
        this.emitState();
      }
    });

    page.on('requestfinished', () => this.requestSettled());
    page.on('requestfailed', () => this.requestSettled());

    page.on('dialog', (dialog) => this.handleDialog(dialog));

    page.on('crash', () => {
      log.warn('tab crashed', this.id);
      this.state.status = 'error';
      this.state.error = 'This tab crashed. Reload to try again.';
      this.state.loading = false;
      this.emitState();
    });

    page.on('close', () => this.handlePageClosed());

    page.on('pageerror', (error) => log.debug('pageerror', this.id, error.message));

    page.on('download', (download) => {
      download.cancel().catch(() => {});
    });

    if (this.muted) await this.setMuted(true, { quiet: true }).catch(() => {});

    this.pollTimer = setInterval(() => this.poll(), 1100);
    this.pollTimer.unref?.();
    this.emitState();
  }

  /* ------------------------------------------------------------ state model */

  snapshot() {
    const url = this.state.url;
    return {
      id: this.id,
      url,
      host: hostOf(url),
      title: this.state.title || (url ? hostOf(url) : 'New Tab'),
      favicon: this.faviconUrl,
      pinned: this.pinned,
      live: true,
      loading: Boolean(this.state.loading),
      canGoBack: Boolean(this.state.canGoBack),
      canGoForward: Boolean(this.state.canGoForward),
      secure: typeof url === 'string' && url.startsWith('https://'),
      status: this.state.status,
      error: this.state.error,
      muted: this.muted,
      audible: this.audible,
      dialog: this.pendingDialog
        ? {
            id: this.pendingDialog.public.id,
            type: this.pendingDialog.public.type,
            message: this.pendingDialog.public.message,
            defaultValue: this.pendingDialog.public.defaultValue,
          }
        : null,
    };
  }

  emitState() {
    if (this.closed) return;
    const snapshot = this.snapshot();
    const json = JSON.stringify(snapshot);
    if (json === this.lastSnapshotJson) return;
    this.lastSnapshotJson = json;
    this.emit('state', snapshot);
  }

  armLoadingWatchdog() {
    clearTimeout(this.loadingTimer);
    this.loadingTimer = setTimeout(() => {
      if (this.closed) return;
      this.state.loading = false;
      this.state.status = this.state.error ? 'error' : 'ready';
      this.emitState();
    }, Math.min(this.config.navTimeoutMs, 30000));
    this.loadingTimer.unref?.();
  }

  requestSettled() {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.inflight > 0) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (this.closed) return;
      if (this.inflight > 0) return;
      this.state.loading = false;
      this.state.status = this.state.error ? 'error' : 'ready';
      this.emitState();
    }, 380);
    this.settleTimer.unref?.();
  }

  async poll() {
    if (this.closed || this.polling || !this.isLive()) return;
    if (!this.hasViewers() && Date.now() - this.lastActivity > 20000) return;
    this.polling = true;
    try {
      const info = await Promise.race([
        this.page.evaluate((muted) => {
          if (muted) {
            for (const el of document.querySelectorAll('audio,video')) {
              if (!el.muted) {
                el.muted = true;
                el.dataset.velocityMuted = '1';
              }
            }
          }
          const media = Array.from(document.querySelectorAll('audio,video'));
          return {
            title: document.title,
            href: location.href,
            ready: document.readyState,
            audible: media.some((el) => !el.paused && !el.muted && el.volume > 0),
          };
        }, this.muted),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (!info || this.closed) return;

      let changed = false;
      if (Boolean(info.audible) !== this.audible) {
        this.audible = Boolean(info.audible);
        changed = true;
      }
      if (info.title && info.title !== this.state.title) {
        this.state.title = info.title;
        changed = true;
        this.scheduleFaviconRefresh();
      }
      if (info.href && info.href !== this.state.url && /^https?:/.test(info.href)) {
        this.state.url = info.href;
        changed = true;
        this.scheduleFaviconRefresh();
      }
      if (info.ready === 'complete' && this.state.loading && this.inflight === 0) {
        this.state.loading = false;
        this.state.status = this.state.error ? 'error' : 'ready';
        changed = true;
      }

      if (this.hasViewers()) {
        const history = await this.cdp.send('Page.getNavigationHistory').catch(() => null);
        if (history) {
          const back = history.currentIndex > 0;
          const forward = history.currentIndex < history.entries.length - 1;
          if (back !== this.state.canGoBack || forward !== this.state.canGoForward) {
            this.state.canGoBack = back;
            this.state.canGoForward = forward;
            changed = true;
          }
        }
      }

      if (info.ready === 'complete') this.recordVisit();
      if (changed) this.emitState();
    } catch {
      /* navigation in flight - evaluated context was destroyed */
    } finally {
      this.polling = false;
    }
  }

  recordVisit() {
    const url = this.state.url;
    const title = this.state.title;
    if (!url || !/^https?:/.test(url)) return;
    const now = Date.now();
    if (this.lastRecorded.url === url && this.lastRecorded.title === title) return;
    if (now - this.lastRecorded.at < 2500) return;
    this.lastRecorded = { url, title, at: now };
    this.emit('visited', { url, title: title || hostOf(url) || url });
  }

  /**
   * Mutes or unmutes every media element in the page. Chromium renders all tabs
   * into one audio device, so background tabs are muted here, inside the page.
   */
  async setMuted(muted, { quiet = false } = {}) {
    const next = Boolean(muted);
    const changed = next !== this.muted;
    this.muted = next;
    this.state.muted = next;
    if (this.isLive()) {
      await this.page.evaluate((value) => {
        window.__velocityMuted = value;
        for (const el of document.querySelectorAll('audio,video')) {
          if (value) {
            if (!el.muted) {
              el.muted = true;
              el.dataset.velocityMuted = '1';
            }
          } else if (el.dataset.velocityMuted === '1') {
            el.muted = false;
            delete el.dataset.velocityMuted;
          }
        }
        if (!window.__velocityMuteHook) {
          window.__velocityMuteHook = true;
          document.addEventListener(
            'play',
            (event) => {
              const el = event.target;
              if (window.__velocityMuted && el && 'muted' in el && !el.muted) {
                el.muted = true;
                el.dataset.velocityMuted = '1';
              }
            },
            true,
          );
        }
      }, next).catch(() => {});
    }
    if (quiet) this.lastSnapshotJson = '';
    else if (changed) this.emitState();
    return next;
  }

  async refreshMeta() {
    if (this.closed) return;
    try {
      const info = await this.page.evaluate(() => ({ title: document.title, href: location.href })).catch(() => null);
      if (!info) return;
      if (info.title) this.state.title = info.title;
      if (info.href && /^https?:/.test(info.href)) this.state.url = info.href;
      this.scheduleFaviconRefresh();
      this.recordVisit();
      this.emitState();
    } catch {
      /* ignore */
    }
  }

  scheduleFaviconRefresh(immediate = false) {
    clearTimeout(this.faviconTimer);
    this.faviconTimer = setTimeout(() => this.refreshFavicon().catch(() => {}), immediate ? 50 : 700);
    this.faviconTimer.unref?.();
  }

  async refreshFavicon() {
    if (this.closed || !this.isLive()) return;
    const host = hostOf(this.state.url);
    if (!host) return;
    const info = await this.page
      .evaluate(() => {
        const links = Array.from(document.querySelectorAll('link[rel]')).filter((link) =>
          /(^|\s)(icon|shortcut icon|apple-touch-icon|mask-icon)(\s|$)/i.test(link.getAttribute('rel') || ''),
        );
        const last = links[links.length - 1];
        return { title: document.title, iconHref: last ? last.href : null };
      })
      .catch(() => null);
    if (!info) return;
    if (info.title) this.state.title = info.title;

    const iconUrl = info.iconHref && /^https?:/i.test(info.iconHref) ? info.iconHref : `https://${host}/favicon.ico`;
    const stored = await this.workspace.manager.favicons.fetchAndStore(host, iconUrl).catch(() => null);
    if (stored) {
      const next = `/api/favicon?host=${encodeURIComponent(host)}&v=${stored.hash}`;
      if (next !== this.faviconUrl) {
        this.faviconUrl = next;
        this.emitState();
      }
    }
  }

  /* -------------------------------------------------------------- streaming */

  hasViewers() {
    for (const client of this.clients) {
      if (client.tabId === this.id && client.ready()) return true;
    }
    return false;
  }

  viewers() {
    const list = [];
    for (const client of this.clients) {
      if (client.tabId === this.id && client.ready()) list.push(client);
    }
    return list;
  }

  attach(client) {
    this.clients.add(client);
    this.lastActivity = Date.now();
    this.emitState();
    this.startStreaming().catch(() => {});
    this.scheduleFaviconRefresh();
    this.poll().catch(() => {});
  }

  detach(client) {
    this.clients.delete(client);
    if (!this.hasViewers()) {
      this.stopStreaming().catch(() => {});
    }
  }

  async startStreaming() {
    if (this.streaming || this.closed || !this.cdp) return;
    this.streaming = true;
    try {
      await this.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.quality,
        maxWidth: Math.round(this.viewport.width),
        maxHeight: Math.round(this.viewport.height),
        everyNthFrame: 1,
      });
    } catch (error) {
      this.streaming = false;
      log.debug('startScreencast failed', this.id, error.message);
    }
  }

  async stopStreaming() {
    if (!this.streaming || !this.cdp || this.closed) return;
    this.streaming = false;
    try {
      await this.cdp.send('Page.stopScreencast');
    } catch {
      /* page may be gone */
    }
  }

  async restartStreaming() {
    await this.stopStreaming();
    await this.startStreaming();
  }

  handleScreencastFrame(event) {
    if (!this.cdp || this.closed) return;
    this.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    const viewers = this.viewers();
    if (!viewers.length) return;

    const frame = Buffer.from(event.data, 'base64');
    const idBuffer = Buffer.from(this.id, 'utf8').subarray(0, 32);
    const header = Buffer.alloc(6);
    header.writeUInt32BE(MAGIC, 0);
    header.writeUInt8(1, 4);
    header.writeUInt8(idBuffer.length, 5);
    const packet = Buffer.concat([header, idBuffer, frame]);

    for (const client of viewers) client.sendFrame(packet);
    this.lastActivity = Date.now();

    this.frameSizeEma = this.frameSizeEma ? this.frameSizeEma * 0.9 + frame.length * 0.1 : frame.length;
    const now = Date.now();
    if (now - this.lastQualityChange > 5000) {
      let next = this.quality;
      if (this.frameSizeEma > 240000) next = Math.max(32, this.quality - 8);
      else if (this.frameSizeEma < 70000) next = Math.min(78, this.quality + 3);
      if (Math.abs(next - this.quality) >= 3) {
        this.quality = next;
        this.lastQualityChange = now;
        this.restartStreaming().catch(() => {});
      }
    }
  }

  setQuality(value) {
    const quality = clamp(value, 25, 85);
    if (Math.abs(quality - this.quality) < 2) return;
    this.quality = quality;
    this.lastQualityChange = Date.now();
    this.restartStreaming().catch(() => {});
  }

  async setViewport(width, height, { force = false } = {}) {
    const w = clamp(Math.round(width), 320, this.config.viewportMaxWidth);
    const h = clamp(Math.round(height), 240, this.config.viewportMaxHeight);
    if (!force && w === this.viewport.width && h === this.viewport.height) return;
    this.viewport = { width: w, height: h };
    if (!this.isLive() || this.closed) return;
    try {
      await this.page.setViewportSize({ width: w, height: h });
    } catch {
      /* page busy or closing */
    }
    if (this.hasViewers()) await this.restartStreaming();
  }

  /* ------------------------------------------------------------- navigation */

  async navigate(rawUrl) {
    const target = await assertPublicHttpUrl(rawUrl);
    if (this.closed) throw new Error('This tab is closed');
    this.navSeq += 1;
    const token = this.navSeq;
    this.state.url = target.href;
    this.state.error = null;
    this.state.status = 'loading';
    this.state.loading = true;
    this.pendingDialog = null;
    this.armLoadingWatchdog();
    this.emitState();
    if (this.hasViewers()) this.startStreaming().catch(() => {});

    try {
      await this.page.goto(target.href, { waitUntil: 'commit', timeout: this.config.navTimeoutMs });
      if (token === this.navSeq) {
        this.state.status = this.state.loading ? 'loading' : 'ready';
      }
    } catch (error) {
      if (this.closed) return;
      const message = error?.message || String(error);
      if (/ERR_ABORTED|interrupted by another navigation|Navigation failed because page was closed/i.test(message)) {
        return;
      }
      const friendly = friendlyNavError(message);
      if (friendly === null) return;
      this.state.error = friendly;
      this.state.status = 'error';
      this.state.loading = false;
      log.warn('navigation failed', target.href, message.split('\n')[0]);
    }
    this.emitState();
    this.scheduleFaviconRefresh();
  }

  async goBack() {
    if (!this.isLive()) return;
    this.state.loading = true;
    this.armLoadingWatchdog();
    this.emitState();
    try {
      await this.page.goBack({ waitUntil: 'commit', timeout: 20000 });
    } catch {
      /* no history entry */
    }
    await this.refreshMeta();
  }

  async goForward() {
    if (!this.isLive()) return;
    this.state.loading = true;
    this.armLoadingWatchdog();
    this.emitState();
    try {
      await this.page.goForward({ waitUntil: 'commit', timeout: 20000 });
    } catch {
      /* no history entry */
    }
    await this.refreshMeta();
  }

  async reload() {
    if (!this.isLive()) return;
    this.state.error = null;
    this.state.loading = true;
    this.state.status = 'loading';
    this.armLoadingWatchdog();
    this.emitState();
    try {
      await this.page.reload({ waitUntil: 'commit', timeout: this.config.navTimeoutMs });
    } catch (error) {
      const friendly = friendlyNavError(error?.message);
      if (friendly) {
        this.state.error = friendly;
        this.state.status = 'error';
        this.state.loading = false;
      }
    }
    this.emitState();
  }

  async stop() {
    if (!this.cdp || this.closed) return;
    try {
      await this.cdp.send('Page.stopLoading');
    } catch {
      /* ignore */
    }
    this.state.loading = false;
    this.state.status = this.state.error ? 'error' : 'ready';
    this.emitState();
  }

  async goHome() {
    if (this.closed) return;
    this.navSeq += 1;
    if (this.isLive()) {
      await this.page.goto('about:blank', { waitUntil: 'commit', timeout: 10000 }).catch(() => {});
    }
    this.state.url = null;
    this.state.title = 'New Tab';
    this.state.error = null;
    this.state.loading = false;
    this.state.canGoBack = false;
    this.state.canGoForward = false;
    this.state.status = 'idle';
    this.faviconUrl = null;
    this.lastSnapshotJson = '';
    await this.stopStreaming();
    this.emitState();
  }

  /* ------------------------------------------------------------------ input */

  async mouse(type, { x, y, button = 'left', clickCount = 1 } = {}) {
    if (!this.isLive() || this.closed) return;
    const px = clamp(x, 0, this.viewport.width);
    const py = clamp(y, 0, this.viewport.height);
    this.lastActivity = Date.now();
    if (type === 'move') {
      if (this.mouseBusy) return; // coalesce: a newer position will follow
      this.mouseBusy = true;
      try {
        await this.page.mouse.move(px, py);
      } catch {
        /* ignore */
      } finally {
        this.mouseBusy = false;
      }
      this.maybeReportCursor(px, py).catch(() => {});
      return;
    }
    try {
      if (type === 'down') await this.page.mouse.down({ button: normalizeButton(button), clickCount });
      else if (type === 'up') await this.page.mouse.up({ button: normalizeButton(button), clickCount });
    } catch {
      /* ignore */
    }
  }

  async wheel({ x, y, deltaX = 0, deltaY = 0 }) {
    if (!this.isLive() || this.closed) return;
    this.lastActivity = Date.now();
    try {
      if (Number.isFinite(x) && Number.isFinite(y)) await this.page.mouse.move(x, y);
      await this.page.mouse.wheel(deltaX, deltaY);
    } catch {
      /* ignore */
    }
  }

  async key(params) {
    if (!this.cdp || this.closed) return;
    this.lastActivity = Date.now();
    try {
      await this.cdp.send('Input.dispatchKeyEvent', buildKeyParams(params));
    } catch {
      /* ignore */
    }
  }

  async insertText(text) {
    if (!this.cdp || this.closed) return;
    if (typeof text !== 'string' || !text) return;
    this.lastActivity = Date.now();
    try {
      await this.cdp.send('Input.insertText', { text: text.slice(0, 20000) });
    } catch {
      /* ignore */
    }
  }

  async readSelection() {
    if (!this.isLive() || this.closed) return '';
    try {
      return await this.page.evaluate(() => {
        const element = document.activeElement;
        if (
          element &&
          typeof element.value === 'string' &&
          typeof element.selectionStart === 'number' &&
          typeof element.selectionEnd === 'number' &&
          element.selectionEnd > element.selectionStart
        ) {
          return element.value.slice(element.selectionStart, element.selectionEnd);
        }
        return String(window.getSelection?.() || '');
      });
    } catch {
      return '';
    }
  }

  async maybeReportCursor(x, y) {
    const now = Date.now();
    if (now - this.lastCursorAt < 220 || !this.hasViewers()) return;
    this.lastCursorAt = now;
    const cursor = await this.page
      .evaluate(
        ({ x: px, y: py }) => {
          const element = document.elementFromPoint(px, py);
          if (!element) return 'default';
          return window.getComputedStyle(element).cursor || 'default';
        },
        { x, y },
      )
      .catch(() => null);
    if (cursor && cursor !== this.lastCursor) {
      this.lastCursor = cursor;
      for (const client of this.viewers()) client.send({ t: 'cursor', cursor });
    }
  }

  /* ---------------------------------------------------------------- dialogs */

  handleDialog(dialog) {
    const publicInfo = {
      id: crypto.randomBytes(4).toString('hex'),
      tabId: this.id,
      type: dialog.type(),
      message: dialog.message(),
      defaultValue: dialog.defaultValue(),
    };
    this.pendingDialog = { public: publicInfo, dialog };
    clearTimeout(this.dialogTimer);
    this.dialogTimer = setTimeout(() => {
      this.respondDialog(publicInfo.id, { accept: false }).catch(() => {});
    }, 60000);
    this.dialogTimer.unref?.();
    this.emit('dialog', publicInfo);
    this.emitState();
  }

  async respondDialog(id, { accept = false, text } = {}) {
    if (!this.pendingDialog || this.pendingDialog.public.id !== id) return;
    const { dialog } = this.pendingDialog;
    this.pendingDialog = null;
    clearTimeout(this.dialogTimer);
    try {
      if (accept) await dialog.accept(typeof text === 'string' ? text : undefined);
      else await dialog.dismiss();
    } catch {
      /* ignore */
    }
    this.emitState();
  }

  /* ---------------------------------------------------------------- cleanup */

  isLive() {
    return !this.closed && this.page && !this.page.isClosed();
  }

  isPage(page) {
    return this.page === page;
  }

  handlePageClosed() {
    if (this.intentionalClose) return;
    this.closed = true;
    this.clearTimers();
    this.emit('closed', 'page-closed');
  }

  clearTimers() {
    clearInterval(this.pollTimer);
    clearTimeout(this.settleTimer);
    clearTimeout(this.loadingTimer);
    clearTimeout(this.faviconTimer);
    clearTimeout(this.dialogTimer);
    this.pollTimer = null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.intentionalClose = true;
    this.clearTimers();
    this.streaming = false;
    try {
      await this.cdp?.detach();
    } catch {
      /* ignore */
    }
    this.cdp = null;
    await this.page.close({ runBeforeUnload: false }).catch(() => {});
    await this.context.close().catch(() => {});
    this.emit('closed', 'closed');
  }
}

const normalizeButton = (button) => {
  if (button === 'right' || button === 2) return 'right';
  if (button === 'middle' || button === 1) return 'middle';
  return 'left';
};
