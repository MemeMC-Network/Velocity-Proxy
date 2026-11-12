import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { log } from '../logger.js';
import { assertPublicHttpUrl } from '../security/ip-guard.js';
import { blockedUrlReason } from '../security/content-filter.js';
import { rewriteDocumentTarget } from './site-fixes.js';
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

    // One reusable frame header: the id never changes, only the pixel size and
    // the capture time. Version 3 adds a 4-byte server timestamp at offset 10,
    // so the client can report real end-to-end stream lag instead of guessing.
    const idBuffer = Buffer.from(String(id), 'utf8').subarray(0, 32);
    this.frameHeader = Buffer.alloc(14 + idBuffer.length);
    this.frameHeader.writeUInt32BE(MAGIC, 0);
    this.frameHeader.writeUInt8(3, 4);
    this.frameHeader.writeUInt8(idBuffer.length, 5);
    idBuffer.copy(this.frameHeader, 14);
    this.historyUrl = null;

    this.clients = new Set();
    this.cdp = null;
    this.closed = false;
    this.closing = false;
    this.blocking = false;
    this.intentionalClose = false;
    this.streaming = false;
    this.streamingActive = true;
    // Starts at 1 so the very first frame is never skipped; a static page would
    // otherwise wait for damage that may never come.
    this.frameSkip = 1;
    // Frames per second to capture. Lowered for pages that cannot fit their
    // byte budget even at the quality floor: losing frames costs nothing in
    // sharpness, while lowering quality blurs every line of text.
    this.frameRate = config.screencastFps || 30;
    this.deliveredFrames = 0;
    this.fullscreen = false;
    this.quality = config.frameQuality;
    // A quality the viewer picked by hand is not second-guessed by adaptation.
    this.qualityLocked = false;
    this.viewport = { width: 1280, height: 800 };
    // Captured frame size as a fraction of the page viewport. Once JPEG quality
    // reaches its floor this is the only lever that still cuts bytes and encode
    // cost, so a video-heavy page can drop to 70% instead of saturating the link.
    this.scale = 1;
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
    // When a viewer last watched this tab. `lastActivity` is bumped by polling
    // and by the page itself, so it cannot answer "has anyone looked at this tab
    // recently", which is the question the background-tab sweep asks.
    this.lastViewerAt = Date.now();
    this.lastRecorded = { url: null, title: null, at: 0 };
    this.lastCursor = '';
    this.lastCursorAt = 0;

    this.faviconUrl = null;
    this.faviconHost = null;
    this.faviconAt = 0;
    this.frameSizeEma = 0;
    this.lastQualityChange = 0;
    this.lastFrameSentAt = 0;
    // Frame watch: a screencast that silently stops (stuck compositor, failed
    // software GL) leaves the viewer on a black canvas forever, so capture is
    // restarted when nothing arrives for a while.
    this.lastFrameAt = 0;
    this.frameWatchdog = null;
    this.frameRecoveries = 0;
    // What the encoder actually sustains. A page with constant damage can make
    // Chromium's JPEG encoding the bottleneck, and raising quality then costs
    // frames, which is exactly what reads as lag.
    this.fpsWindowStart = 0;
    this.fpsWindowFrames = 0;
    this.fpsWindowBytes = 0;
    this.deliveredFps = 0;
    // Bytes per second actually put on the wire, which is what a remote viewer
    // feels. A static page sends two big frames and then nothing, so per-frame
    // size would misjudge every article on the web.
    this.deliveredBps = 0;

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
      const blockedReason = blockedUrlReason(url);
      if (blockedReason) {
        this.blockNavigation(url, blockedReason);
        return;
      }
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
    page.on('requestfailed', (request) => {
      // Chromium's URL blocklist aborts the navigation before it commits, so a
      // blocked link or redirect is only reported here.
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        const reason = blockedUrlReason(request.url());
        if (reason) this.blockNavigation(request.url(), reason);
      }
      this.requestSettled();
    });

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

    this.schedulePoll();
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

  /** Prompts the page on a fast cadence while watched, slowly when unwatched. */
  poll() {
    return this.pollOnce()
      .catch(() => {})
      .finally(() => this.schedulePoll());
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (this.closed || !this.isLive()) return;
    this.pollTimer = setTimeout(
      () => this.poll(),
      this.hasViewers() ? 1100 : this.config.idlePollMs,
    );
    this.pollTimer.unref?.();
  }

  async pollOnce() {
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
            fullscreen: Boolean(document.fullscreenElement),
          };
        }, this.muted),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (!info || this.closed) return;

      let changed = false;
      if (Boolean(info.fullscreen) !== this.fullscreen) {
        this.fullscreen = Boolean(info.fullscreen);
        this.emit('fullscreen', this.fullscreen);
      }
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

      // Back/forward availability only changes with the document, so this CDP
      // round trip runs per navigation instead of every poll tick.
      if (this.hasViewers() && this.state.url && this.state.url !== this.historyUrl) {
        const history = await this.cdp.send('Page.getNavigationHistory').catch(() => null);
        if (history) {
          this.historyUrl = this.state.url;
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
    // A blocked or failed page is nothing to suggest later.
    if (this.state.status === 'error') return;
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
    // A page that rewrites its title on a timer (clocks, chat, dashboards) asks
    // for a favicon refresh constantly; one resolved icon per host per minute is
    // plenty and keeps the CDP round trips off the busy path.
    if (this.faviconHost === host && this.faviconUrl && Date.now() - this.faviconAt < 60_000) return;
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
    this.faviconHost = host;
    this.faviconAt = Date.now();
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
    this.lastViewerAt = Date.now();
    this.emitState();
    this.resumeMedia().catch(() => {});
    this.startStreaming().catch(() => {});
    this.primeFrame().catch(() => {});
    this.scheduleFaviconRefresh();
    this.poll().catch(() => {});
  }

  detach(client) {
    this.clients.delete(client);
    if (!this.hasViewers()) {
      this.lastViewerAt = Date.now();
      this.stopStreaming().catch(() => {});
      // Nobody is listening to this tab's audio (background tabs are muted), so
      // keep it from decoding video for an empty room.
      this.pauseMedia().catch(() => {});
    }
  }

  async startStreaming() {
    if (this.streaming || this.closed || !this.cdp || !this.streamingActive) return;
    this.streaming = true;
    try {
      await this.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.quality,
        maxWidth: Math.max(320, Math.round(this.viewport.width * this.scale)),
        maxHeight: Math.max(240, Math.round(this.viewport.height * this.scale)),
        everyNthFrame: this.frameSkip,
      });
      this.lastFrameAt = Date.now();
      this.armFrameWatchdog();
    } catch (error) {
      this.streaming = false;
      log.warn('startScreencast failed', this.id, String(error.message).split('\n')[0]);
    }
  }

  /**
   * Restarts a screencast that has gone quiet.
   *
   * A tab that stalls twice is watched more slowly instead of being abandoned:
   * giving up left the viewer on a black canvas until it reloaded the page, and
   * on a small host a heavy page can stall more than twice and still recover.
   * `frameRecoveries` returns to zero on the next frame, so a tab that paints
   * again is watched at the normal cadence.
   */
  armFrameWatchdog() {
    clearTimeout(this.frameWatchdog);
    if (this.closed) return;
    const stallMs = this.frameRecoveries >= 2 ? 30_000 : 12_000;
    this.frameWatchdog = setTimeout(async () => {
      this.frameWatchdog = null;
      if (this.closed || !this.streaming) return;
      if (Date.now() - this.lastFrameAt < stallMs) {
        this.armFrameWatchdog();
        return;
      }
      // A page with no animation paints once and then correctly sends nothing.
      // Restarting the screencast on that was re-encoding a frame every 12 s on
      // every static tab, so ask the compositor for one frame first: only a
      // failed probe means capture is actually stuck.
      if (this.deliveredFrames > 0) {
        const probe = await this.captureScreenshot(55).catch(() => null);
        if (probe) {
          this.lastFrameAt = Date.now();
          this.armFrameWatchdog();
          return;
        }
      }
      this.frameRecoveries += 1;
      // A capture that keeps stalling is usually the encoder rather than the
      // compositor, so ask for less of it: fewer frames and a smaller surface.
      const rate = Math.max(10, Math.min(this.frameRate, 15));
      const scale = Math.min(this.scale, 0.7);
      const cheaper = rate !== this.frameRate || scale !== this.scale;
      log.warn(
        `tab ${this.id} produced no screencast frames for ${Math.round(stallMs / 1000)}s - ` +
          `restarting capture${cheaper ? ` at ${rate} fps / ${Math.round(scale * 100)}%` : ''} ` +
          '(a GPU-less host renders in software; WebGL needs software GL enabled)',
      );
      this.frameRate = rate;
      this.frameSkip = Math.max(1, Math.round(60 / rate));
      this.scale = scale;
      this.restartStreaming().catch(() => {});
    }, stallMs);
    this.frameWatchdog.unref?.();
  }

  async stopStreaming() {
    clearTimeout(this.frameWatchdog);
    this.frameWatchdog = null;
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

  /**
   * A hidden viewer needs no frames. Stopping the screencast also stops
   * Chromium's JPEG encoding, which is the biggest CPU cost of a live tab.
   */
  async setStreamingActive(active) {
    const next = Boolean(active);
    this.lastActivity = Date.now();
    if (next === this.streamingActive) {
      if (next && !this.streaming) await this.startStreaming();
      return;
    }
    this.streamingActive = next;
    if (next) {
      this.resumeMedia().catch(() => {});
      await this.startStreaming();
      this.primeFrame().catch(() => {});
    } else {
      await this.stopStreaming();
      // A hidden viewer gets no frames, so there is no reason for the page to
      // keep playing video behind it.
      this.pauseMedia().catch(() => {});
    }
  }

  async pauseMedia() {
    if (!this.isLive() || this.closed) return;
    await this.page
      .evaluate(() => {
        for (const el of document.querySelectorAll('video,audio')) {
          if (el.paused) continue;
          try {
            el.pause();
            el.dataset.velocityPaused = '1';
          } catch {
            /* detached element */
          }
        }
      })
      .catch(() => {});
  }

  async resumeMedia() {
    if (!this.isLive() || this.closed) return;
    await this.page
      .evaluate(() => {
        for (const el of document.querySelectorAll('[data-velocity-paused]')) {
          delete el.dataset.velocityPaused;
          try {
            const playing = el.play();
            playing?.catch?.(() => {});
          } catch {
            /* autoplay refused */
          }
        }
      })
      .catch(() => {});
  }

  /**
   * Wraps one JPEG in the wire packet: magic, version, tab id, pixel size and
   * the capture time, followed by the image itself.
   */
  framePacket(data, width, height, now = Date.now()) {
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
    const header = this.frameHeader;
    header.writeUInt16BE(clamp(Math.round(width), 1, 65535), 6);
    header.writeUInt16BE(clamp(Math.round(height), 1, 65535), 8);
    header.writeUInt32BE(now >>> 0, 10);
    // One allocation and two copies per frame instead of Buffer.concat, which
    // allocated twice and copied the JPEG twice at ~30 frames/second/tab.
    const packet = Buffer.allocUnsafe(header.length + frame.length);
    header.copy(packet, 0);
    frame.copy(packet, header.length);
    return packet;
  }

  handleScreencastFrame(event) {
    if (!this.cdp || this.closed) return;
    this.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    this.lastFrameAt = Date.now();
    this.frameRecoveries = 0;
    const viewers = this.viewers();
    if (!viewers.length) return;

    // Chromium already skips frames (everyNthFrame, set from SCREENCAST_FPS), so
    // this gate is only a safety net for a page that emits damage in bursts. It
    // must not run at the same threshold as everyNthFrame: arrival jitter of a
    // millisecond or two would then drop perfectly good frames and halve the
    // rate, which reads as lag. A quarter of a frame of slack is enough.
    const now = Date.now();
    const minInterval = (1000 / (this.config.screencastFps || 30)) * 0.75;
    if (now - this.lastFrameSentAt < minInterval) return;
    this.lastFrameSentAt = now;

    const jpeg = Buffer.from(event.data, 'base64');
    // Version 2 carries the frame's own pixel size, so the client can letterbox
    // instead of stretching whenever page size and viewport disagree.
    const width = clamp(Math.round(event.metadata?.deviceWidth || this.viewport.width), 1, 65535);
    const height = clamp(Math.round(event.metadata?.deviceHeight || this.viewport.height), 1, 65535);
    const packet = this.framePacket(jpeg, width, height, now);

    for (const client of viewers) client.sendFrame(packet);
    this.lastActivity = Date.now();

    // Chromium encodes every Nth compositor frame and the client drops what it
    // cannot use, so skipping here means those frames are never JPEG-encoded at
    // all: at 30 fps each second costs ~30 encodes instead of ~60 (measured 28%
    // less browser CPU on a 60 fps page). The switch happens after the first
    // frame, which guarantees a static page still paints something.
    this.deliveredFrames += 1;
    if (this.deliveredFrames === 1) {
      const target = Math.max(1, Math.round(60 / this.frameRate));
      if (target !== this.frameSkip) {
        this.frameSkip = target;
        this.restartStreaming().catch(() => {});
      }
    }

    this.fpsWindowFrames += 1;
    this.fpsWindowBytes += jpeg.length;
    if (!this.fpsWindowStart) this.fpsWindowStart = now;
    else if (now - this.fpsWindowStart >= 1000) {
      const elapsed = now - this.fpsWindowStart;
      this.deliveredFps = (this.fpsWindowFrames * 1000) / elapsed;
      this.deliveredBps = (this.fpsWindowBytes * 1000) / elapsed;
      this.fpsWindowFrames = 0;
      this.fpsWindowBytes = 0;
      this.fpsWindowStart = now;
    }

    this.frameSizeEma = this.frameSizeEma ? this.frameSizeEma * 0.9 + jpeg.length * 0.1 : jpeg.length;
    // Bandwidth is what a remote viewer actually feels: 30 frames of 100 KB is
    // 24 Mbps, which a small VPS uplink cannot carry, so frames queue and then
    // get dropped, which reads as laggy video. Keep the byte rate under the
    // configured budget by lowering quality first and resolution second.
    if (!this.qualityLocked && now - this.lastQualityChange > 8000) {
      const cap = (this.config.streamMaxKbps * 1000) / 8;
      const rate = this.deliveredBps;
      const configFps = this.config.screencastFps || 30;
      let next = this.quality;
      let nextScale = this.scale;
      let nextRate = this.frameRate;
      if (rate > cap) {
        // Quality first (still legible at 40), then frame rate, and only then
        // capture resolution. Wide thresholds keep it from oscillating.
        if (this.quality > 40) next = Math.max(40, this.quality - 8);
        else if (nextRate > 20) nextRate = 20;
        else if (nextScale > 0.7) nextScale = Math.max(0.7, Math.round((nextScale - 0.15) * 100) / 100);
      } else if (rate > 0 && rate < cap * 0.45) {
        if (nextScale < 1) nextScale = Math.min(1, Math.round((nextScale + 0.15) * 100) / 100);
        else if (next < this.config.frameQuality) next = Math.min(this.config.frameQuality, this.quality + 4);
        else if (nextRate < configFps) nextRate = configFps;
      }
      // A restart re-encodes from scratch, so only significant, infrequent
      // changes are worth one.
      if (
        Math.abs(next - this.quality) >= 6 ||
        Math.abs(nextScale - this.scale) >= 0.1 ||
        nextRate !== this.frameRate
      ) {
        log.debug(
          'stream tuned',
          this.id,
          `quality ${this.quality}->${next}`,
          `scale ${this.scale.toFixed(2)}->${nextScale.toFixed(2)}`,
          `fps ${this.frameRate}->${nextRate}`,
          `rate ${Math.round(rate / 1000)}/${Math.round(cap / 1000)}KBps actual ${Math.round(this.deliveredFps)}`,
        );
        this.quality = next;
        this.scale = Math.round(nextScale * 100) / 100;
        this.frameRate = nextRate;
        this.frameSkip = Math.max(1, Math.round(60 / nextRate));
        this.lastQualityChange = now;
        this.restartStreaming().catch(() => {});
      }
    }
  }

  /**
   * Sends one immediate capture to the current viewers.
   *
   * A viewer that has just opened, switched to or resized a tab is looking at an
   * empty canvas, and a screencast only paints when the page damages itself, so a
   * static page leaves that canvas blank until something moves. One cheap encode
   * per activation removes the wait and is not part of the per-frame path.
   */
  async primeFrame() {
    if (this.closed || !this.cdp || !this.isLive() || !this.hasViewers()) return;
    // A live frame is already on its way, and an older capture must not overwrite
    // it: skip priming rather than race the screencast.
    if (this.lastFrameSentAt && Date.now() - this.lastFrameSentAt < 250) return;
    const data = await this.captureScreenshot(55).catch(() => null);
    if (!data || this.closed || !this.cdp) return;
    if (this.lastFrameSentAt && Date.now() - this.lastFrameSentAt < 250) return;
    const viewers = this.viewers();
    if (!viewers.length) return;
    const packet = this.framePacket(data, this.viewport.width, this.viewport.height);
    for (const client of viewers) client.sendFrame(packet);
    // Counts as paint activity, so the stall watchdog does not restart a capture
    // that is working.
    this.lastFrameAt = Date.now();
  }

  setQuality(value) {
    const quality = clamp(value, 25, 85);
    if (Math.abs(quality - this.quality) < 2) return;
    this.quality = quality;
    this.scale = 1;
    this.qualityLocked = true;
    this.lastQualityChange = Date.now();
    this.restartStreaming().catch(() => {});
  }

  /** JPEG capture of the current viewport, for the client to save. */
  async captureScreenshot(quality = 82) {
    if (!this.isLive() || this.closed) return null;
    const result = await this.cdp
      .send('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false })
      .catch(() => null);
    return result?.data || null;
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
    // A target a site breaks server-side (TikTok search) is swapped for the
    // page that renders the same results, before it is ever requested.
    const target = await assertPublicHttpUrl(rewriteDocumentTarget(rawUrl) || rawUrl);
    if (this.closed) throw new Error('This tab is closed');
    const blockedReason = blockedUrlReason(target.href);
    if (blockedReason) {
      this.blockNavigation(target.href, blockedReason);
      return;
    }
    this.navSeq += 1;
    const token = this.navSeq;
    this.historyUrl = null;
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
    this.historyUrl = null;
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
    this.historyUrl = null;
    try {
      await this.page.goForward({ waitUntil: 'commit', timeout: 20000 });
    } catch {
      /* no history entry */
    }
    await this.refreshMeta();
  }

  async reload() {
    if (!this.isLive()) return;
    const blockedReason = blockedUrlReason(this.state.url);
    if (blockedReason && !this.blocking) {
      this.blockNavigation(this.state.url, blockedReason);
      return;
    }
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

  /**
   * Shows the tab's blocked state and blanks the page, so filtered content is
   * never rendered, kept in memory, or added to history.
   */
  blockNavigation(rawUrl, reason) {
    if (this.closed) return;
    const host = hostOf(rawUrl);
    this.navSeq += 1;
    this.state.url = /^https?:/.test(rawUrl) ? rawUrl : null;
    this.state.title = host || 'Blocked';
    this.state.status = 'error';
    this.state.error = reason;
    this.state.loading = false;
    this.pendingDialog = null;
    this.faviconUrl = null;
    this.lastSnapshotJson = '';
    this.emitState();
    if (!this.isLive() || this.blocking) return;
    this.blocking = true;
    this.page
      .goto('about:blank', { waitUntil: 'commit', timeout: 5000 })
      .catch(() => {})
      .finally(() => {
        this.blocking = false;
      });
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

  /**
   * Highlights matches inside the remote page.
   *
   * Chromium 156 no longer exposes Page.findInPage over CDP, so this walks the
   * text nodes and paints ranges with the CSS Custom Highlight API: no DOM
   * mutation (which would break SPAs) and a real match count to show in the UI.
   */
  async find(text, { forward = true, findNext = false } = {}) {
    if (this.closed || !this.isLive()) return null;
    const query = typeof text === 'string' ? text.slice(0, 200) : '';
    if (!query) {
      await this.stopFind();
      return { matches: 0, active: 0, query: '' };
    }
    try {
      const result = await this.page.evaluate(
        ({ needle, forward: dir, findNext: step }) => {
          if (!window.CSS?.highlights || typeof Highlight !== 'function') {
            return { unsupported: true, matches: 0, active: 0 };
          }
          if (!document.querySelector('style[data-velocity-find]')) {
            const style = document.createElement('style');
            style.dataset.velocityFind = '1';
            style.textContent = '::highlight(velocity-find){background:#ffd76a;color:#151412;}'
            document.documentElement.appendChild(style);
          }
          const root = document.body;
          if (!root) return { matches: 0, active: 0 };
          const ranges = [];
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              const value = node.nodeValue;
              if (!value || !value.trim()) return NodeFilter.FILTER_REJECT;
              const parent = node.parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT;
              if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|TITLE)$/.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
              const view = parent.ownerDocument.defaultView;
              const style = view.getComputedStyle(parent);
              if (style.visibility === 'hidden' || style.display === 'none') return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            },
          });
          let node;
          let guard = 0;
          while (ranges.length < 500 && (node = walker.nextNode()) && guard < 20000) {
            guard += 1;
            const haystack = node.nodeValue.toLowerCase();
            let from = 0;
            while (ranges.length < 500) {
              const at = haystack.indexOf(needle, from);
              if (at < 0) break;
              const range = document.createRange();
              range.setStart(node, at);
              range.setEnd(node, at + needle.length);
              ranges.push(range);
              from = at + needle.length;
            }
          }
          if (!ranges.length) {
            window.CSS.highlights.delete('velocity-find');
            return { matches: 0, active: 0 };
          }
          const store = window.__velocityFind || { needle: '', index: -1 };
          if (store.needle !== needle) {
            store.needle = needle;
            store.index = -1;
          }
          store.index = step
            ? (store.index + (dir ? 1 : -1) + ranges.length) % ranges.length
            : 0;
          window.__velocityFind = store;
          window.CSS.highlights.set('velocity-find', new Highlight(...ranges));
          const active = ranges[store.index];
          if (active) {
            const rect = active.getBoundingClientRect();
            if (rect.top < 0 || rect.bottom > window.innerHeight) {
              active.startContainer.parentElement?.scrollIntoView({ block: 'center' });
            }
          }
          return { matches: ranges.length, active: store.index + 1 };
        },
        { needle: query.toLowerCase(), forward, findNext },
      );
      return { matches: Number(result?.matches) || 0, active: Number(result?.active) || 0, query };
    } catch (error) {
      log.debug('find failed', this.id, String(error.message).split('\n')[0]);
      return null;
    }
  }

  async stopFind() {
    if (this.closed || !this.isLive()) return;
    await this.page
      .evaluate(() => {
        window.CSS?.highlights?.delete('velocity-find');
        window.__velocityFind = null;
      })
      .catch(() => {});
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
    clearTimeout(this.pollTimer);
    clearTimeout(this.settleTimer);
    clearTimeout(this.loadingTimer);
    clearTimeout(this.faviconTimer);
    clearTimeout(this.dialogTimer);
    clearTimeout(this.frameWatchdog);
    this.frameWatchdog = null;
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
