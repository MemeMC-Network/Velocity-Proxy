import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { TabSession } from './tab.js';
import { FaviconCache } from './favicon.js';
import { HttpError } from '../errors.js';
import { log } from '../logger.js';
import { assertPublicHttpUrl, isBlockedUrl } from '../security/ip-guard.js';
import { hostOf, randomId, shortHash } from '../util.js';

const STEALTH_SCRIPT = `
Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined });
if (!window.chrome) { Object.defineProperty(window, 'chrome', { value: { runtime: {} }, writable: true }); }
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
try {
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
} catch (error) {}
`;

const TAB_ID_PATTERN = /^[a-f0-9]{8,40}$/;
const HISTORY_LIMIT = 200;

export class WorkspaceManager {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.launching = null;
    this.workspaces = new Map();
    this.pending = new Map();
    this.pageOwners = new Map();
    this.contextOwners = new WeakMap();
    this.favicons = new FaviconCache(path.join(config.dataDir, 'favicons'));
    this.cleanupTimer = null;
    this.cleaning = false;
    this.stopping = false;
    this.sandboxDisabled = false;
    this.maxLiveTabs = Math.max(8, Math.min(64, Math.ceil(config.maxSessions * 1.5)));
  }

  async start() {
    await this.ensureBrowser();
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch((error) => log.debug('cleanup failed', error.message));
    }, 60_000);
    this.cleanupTimer.unref?.();
  }

  async ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.stopping) throw new Error('Proxy is shutting down');
    if (this.launching) return this.launching;
    this.launching = this.launchBrowser()
      .then((browser) => {
        this.browser = browser;
        browser.on('disconnected', () => {
          if (this.stopping) return;
          log.warn('Chromium disconnected - sessions will be recreated on demand');
          this.browser = null;
          for (const workspace of this.workspaces.values()) workspace.handleBrowserDisconnect();
        });
        return browser;
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  async launchBrowser() {
    const headless = this.config.browserMode === 'headless';
    const args = [
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--font-render-hinting=none',
      '--lang=en-US',
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
        ...(this.config.audioPulseSink ? { PULSE_SINK: this.config.audioPulseSink } : {}),
      },
    };

    const sandboxPreference = this.config.chromiumSandbox;
    const wantSandbox = sandboxPreference === 'on' || (sandboxPreference === 'auto' && !this.config.isRoot);

    const attempt = async (sandbox) => {
      const browser = await chromium.launch({ ...base, chromiumSandbox: sandbox });
      log.info(`Chromium launched (${headless ? 'headless' : 'headed'}, sandbox ${sandbox ? 'on' : 'off'}, version ${browser.version()})`);
      if (!sandbox) this.sandboxDisabled = true;
      return browser;
    };

    try {
      return await attempt(wantSandbox);
    } catch (error) {
      if (!wantSandbox) throw error;
      log.warn('Chromium sandbox unavailable, retrying without it:', String(error.message).split('\n')[0]);
      return attempt(false);
    }
  }

  async createContext(workspace, { storageState } = {}) {
    const browser = await this.ensureBrowser();
    const viewport = { width: 1280, height: 800 };
    const context = await browser.newContext({
      viewport,
      screen: viewport,
      deviceScaleFactor: 1,
      locale: 'en-US',
      colorScheme: 'light',
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      serviceWorkers: 'allow',
      userAgent: this.config.userAgent || undefined,
      storageState: storageState || undefined,
    });
    context.setDefaultTimeout(20_000);
    context.setDefaultNavigationTimeout(this.config.navTimeoutMs);
    this.contextOwners.set(context, workspace);
    await context.addInitScript(STEALTH_SCRIPT).catch(() => {});
    await context.grantPermissions([]).catch(() => {});

    if (this.config.ssrfGuard === 'routes') {
      await context.route('**/*', async (route) => {
        try {
          if (await isBlockedUrl(route.request().url())) {
            await route.abort('blockedbyclient');
            return;
          }
        } catch {
          /* validation failure: fall through to continue */
        }
        await route.continue().catch(() => {});
      });
    }

    try {
      await context.routeWebSocket('**/*', async (ws) => {
        try {
          if (await isBlockedUrl(ws.url())) {
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

  async enforceLiveLimit(workspace) {
    if (this.liveTabCount() < this.maxLiveTabs) return;
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
        if (now - workspace.lastActiveAt > 7 * 24 * 60 * 60 * 1000) {
          await workspace.dispose().catch(() => {});
          this.workspaces.delete(key);
        }
      }
      if (this.workspaces.size > this.config.maxSessions) {
        const idle = [...this.workspaces.values()]
          .filter((workspace) => workspace.clients.size === 0)
          .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
        for (const workspace of idle.slice(0, this.workspaces.size - this.config.maxSessions)) {
          await workspace.dispose().catch(() => {});
          this.workspaces.delete(workspace.key);
        }
      }
    } finally {
      this.cleaning = false;
    }
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.cleanupTimer);
    for (const workspace of this.workspaces.values()) {
      await workspace.dispose().catch(() => {});
    }
    this.workspaces.clear();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
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
    this.clients = new Set();
    this.lastActiveAt = Date.now();
    this.activeRecordId = null;
    this.saveTimer = null;
    this.historyTimer = null;
    this.loaded = false;
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
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
      })),
      history: this.history.slice(0, HISTORY_LIMIT),
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
      return { ...snapshot, pinned: record.pinned, favicon: snapshot.favicon || record.favicon };
    }
    return {
      id: record.id,
      url: record.url,
      host: hostOf(record.url),
      title: record.title || 'New Tab',
      favicon: record.favicon,
      pinned: record.pinned,
      live: false,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      secure: typeof record.url === 'string' && record.url.startsWith('https://'),
      muted: Boolean(record.muted),
      audible: false,
      status: record.status || 'idle',
      error: record.status === 'error' ? record.error : null,
      dialog: null,
    };
  }

  list() {
    return this.order.map((id) => this.publicTab(this.records.get(id))).filter(Boolean);
  }

  async createTab({ url = null, title = null, pinned = false, id = null } = {}) {
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
    session.on('closed', (reason) => {
      if (record.session !== session) return;
      record.session = null;
      this.manager.pageOwners.delete(session.page);
      if (reason === 'page-closed') {
        this.removeRecord(record, { deleteStorage: false });
      } else {
        this.broadcast({ t: 'tab', tab: this.publicTab(record) });
      }
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

  handleBrowserDisconnect() {
    for (const record of this.records.values()) {
      if (!record.session) continue;
      record.session = null;
      record.status = 'idle';
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
    this.broadcast({ t: 'history', items: [] });
  }
}
