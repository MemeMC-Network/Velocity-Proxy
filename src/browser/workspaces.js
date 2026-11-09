import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { TabSession } from './tab.js';
import { CookieJar } from '../light/cookies.js';
import { FaviconCache } from './favicon.js';
import { HttpError } from '../errors.js';
import { log } from '../logger.js';
import { assertPublicHttpUrl, isBlockedUrl } from '../security/ip-guard.js';
import { blockedUrlReason } from '../security/content-filter.js';
import { rewriteDocumentTarget } from './site-fixes.js';
import { hostOf, randomId, shortHash } from '../util.js';

const PLATFORM =
  process.platform === 'win32'
    ? { uaToken: 'Windows NT 10.0; Win64; x64', name: 'Windows', version: '10.0.0' }
    : process.platform === 'darwin'
      ? { uaToken: 'Macintosh; Intel Mac OS X 10_15_7', name: 'macOS', version: '10.15.7' }
      : { uaToken: 'X11; Linux x86_64', name: 'Linux', version: '6.5.0' };

/**
 * Chromium keeps "HeadlessChrome" in its Client Hints even when the UA string is
 * rewritten, and sites such as GeForce NOW read either one as an unsupported
 * browser. Present a consistent desktop Chrome identity instead.
 */
const buildStealthScript = ({ version, major }) => `
Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined });
if (!window.chrome) { Object.defineProperty(window, 'chrome', { value: { runtime: {} }, writable: true }); }
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
// Plugin objects, not bare numbers: apps read .name/.filename and crash on
// undefined.startsWith() when the entries are not shaped like the real thing.
try {
  const plugin = (name) => ({
    name,
    description: 'Portable Document Format',
    filename: 'internal-pdf-viewer',
    length: 0,
  });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      plugin('PDF Viewer'),
      plugin('Chrome PDF Viewer'),
      plugin('Chromium PDF Viewer'),
      plugin('Microsoft Edge PDF Viewer'),
      plugin('WebKit built-in PDF'),
    ],
  });
} catch (error) {}
try {
  const brands = [
    { brand: 'Google Chrome', version: '${major}' },
    { brand: 'Chromium', version: '${major}' },
    { brand: 'Not A(Brand', version: '8' },
  ];
  const fullVersionList = [
    { brand: 'Google Chrome', version: '${version}' },
    { brand: 'Chromium', version: '${version}' },
  ];
  const data = {
    brands,
    fullVersionList,
    mobile: false,
    platform: '${PLATFORM.name}',
    getHighEntropyValues: async () => ({
      brands,
      fullVersionList,
      mobile: false,
      platform: '${PLATFORM.name}',
      platformVersion: '${PLATFORM.version}',
      architecture: 'x86',
      bitness: '64',
      model: '',
      uaFullVersion: '${version}',
      wow64: false,
    }),
  };
  Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => data, configurable: true });
} catch (error) {}
`;

const TAB_ID_PATTERN = /^[a-f0-9]{8,40}$/;
const HISTORY_LIMIT = 200;

export class WorkspaceManager {
  constructor(config, { audio = null, light = null } = {}) {
    this.config = config;
    this.audio = audio;
    this.light = light;
    // Per-session audio needs a Chromium process per workspace, because Chromium
    // picks its audio device (PULSE_SINK) when the process starts.
    this.shared = { browser: null, launching: null };
    this.browsers = new Map();
    this.browserVersion = null;
    this.workspaces = new Map();
    this.pending = new Map();
    this.pageOwners = new Map();
    this.contextOwners = new WeakMap();
    this.favicons = new FaviconCache(path.join(config.dataDir, 'favicons'));
    this.cleanupTimer = null;
    this.cleaning = false;
    this.stopping = false;
    this.sandboxDisabled = false;
    this.maxLiveTabs = config.maxLiveTabs;
  }

  get perSessionAudio() {
    return Boolean(this.audio?.perSession);
  }

  /** The browser used for status checks and logs. */
  get browser() {
    if (this.shared.browser) return this.shared.browser;
    for (const entry of this.browsers.values()) {
      if (entry.browser) return entry.browser;
    }
    return null;
  }

  async start() {
    if (this.perSessionAudio) {
      log.info('Per-session audio: each signed-in visitor gets a Chromium process and audio sink');
    } else {
      // Launched on the first browser-engine tab, not at boot: a server whose
      // visitors only use the lightweight engine must never pay for Chromium,
      // and an idle server should not hold a browser open either.
      log.info('Chromium will launch with the first browser-engine tab');
    }
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch((error) => log.debug('cleanup failed', error.message));
    }, 60_000);
    this.cleanupTimer.unref?.();
  }

  async ensureBrowser(workspace = null) {
    if (this.stopping) throw new Error('Proxy is shutting down');

    if (!this.perSessionAudio) {
      if (this.shared.browser?.isConnected()) return this.shared.browser;
      if (this.shared.launching) return this.shared.launching;
      this.shared.launching = this.launchBrowser(null)
        .then((browser) => {
          this.shared.browser = browser;
          browser.on('disconnected', () => {
            if (this.stopping) return;
            log.warn('Chromium disconnected - sessions will be recreated on demand');
            this.shared.browser = null;
            for (const candidate of this.workspaces.values()) candidate.handleBrowserDisconnect();
          });
          return browser;
        })
        .finally(() => {
          this.shared.launching = null;
        });
      return this.shared.launching;
    }

    const key = workspace.key;
    let entry = this.browsers.get(key);
    if (entry?.browser?.isConnected()) return entry.browser;
    if (entry?.launching) return entry.launching;

    await this.enforceBrowserLimit();
    const sink = await this.audio.prepareSink(key);
    entry = entry || { workspace, browser: null, launching: null };
    this.browsers.set(key, entry);
    entry.launching = this.launchBrowser(sink)
      .then((browser) => {
        entry.browser = browser;
        browser.on('disconnected', () => {
          if (this.stopping) return;
          log.warn('Chromium for a session disconnected - its tabs will be recreated on demand');
          entry.browser = null;
          entry.workspace.handleBrowserDisconnect();
        });
        return browser;
      })
      .catch((error) => {
        if (this.browsers.get(key) === entry) this.browsers.delete(key);
        throw error;
      })
      .finally(() => {
        entry.launching = null;
      });
    return entry.launching;
  }

  /**
   * Keeps the number of Chromium processes bounded. Only browsers whose
   * workspace has no connected client are evicted (least recently active
   * first), so someone who is actually watching is never kicked.
   */
  async enforceBrowserLimit() {
    if (!this.perSessionAudio) return;
    const limit = Math.max(1, this.config.maxLiveBrowsers);
    if (this.browsers.size < limit) return;
    const excess = this.browsers.size - limit + 1;
    const candidates = [...this.browsers.values()]
      .filter((entry) => entry.workspace.clients.size === 0)
      .sort((a, b) => a.workspace.lastActiveAt - b.workspace.lastActiveAt)
      .slice(0, excess);
    if (!candidates.length) return;
    for (const entry of candidates) {
      for (const record of entry.workspace.records.values()) {
        if (record.session) await entry.workspace.suspend(record).catch(() => {});
      }
      await this.releaseBrowser(entry.workspace).catch(() => {});
      log.debug('evicted idle Chromium to stay within MAX_LIVE_BROWSERS');
    }
  }

  /** Closes a workspace's browser (and its audio sink) when nothing needs it. */
  async releaseBrowser(workspace) {
    if (!this.perSessionAudio) return;
    const entry = this.browsers.get(workspace.key);
    if (!entry) return;
    this.browsers.delete(workspace.key);
    if (entry.launching) await entry.launching.catch(() => {});
    if (entry.browser) await entry.browser.close().catch(() => {});
    entry.browser = null;
    this.audio?.releaseSession(workspace.key);
  }

  async launchBrowser(sink) {
    const headless = this.config.browserMode === 'headless';
    const args = [
      '--disable-dev-shm-usage',
      // Opt-in only: Chromium does not support single-process browsing, and it
      // removes the renderer sandbox and site isolation.
      ...(this.config.chromiumSingleProcess ? ['--single-process'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--font-render-hinting=none',
      '--lang=en-US',
      // Bounded disk/media cache: a shared proxy should not let a few heavy
      // sites grow the cache directory without limit.
      '--disk-cache-size=33554432',
      '--media-cache-size=4194304',
      // A server browser has no user to serve these services to; they only cost
      // idle CPU, memory and traffic.
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-breakpad',
      '--disable-domain-reliability',
      '--disable-client-side-phishing-detection',
      '--disable-component-extensions-with-background-pages',
      '--no-service-autorun',
      '--disable-prompt-on-repost',
      '--no-pings',
      '--metrics-recording-only',
      '--disable-features=Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions,' +
        'AutofillServerCommunication,CalculateNativeWinOcclusion,NotificationTriggers',
      ...(this.config.chromiumJsHeapMb > 0
        ? [`--js-flags=--max-old-space-size=${this.config.chromiumJsHeapMb}`]
        : []),
      // Audio is captured from this browser's output, so its output buffer is
      // latency the viewer hears. Chromium clamps the value to 512-8192 frames.
      ...(this.config.chromiumAudioBuffer > 0
        ? [`--audio-buffer-size=${this.config.chromiumAudioBuffer}`]
        : []),
      // Most VPS hosts have no GPU, and Chrome 139+ refuses to create a WebGL
      // context without hardware acceleration unless this opt-in is present, so
      // WebGL pages render blank. Headless only; it changes no sandbox setting.
      ...(headless && this.config.chromiumSoftwareGl ? ['--enable-unsafe-swiftshader'] : []),
      ...this.config.chromiumArgs,
    ];
    const base = {
      headless,
      args,
      timeout: 90_000,
      executablePath: this.config.chromiumPath || undefined,
      // Playwright silences the browser by default; page audio is the whole point here.
      ignoreDefaultArgs: ['--mute-audio'],
      env: {
        ...process.env,
        LANG: 'en_US.UTF-8',
        ...(this.config.audioPulseServer ? { PULSE_SERVER: this.config.audioPulseServer } : {}),
        ...((sink || this.config.audioPulseSink)
          ? { PULSE_SINK: sink || this.config.audioPulseSink }
          : {}),
      },
    };

    const sandboxPreference = this.config.chromiumSandbox;
    const wantSandbox = sandboxPreference === 'on' || (sandboxPreference === 'auto' && !this.config.isRoot);
    if (this.config.chromiumSingleProcess) {
      log.warn(
        'CHROMIUM_SINGLE_PROCESS is on: pages share one process and the renderer sandbox and site isolation are off',
      );
    }

    const attempt = async (sandbox, candidate) => {
      const browser = await chromium.launch({
        ...base,
        // Chromium refuses the sandbox in single-process mode.
        chromiumSandbox: sandbox && !this.config.chromiumSingleProcess,
        ...(candidate.channel ? { channel: candidate.channel } : {}),
      });
      this.browserVersion = browser.version();
      this.browserChannel = candidate.label;
      log.info(
        `Chromium launched (${candidate.label}, ${headless ? 'headless' : 'headed'}, ` +
          `sandbox ${sandbox ? 'on' : 'off'}, version ${browser.version()})`,
      );
      if (!sandbox) this.sandboxDisabled = true;
      return browser;
    };

    let lastError = null;
    for (const candidate of this.browserCandidates()) {
      try {
        return await attempt(wantSandbox, candidate);
      } catch (error) {
        lastError = error;
        if (wantSandbox) {
          log.warn('Chromium sandbox unavailable, retrying without it:', String(error.message).split('\n')[0]);
          try {
            return await attempt(false, candidate);
          } catch (retryError) {
            lastError = retryError;
          }
        }
        if (candidate.channel) {
          log.debug(`${candidate.label} unavailable:`, String(lastError.message).split('\n')[0]);
        }
      }
    }
    throw lastError || new Error('No Chromium binary could be launched');
  }

  /**
   * Browser binaries to try, best first. An installed Chrome updates itself and
   * carries the real Chrome brand plus proprietary codecs; Playwright's bundled
   * build is pinned to the installed playwright version, so it is the fallback.
   */
  browserCandidates() {
    if (this.config.chromiumPath) return [{ channel: null, label: 'CHROMIUM_PATH binary' }];
    const bundled = { channel: null, label: 'bundled Chromium' };
    switch (this.config.chromiumChannel) {
      case 'chrome':
        return [{ channel: 'chrome', label: 'Chrome channel' }, bundled];
      case 'msedge':
        return [{ channel: 'msedge', label: 'Edge channel' }, bundled];
      case 'bundled':
        return [bundled];
      default:
        return [
          { channel: 'chrome', label: 'Chrome channel' },
          { channel: 'msedge', label: 'Edge channel' },
          bundled,
        ];
    }
  }

  /** Pads `156`, `156.0.8078` or `156.0.8078.81` into a four-part version. */
  normalizeVersion(value, fallback) {
    const parts = String(value || '')
      .trim()
      .split('.')
      .filter((part) => /^\d+$/.test(part));
    if (!parts.length) return fallback;
    const filled = parts.slice(0, 4);
    while (filled.length < 4) filled.push('0');
    return filled.join('.');
  }

  /** A normal desktop Chrome identity for a launched browser (USER_AGENT wins). */
  fingerprintFor(browser) {
    const actual = browser?.version() || '120.0.0.0';
    const version = this.config.chromeVersion
      ? this.normalizeVersion(this.config.chromeVersion, actual)
      : actual;
    const major = version.split('.')[0] || '120';
    const userAgent =
      this.config.userAgent ||
      `Mozilla/5.0 (${PLATFORM.uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
    return { userAgent, version, major, platformName: PLATFORM.name, platformVersion: PLATFORM.version };
  }

  /**
   * Client Hints are sent as HTTP headers, so rewriting the JS-visible UA string
   * is not enough: Chromium still advertises "HeadlessChrome" in `sec-ch-ua`
   * and X answers the document with 403. Set the full metadata over CDP on the
   * page before it navigates.
   */
  async applyFingerprint(page) {
    if (!page || page.isClosed()) return;
    const fingerprint = this.fingerprintFor(page.context().browser?.());
    const brands = [
      { brand: 'Google Chrome', version: fingerprint.major },
      { brand: 'Chromium', version: fingerprint.major },
      { brand: 'Not A(Brand', version: '24' },
    ];
    let cdp;
    try {
      cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.setUserAgentOverride', {
        userAgent: fingerprint.userAgent,
        acceptLanguage: 'en-US,en',
        platform: 'Win32',
        userAgentMetadata: {
          brands,
          fullVersionList: [
            { brand: 'Google Chrome', version: fingerprint.version },
            { brand: 'Chromium', version: fingerprint.version },
            { brand: 'Not A(Brand', version: '24.0.0.0' },
          ],
          fullVersion: fingerprint.version,
          platform: fingerprint.platformName,
          platformVersion: fingerprint.platformVersion,
          architecture: 'x86',
          model: '',
          mobile: false,
          bitness: '64',
          wow64: false,
        },
      });
    } catch (error) {
      log.debug('user agent override failed', String(error.message).split('\n')[0]);
    }
    // The session must stay attached: detaching it reverts the override and
    // Chromium starts advertising HeadlessChrome again.
  }

  async createContext(workspace, { storageState } = {}) {
    const browser = await this.ensureBrowser(workspace);
    const viewport = { width: 1280, height: 800 };
    const fingerprint = this.fingerprintFor(browser);
    const context = await browser.newContext({
      viewport,
      screen: viewport,
      deviceScaleFactor: 1,
      locale: 'en-US',
      colorScheme: 'light',
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      serviceWorkers: 'allow',
      userAgent: fingerprint.userAgent,
      storageState: storageState || undefined,
    });
    context.setDefaultTimeout(20_000);
    context.setDefaultNavigationTimeout(this.config.navTimeoutMs);
    this.contextOwners.set(context, workspace);
    await context.addInitScript(buildStealthScript(fingerprint)).catch(() => {});
    // What a full-screen web app asks for: clipboard access ("copy the invite
    // link") and a screen wake lock. Neither reaches the host machine.
    await context
      .grantPermissions(['clipboard-read', 'clipboard-write', 'screen-wake-lock', 'storage-access'])
      .catch(() => context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {}));

    // Safe search survives navigation: YouTube's restricted mode and
    // DuckDuckGo's strict filter are cookie driven, unlike the URL flags.
    if (this.config.contentFilter) {
      await context
        .addCookies([
          { name: 'PREF', value: 'f2=8000000', domain: '.youtube.com', path: '/', secure: true, httpOnly: false },
          { name: 'kp', value: '1', domain: 'duckduckgo.com', path: '/', secure: true, httpOnly: false },
        ])
        .catch(() => {});
    }

    // The content filter rides on the SSRF route: in `routes` mode every request
    // is already intercepted, so blocking a host here costs no extra work and
    // catches links, redirects, popups and embedded resources alike.
    if (this.config.ssrfGuard === 'routes') {
      await context.route('**/*', async (route) => {
        const requestUrl = route.request().url();
        if (blockedUrlReason(requestUrl)) {
          await route.abort('blockedbyclient');
          return;
        }
        try {
          if (await isBlockedUrl(requestUrl)) {
            await route.abort('blockedbyclient');
            return;
          }
        } catch {
          /* validation failure: fall through to continue */
        }
        if (route.request().isNavigationRequest()) {
          const fixed = rewriteDocumentTarget(requestUrl);
          if (fixed) {
            log.debug('site compatibility rewrite', requestUrl.slice(0, 90), '->', fixed);
            await route.continue({ url: fixed }).catch(() => {});
            return;
          }
        }
        await route.continue().catch(() => {});
      });
    }

    try {
      await context.routeWebSocket('**/*', async (ws) => {
        try {
          if (blockedUrlReason(ws.url()) || (await isBlockedUrl(ws.url()))) {
            await ws.close({ code: 1008, reason: 'Blocked by proxy policy' });
            return;
          }
        } catch {
          /* ignore */
        }
        ws.connectToServer();
      });
    } catch (error) {
      log.debug('routeWebSocket unavailable', String(error.message).split('\n')[0]);
    }

    context.on('page', (page) => {
      // Popups navigate immediately, so the header identity has to be set now.
      this.applyFingerprint(page).catch(() => {});
      setTimeout(() => {
        this.adoptPage(workspace, page).catch((error) => log.debug('popup adopt failed', error.message));
      }, 350).unref?.();
    });

    return context;
  }

  async adoptPage(workspace, page) {
    if (!page || page.isClosed() || this.pageOwners.has(page)) return;
    if (this.contextOwners.get(page.context()) !== workspace) return;
    await workspace.adopt(page);
  }

  async getWorkspace(key) {
    if (!key) throw new HttpError(400, 'Missing session');
    const existing = this.workspaces.get(key);
    if (existing) {
      existing.touch();
      return existing;
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const promise = (async () => {
      const workspace = new Workspace({ key, manager: this, config: this.config });
      await workspace.load();
      this.workspaces.set(key, workspace);
      this.pending.delete(key);
      return workspace;
    })();
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }

  liveTabCount() {
    let count = 0;
    for (const workspace of this.workspaces.values()) {
      for (const record of workspace.records.values()) {
        if (record.session && record.session.isLive()) count += 1;
      }
    }
    return count;
  }

  /** Pages served by the lightweight engine: these hold no Chromium at all. */
  lightTabCount() {
    let count = 0;
    for (const workspace of this.workspaces.values()) {
      for (const record of workspace.records.values()) {
        if ((record.engine || 'chromium') === 'light' && record.url) count += 1;
      }
    }
    return count;
  }

  async enforceLiveLimit(workspace) {    if (this.liveTabCount() < this.maxLiveTabs) return;
    const candidates = [];
    for (const other of this.workspaces.values()) {
      for (const record of other.records.values()) {
        if (record.session && record.session.isLive() && !record.session.hasViewers() && record.id !== workspace.activeRecordId) {
          candidates.push({ workspace: other, record });
        }
      }
    }
    candidates.sort((a, b) => (a.record.lastUsedAt || 0) - (b.record.lastUsedAt || 0));
    for (const candidate of candidates.slice(0, Math.max(1, candidates.length - this.maxLiveTabs + 1))) {
      await candidate.workspace.suspend(candidate.record).catch(() => {});
    }
  }

  async cleanup() {
    if (this.cleaning || this.stopping) return;
    this.cleaning = true;
    try {
      const now = Date.now();
      for (const [key, workspace] of this.workspaces) {
        if (workspace.clients.size > 0) continue;
        if (now - workspace.lastActiveAt > this.config.tabIdleMs) {
          for (const record of workspace.records.values()) {
            if (record.session && !record.session.hasViewers()) {
              await workspace.suspend(record).catch(() => {});
            }
          }
        }
        // A per-session Chromium is expensive: once nobody is connected, suspend
        // the pages (their cookies/URLs are persisted) and stop the process.
        if (now - workspace.lastActiveAt > this.config.browserIdleMs) {
          for (const record of workspace.records.values()) {
            if (record.session) await workspace.suspend(record).catch(() => {});
          }
        }
        if (![...workspace.records.values()].some((record) => record.session)) {
          await this.releaseBrowser(workspace).catch(() => {});
        }
        if (now - workspace.lastActiveAt > 7 * 24 * 60 * 60 * 1000) {
          await this.releaseBrowser(workspace).catch(() => {});
          await workspace.dispose().catch(() => {});
          this.workspaces.delete(key);
        }
      }
      if (this.workspaces.size > this.config.maxSessions) {
        const idle = [...this.workspaces.values()]
          .filter((workspace) => workspace.clients.size === 0)
          .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
        for (const workspace of idle.slice(0, this.workspaces.size - this.config.maxSessions)) {
          await this.releaseBrowser(workspace).catch(() => {});
          await workspace.dispose().catch(() => {});
          this.workspaces.delete(workspace.key);
        }
      }
    } finally {
      this.cleaning = false;
    }
  }

  /** Snapshot for the activity panel: counts only, no expensive work. */
  stats() {
    const perSession = Boolean(this.perSessionAudio);
    return {
      sessions: this.workspaces.size,
      liveBrowsers: perSession ? this.browsers.size : this.shared.browser?.isConnected() ? 1 : 0,
      maxLiveBrowsers: perSession ? Math.max(1, this.config.maxLiveBrowsers) : 1,
      liveTabs: this.liveTabCount(),
      maxLiveTabs: this.maxLiveTabs,
      lightTabs: this.lightTabCount(),
      perSessionAudio: perSession,
    };
  }

  /** Frees Chromium processes (and their audio sinks) for sessions nobody is watching. */
  async reclaimIdle() {
    let released = 0;
    for (const workspace of this.workspaces.values()) {
      if (workspace.clients.size > 0) continue;
      const entry = this.browsers.get(workspace.key);
      if (!entry) continue;
      for (const record of workspace.records.values()) {
        if (record.session) await workspace.suspend(record).catch(() => {});
      }
      const hadBrowser = Boolean(entry.browser);
      await this.releaseBrowser(workspace).catch(() => {});
      if (hadBrowser) released += 1;
    }
    return released;
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.cleanupTimer);
    for (const workspace of this.workspaces.values()) {
      await workspace.dispose().catch(() => {});
    }
    this.workspaces.clear();
    for (const entry of this.browsers.values()) {
      if (entry.launching) await entry.launching.catch(() => {});
      if (entry.browser) await entry.browser.close().catch(() => {});
    }
    this.browsers.clear();
    if (this.shared.browser) {
      await this.shared.browser.close().catch(() => {});
      this.shared.browser = null;
    }
  }
}

class Workspace {
  constructor({ key, manager, config }) {
    this.key = key;
    this.manager = manager;
    this.config = config;
    this.slug = shortHash(key, 24);
    this.filePath = path.join(config.dataDir, 'workspaces', `${this.slug}.json`);
    this.storageDir = path.join(config.dataDir, 'storage');
    this.records = new Map();
    this.order = [];
    this.history = [];
    this.historyEnabled = true;
    this.clients = new Set();
    this.lastActiveAt = Date.now();
    this.activeRecordId = null;
    this.saveTimer = null;
    this.historyTimer = null;
    this.loaded = false;
    // Lightweight tabs share one cookie jar per visitor: no Chromium profile
    // exists for them, and two visitors must never share one.
    this.lightJar = new CookieJar();
  }

  /* ----------------------------------------------------------- persistence */

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      for (const tab of Array.isArray(data.tabs) ? data.tabs : []) {
        if (!tab || typeof tab.id !== 'string' || !TAB_ID_PATTERN.test(tab.id)) continue;
        if (this.records.has(tab.id)) continue;
        this.records.set(tab.id, {
          id: tab.id,
          url: typeof tab.url === 'string' && /^https?:/.test(tab.url) ? tab.url : null,
          title: typeof tab.title === 'string' && tab.title ? tab.title.slice(0, 300) : 'New Tab',
          favicon: typeof tab.favicon === 'string' && tab.favicon.startsWith('/api/favicon') ? tab.favicon : null,
          pinned: Boolean(tab.pinned),
          muted: Boolean(tab.muted),
          status: 'idle',
          loading: false,
          error: null,
          session: null,
          engine: tab.engine === 'light' ? 'light' : 'chromium',
          lightState: null,
          lightLoading: false,
          lightError: null,
          lightHistory: [],
          lightIndex: -1,
          createdAt: Number(tab.createdAt) || Date.now(),
          lastUsedAt: Number(tab.lastUsedAt) || Date.now(),
        });
        this.order.push(tab.id);
      }
      this.history = Array.isArray(data.history)
        ? data.history
            .filter((entry) => entry && typeof entry.url === 'string' && /^https?:/.test(entry.url))
            .slice(0, HISTORY_LIMIT)
        : [];
      this.historyEnabled = data.historyEnabled !== false;
      this.activeRecordId =
        typeof data.activeTabId === 'string' && this.records.has(data.activeTabId) ? data.activeTabId : null;
    } catch {
      /* fresh workspace */
    }
    this.loaded = true;
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch(() => {});
    }, 600);
    this.saveTimer.unref?.();
  }

  async flush() {
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      activeTabId: this.activeRecordId,
      tabs: [...this.records.values()].map((record) => ({
        id: record.id,
        url: record.url,
        title: record.title,
        favicon: record.favicon,
        pinned: record.pinned,
        muted: Boolean(record.muted),
        engine: record.engine || 'chromium',
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
      })),
      history: this.history.slice(0, HISTORY_LIMIT),
      historyEnabled: this.historyEnabled,
    };
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(payload), { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }

  storagePath(id) {
    return path.join(this.storageDir, `${id}.json`);
  }

  async readStorage(id) {
    try {
      const raw = await fs.readFile(this.storagePath(id), 'utf8');
      const state = JSON.parse(raw);
      if (state && Array.isArray(state.cookies)) return state;
    } catch {
      /* no stored session */
    }
    return undefined;
  }

  async captureStorage(session, id) {
    try {
      const state = await session.context.storageState();
      await fs.writeFile(this.storagePath(id), JSON.stringify(state), { mode: 0o600 });
    } catch {
      /* context already gone */
    }
  }

  touch() {
    this.lastActiveAt = Date.now();
  }

  /* --------------------------------------------------------------- clients */

  attachClient(client) {
    this.clients.add(client);
    this.touch();
  }

  detachClient(client) {
    this.clients.delete(client);
    for (const record of this.records.values()) {
      if (record.session) record.session.detach(client);
    }
    this.touch();
    this.flush().catch(() => {});
  }

  broadcast(message) {
    for (const client of this.clients) client.send(message);
  }

  broadcastHistory() {
    if (this.historyTimer) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      this.broadcast({ t: 'history', items: this.historySnapshot() });
    }, 900);
    this.historyTimer.unref?.();
  }

  /* ------------------------------------------------------------------- tabs */

  getRecord(id) {
    if (typeof id !== 'string') return null;
    return this.records.get(id) || null;
  }

  publicTab(record) {
    if (!record) return null;
    if (record.session && record.session.isLive()) {
      const snapshot = record.session.snapshot();
      return { ...snapshot, pinned: record.pinned, favicon: snapshot.favicon || record.favicon, engine: 'chromium' };
    }
    const engine = record.engine || 'chromium';
    return {
      id: record.id,
      url: record.url,
      host: hostOf(record.url),
      title: record.title || 'New Tab',
      favicon: record.favicon,
      pinned: record.pinned,
      live: engine === 'light' ? Boolean(record.lightState) : false,
      loading: engine === 'light' ? Boolean(record.lightLoading) : false,
      canGoBack: engine === 'light' ? record.lightIndex > 0 : false,
      canGoForward: engine === 'light' ? record.lightIndex < (record.lightHistory?.length || 0) - 1 : false,
      secure: typeof record.url === 'string' && record.url.startsWith('https://'),
      muted: Boolean(record.muted),
      audible: false,
      status: record.status || 'idle',
      error: record.status === 'error' ? record.error : null,
      dialog: null,
      engine,
      light: this.lightSummary(record),
    };
  }

  /** What the viewer needs to know about a light tab without the page body. */
  lightSummary(record) {
    if ((record.engine || 'chromium') !== 'light') return null;
    return {
      loading: Boolean(record.lightLoading),
      error: record.lightError || null,
      ready: Boolean(record.lightState),
      requiresChromium: Boolean(record.lightState?.hints?.requiresChromium),
      reason: record.lightState?.hints?.reason || null,
      words: record.lightState?.words || 0,
    };
  }

  list() {
    return this.order.map((id) => this.publicTab(this.records.get(id))).filter(Boolean);
  }

  async createTab({ url = null, title = null, pinned = false, id = null, engine = 'chromium' } = {}) {
    if (this.order.length >= this.config.maxTabs) {
      throw new HttpError(400, `Tab limit reached (${this.config.maxTabs}). Close a tab first.`);
    }
    let target = null;
    if (url) target = await assertPublicHttpUrl(url);
    const tabId = id && TAB_ID_PATTERN.test(id) ? id : randomId(8);
    const record = {
      id: tabId,
      url: target?.href || null,
      title: title || 'New Tab',
      favicon: null,
      pinned: Boolean(pinned),
      muted: false,
      status: 'idle',
      loading: false,
      error: null,
      session: null,
      engine: engine === 'light' ? 'light' : 'chromium',
      lightState: null,
      lightLoading: false,
      lightError: null,
      lightHistory: [],
      lightIndex: -1,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.records.set(tabId, record);
    this.order.push(tabId);
    this.touch();
    this.broadcast({ t: 'tab', tab: this.publicTab(record) });
    this.save();
    return record;
  }

  async ensureLive(record, { viewport, restore = true } = {}) {
    if (record.session && record.session.isLive()) return record.session;
    record.session = null;
    await this.manager.enforceLiveLimit(this);
    const storageState = await this.readStorage(record.id);
    const context = await this.manager.createContext(this, { storageState });
    const page = await context.newPage();
    this.manager.pageOwners.set(page, record.id);
    await this.manager.applyFingerprint(page);
    const session = new TabSession({
      id: record.id,
      workspace: this,
      context,
      page,
      config: this.config,
      meta: record,
    });
    record.session = session;
    this.wire(record, session);
    if (viewport) await session.setViewport(viewport.width, viewport.height, { force: true });
    await session.init();
    await session
      .setMuted(Boolean(record.muted) || record.id !== this.activeRecordId, { quiet: true })
      .catch(() => {});
    this.broadcast({ t: 'tab', tab: this.publicTab(record) });
    if (restore && record.url) {
      session.navigate(record.url).catch((error) => log.debug('restore navigation failed', error.message));
    }
    return session;
  }

  async adopt(page) {
    if (this.order.length >= this.config.maxTabs) {
      await page.close().catch(() => {});
      return;
    }
    const id = randomId(8);
    const initialUrl = /^https?:/.test(page.url()) ? page.url() : null;
    const record = {
      id,
      url: initialUrl,
      title: 'New Tab',
      favicon: null,
      pinned: false,
      status: 'idle',
      loading: false,
      error: null,
      session: null,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.records.set(id, record);
    this.order.push(id);
    this.manager.pageOwners.set(page, id);
    const session = new TabSession({
      id,
      workspace: this,
      context: page.context(),
      page,
      config: this.config,
      meta: record,
    });
    record.session = session;
    this.wire(record, session);
    try {
      await session.init();
    } catch (error) {
      log.warn('popup init failed', error.message);
    }
    this.broadcast({ t: 'tab', tab: this.publicTab(record) });
    this.save();
  }

  wire(record, session) {
    session.on('state', (state) => {
      record.url = state.url;
      record.title = state.title || record.title;
      record.favicon = state.favicon || record.favicon;
      record.status = state.status;
      record.loading = state.loading;
      record.error = state.error;
      record.pinned = state.pinned;
      record.lastUsedAt = Date.now();
      this.broadcast({ t: 'tab', tab: this.publicTab(record) });
      this.save();
    });
    session.on('visited', (visit) => this.addHistory(visit));
    session.on('dialog', (dialog) => this.broadcast({ t: 'dialog', dialog }));
    session.on('fullscreen', (on) => this.broadcast({ t: 'fullscreen', tabId: record.id, on }));
    session.on('closed', () => {
      // Every close the app performs (tab close, idle suspend, shutdown) clears
      // record.session first, so reaching here means the page went away on its
      // own: a browser crash, an OOM kill or a tab crash. Keep the record and its
      // URL so the viewer can reload instead of silently losing the tab.
      if (record.session !== session) return;
      record.session = null;
      this.manager.pageOwners.delete(session.page);
      record.status = 'error';
      record.error = 'This tab closed unexpectedly. Reload to reopen this page.';
      this.broadcast({ t: 'tab', tab: this.publicTab(record) });
      this.save();
    });
  }

  async activate(client, id, viewport) {
    const record = this.getRecord(id);
    if (!record) throw new HttpError(404, 'That tab no longer exists');
    this.activeRecordId = id;
    record.lastUsedAt = Date.now();
    this.touch();
    this.applyAudioPolicy(id);

    const previous = client.tabId && client.tabId !== id ? this.records.get(client.tabId) : null;
    if (previous?.session) previous.session.detach(client);

    client.tabId = id;
    if ((record.engine || 'chromium') === 'light') {
      const tab = this.publicTab(record);
      client.send({
        t: 'tab:active',
        id,
        tab,
        engine: 'light',
        viewport: { width: viewport?.width || 1280, height: viewport?.height || 800 },
      });
      if (record.lightState) client.send({ t: 'light', tabId: id, page: record.lightState });
      else if (record.lightError) this.sendLightState(record);
      else if (record.url && !record.lightLoading) this.loadLight(record, record.url, { push: false }).catch(() => {});
      return tab;
    }
    if (!record.url && !record.session) {
      client.send({
        t: 'tab:active',
        id,
        tab: this.publicTab(record),
        viewport: { width: viewport?.width || 1280, height: viewport?.height || 800 },
      });
      return this.publicTab(record);
    }

    if (record.session?.isLive() && viewport) {
      await record.session.setViewport(viewport.width, viewport.height).catch(() => {});
    }
    const session = await this.ensureLive(record, { viewport });
    session.attach(client);
    this.applyAudioPolicy(id);
    client.send({
      t: 'tab:active',
      id,
      tab: this.publicTab(record),
      viewport: { width: session.viewport.width, height: session.viewport.height },
    });
    return this.publicTab(record);
  }

  /* ----------------------------------------------------- lightweight engine */

  sendLight(record, page, client = null) {
    const message = { t: 'light', tabId: record.id, page };
    if (client) client.send(message);
    else this.broadcast(message);
  }

  sendLightState(record) {
    this.broadcast({
      t: 'light:state',
      tabId: record.id,
      ...this.lightSummary(record),
    });
  }

  pushLightHistory(record, url) {
    const stack = Array.isArray(record.lightHistory) ? record.lightHistory : [];
    const kept = stack.slice(0, Math.max(0, record.lightIndex + 1));
    if (kept[kept.length - 1] !== url) kept.push(url);
    record.lightHistory = kept.slice(-100);
    record.lightIndex = record.lightHistory.length - 1;
  }

  /**
   * Fetches and renders a page without a browser. Failures stay in the tab as an
   * error state, so a slow host never looks like a dead tab.
   */
  async loadLight(record, url, { push = true, force = false, client = null } = {}) {
    const engine = this.manager?.light;
    if (!engine) throw new HttpError(503, 'The lightweight engine is not available');
    record.engine = 'light';
    record.lightLoading = true;
    record.lightError = null;
    record.loading = true;
    record.status = 'loading';
    record.error = null;
    this.broadcast({ t: 'tab', tab: this.publicTab(record) });
    this.sendLightState(record);
    try {
      const page = await engine.load(url, { jar: this.lightJar, force });
      record.lightState = page;
      record.lightLoading = false;
      record.loading = false;
      record.status = 'idle';
      record.url = page.url;
      record.title = page.title || record.title;
      const host = hostOf(page.url);
      record.favicon = host ? `/api/favicon?host=${encodeURIComponent(host)}` : null;
      record.lastUsedAt = Date.now();
      if (push) this.pushLightHistory(record, page.url);
      this.addHistory({ url: page.url, title: page.title });
      this.broadcast({ t: 'tab', tab: this.publicTab(record) });
      this.sendLight(record, page, client);
      this.sendLightState(record);
      this.save();
      return page;
    } catch (error) {
      record.lightLoading = false;
      record.loading = false;
      record.status = 'error';
      record.error = error?.message || 'This page could not be loaded';
      record.lightError = record.error;
      this.broadcast({ t: 'tab', tab: this.publicTab(record) });
      this.sendLightState(record);
      this.save();
      return null;
    }
  }

  async lightBack(record) {
    const stack = record.lightHistory || [];
    if (record.lightIndex <= 0) return null;
    record.lightIndex -= 1;
    return this.loadLight(record, stack[record.lightIndex], { push: false });
  }

  async lightForward(record) {
    const stack = record.lightHistory || [];
    if (record.lightIndex >= stack.length - 1) return null;
    record.lightIndex += 1;
    return this.loadLight(record, stack[record.lightIndex], { push: false });
  }

  /**
   * Switches one tab between engines. The destination URL, the tab id and the
   * tab's place in the strip are all preserved: only how the page is produced
   * changes, so nothing about the visitor's session is lost.
   */
  async setEngine(record, engine, { viewport, client = null } = {}) {
    const next = engine === 'light' ? 'light' : 'chromium';
    if ((record.engine || 'chromium') === next) {
      if (next === 'light' && record.lightState) this.sendLight(record, record.lightState, client);
      return this.publicTab(record);
    }
    record.engine = next;
    if (next === 'light') {
      if (record.session) await this.suspend(record).catch(() => {});
      record.lightError = null;
      this.broadcast({ t: 'tab', tab: this.publicTab(record) });
      if (record.url) await this.loadLight(record, record.url, { push: false, client });
      else this.sendLightState(record);
      this.save();
      return this.publicTab(record);
    }
    record.lightState = null;
    record.lightError = null;
    record.lightLoading = false;
    this.broadcast({ t: 'tab', tab: this.publicTab(record) });
    if (record.url) {
      const session = await this.ensureLive(record, { viewport, restore: false });
      if (client) session.attach(client);
      await session.navigate(record.url);
    }
    this.save();
    return this.publicTab(record);
  }

  async closeTab(id, { deleteStorage = true } = {}) {
    const record = this.getRecord(id);
    if (!record) return false;
    const session = record.session;
    record.session = null;
    this.manager.pageOwners.delete(session?.page);
    this.records.delete(id);
    this.order = this.order.filter((value) => value !== id);
    for (const client of this.clients) {
      if (client.tabId === id) client.tabId = null;
    }
    if (session) await session.close().catch(() => {});
    if (deleteStorage) await fs.rm(this.storagePath(id), { force: true }).catch(() => {});
    if (this.activeRecordId === id) {
      this.activeRecordId = this.order[0] || null;
      this.applyAudioPolicy(this.activeRecordId);
    }
    this.broadcast({ t: 'tab:closed', id });
    this.save();
    return true;
  }

  removeRecord(record, { deleteStorage = false } = {}) {
    this.records.delete(record.id);
    this.order = this.order.filter((value) => value !== record.id);
    for (const client of this.clients) {
      if (client.tabId === record.id) client.tabId = null;
    }
    if (deleteStorage) fs.rm(this.storagePath(record.id), { force: true }).catch(() => {});
    this.broadcast({ t: 'tab:closed', id: record.id });
    this.save();
  }

  /** Mutes every tab except the active one, and honours the per-tab mute flag. */
  applyAudioPolicy(activeId) {
    for (const record of this.records.values()) {
      if (!record.session?.isLive()) continue;
      const shouldMute = Boolean(record.muted) || record.id !== activeId;
      if (record.session.muted !== shouldMute) {
        record.session.setMuted(shouldMute, { quiet: true }).catch(() => {});
      }
    }
  }

  setTabMuted(id, muted) {
    const record = this.getRecord(id);
    if (!record) throw new HttpError(404, 'That tab no longer exists');
    record.muted = Boolean(muted);
    if (record.session?.isLive()) {
      const shouldMute = record.muted || record.id !== this.activeRecordId;
      record.session.setMuted(shouldMute).catch(() => {});
    }
    this.broadcast({ t: 'tab', tab: this.publicTab(record) });
    this.save();
    return this.publicTab(record);
  }

  setPinned(id, pinned) {
    const record = this.getRecord(id);
    if (!record) throw new HttpError(404, 'That tab no longer exists');
    record.pinned = Boolean(pinned);
    if (record.session) record.session.pinned = record.pinned;
    this.broadcast({ t: 'tab', tab: this.publicTab(record) });
    this.save();
    return this.publicTab(record);
  }

  async suspend(record) {
    const session = record.session;
    if (!session) return;
    record.session = null;
    this.manager.pageOwners.delete(session.page);
    await this.captureStorage(session, record.id);
    await session.close().catch(() => {});
    this.broadcast({ t: 'tab', tab: this.publicTab(record) });
    this.save();
  }

  /**
   * A crashed or killed Chromium leaves every tab without a page. Silently
   * dropping to `idle` showed the viewer an empty canvas with no way back; the
   * tab now reports an error that offers Reload, which reopens the URL.
   */
  handleBrowserDisconnect() {
    log.warn('session browser disconnected - tabs will reopen on demand (check free memory)');
    for (const record of this.records.values()) {
      if (!record.session) continue;
      record.session = null;
      record.status = 'error';
      record.error = 'The server browser closed unexpectedly. Reload to reopen this page.';
      this.broadcast({ t: 'tab', tab: this.publicTab(record) });
    }
  }

  async dispose() {
    for (const record of this.records.values()) {
      if (record.session) {
        await this.suspend(record).catch(() => {});
      }
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.flush().catch(() => {});
  }

  /* ---------------------------------------------------------------- history */

  addHistory({ url, title }) {
    if (!this.historyEnabled) return;
    if (!url || !/^https?:/.test(url)) return;
    const host = hostOf(url);
    if (!host) return;
    const existing = this.history.find((entry) => entry.url === url);
    if (existing) {
      existing.visits = (existing.visits || 1) + 1;
      existing.ts = Date.now();
      if (title) existing.title = title;
    } else {
      this.history.unshift({ url, title: title || host, host, ts: Date.now(), visits: 1 });
      this.history = this.history.slice(0, HISTORY_LIMIT);
    }
    this.save();
    this.broadcastHistory();
  }

  historySnapshot() {
    return this.history.slice(0, 80).map((entry) => ({
      url: entry.url,
      title: entry.title || entry.host,
      host: entry.host,
      ts: entry.ts,
      visits: entry.visits || 1,
    }));
  }

  clearHistory() {
    this.history = [];
    this.save();
    this.broadcast({ t: 'history', items: [], enabled: this.historyEnabled });
  }

  /** Removes one visited URL; returns whether anything changed. */
  removeHistory(url) {
    const before = this.history.length;
    this.history = this.history.filter((entry) => entry.url !== url);
    if (this.history.length === before) return false;
    this.save();
    this.broadcast({ t: 'history', items: this.historySnapshot(), enabled: this.historyEnabled });
    return true;
  }

  setHistoryEnabled(enabled) {
    this.historyEnabled = Boolean(enabled);
    this.save();
    this.broadcast({ t: 'history', items: this.historySnapshot(), enabled: this.historyEnabled });
    return this.historyEnabled;
  }
}
