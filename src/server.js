import http from 'node:http';
import path from 'node:path';
import compression from 'compression';
import express from 'express';
import { AudioService } from './audio/service.js';
import { AuthService } from './auth.js';
import { WorkspaceManager } from './browser/workspaces.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { log } from './logger.js';
import { RateLimiter, clientIp } from './security/rate-limit.js';
import { isBlockedHostname } from './security/ip-guard.js';
import { ENGINES, getSuggestions } from './search.js';
import { attachWebSocketServer } from './ws/handler.js';
import { delay } from './util.js';

const auth = new AuthService();
const limiter = new RateLimiter();
const manager = new WorkspaceManager(config);
const audio = new AudioService(config);
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

const publicDir = path.join(config.rootDir, 'public');
const wsOrigin = config.publicOrigin
  ? config.publicOrigin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  : '';

// "none" disables embedding; anything else is passed straight into the CSP.
const frameAncestors =
  config.frameAncestors === 'none' || config.frameAncestors === "'none'" ? "'none'" : config.frameAncestors;
const embeddable = frameAncestors !== "'none'";

/** Cross-site frames need SameSite=None, which browsers only accept with Secure. */
const sessionCookieOptions = (req) => {
  const secure = AuthService.isSecureRequest(req);
  return {
    secure,
    crossSite: embeddable && secure,
    partitioned: config.embedPartitionedCookies,
  };
};

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  `frame-ancestors ${frameAncestors}`,
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  `connect-src 'self' ${wsOrigin || 'ws: wss:'}`.trim(),
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', contentSecurityPolicy);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // X-Frame-Options would override frame-ancestors, so only send it when
  // embedding is explicitly disabled.
  if (!embeddable) res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), autoplay=*, fullscreen=*',
  );
  if (AuthService.isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(compression());
app.use(express.json({ limit: '8kb' }));
app.use(auth.middleware());

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.path === '/login' || req.path === '/info') return next();
  if (!req.auth) return res.status(401).json({ error: 'Sign in to continue', code: 'unauthorized' });
  const ip = clientIp(req);
  if (!limiter.consume(`api:${ip}`, config.rateLimitPerMinute, 60_000)) {
    return res.status(429).json({ error: 'Too many requests. Slow down a little.', code: 'rate_limited' });
  }
  return next();
});

/* --------------------------------------------------------------------- auth */

app.post('/api/login', async (req, res) => {
  if (!AuthService.isSameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request rejected' });
  const ip = clientIp(req);
  if (!limiter.consume(`login:${ip}`, 10, 5 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  if (config.authMode === 'none') {
    if (!config.allowNoAuth) return res.status(403).json({ error: 'Password sign-in is disabled' });
    return res.json({ ok: true });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!auth.checkPassword(password)) {
    await delay(400);
    log.warn('failed login', ip);
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const { token } = auth.issue();
  res.setHeader('Set-Cookie', auth.cookie(token, sessionCookieOptions(req)));
  return res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (!AuthService.isSameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request rejected' });
  auth.revoke(req.auth);
  res.setHeader('Set-Cookie', auth.clearCookie(sessionCookieOptions(req)));
  res.json({ ok: true });
});

app.get('/api/info', (req, res) => {
  res.json({
    name: config.appName,
    version: config.version,
    authMode: config.authMode && config.allowNoAuth ? 'none' : config.authMode,
    passwordConfigured: Boolean(config.accessPassword),
  });
});

/* ------------------------------------------------------------------ session */

app.get('/api/session', async (req, res, next) => {
  try {
    const workspace = await manager.getWorkspace(req.workspaceKey);
    workspace.touch();
    res.json({
      ok: true,
      version: config.version,
      tabs: workspace.list(),
      activeTabId: workspace.activeRecordId,
      audio: audio.info(),
      history: workspace.historySnapshot(),
      limits: { maxTabs: config.maxTabs, frameQuality: config.frameQuality },
      engines: Object.entries(ENGINES).map(([id, engine]) => ({ id, name: engine.name, search: engine.search })),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/audio', (req, res) => {
  res.json({ ok: true, ...audio.info() });
});

app.get('/api/history', async (req, res, next) => {
  try {
    const workspace = await manager.getWorkspace(req.workspaceKey);
    res.json({ items: workspace.historySnapshot() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/history', async (req, res, next) => {
  try {
    if (!AuthService.isSameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request rejected' });
    const workspace = await manager.getWorkspace(req.workspaceKey);
    workspace.clearHistory();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/suggest', async (req, res, next) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
    const engine = typeof req.query.engine === 'string' ? req.query.engine : 'google';
    if (!query.trim()) return res.json({ items: [] });
    if (!limiter.consume(`suggest:${clientIp(req)}`, 120, 60_000)) return res.json({ items: [] });
    const items = await getSuggestions(query, engine);
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

/* ----------------------------------------------------------------- favicons */

const faviconInFlight = new Map();

app.get('/api/favicon', async (req, res, next) => {
  try {
    const host = typeof req.query.host === 'string' ? req.query.host.toLowerCase() : '';
    if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || isBlockedHostname(host)) {
      return res.status(400).json({ error: 'Invalid host' });
    }
    let icon = await manager.favicons.get(host);
    if (!icon) {
      if (!faviconInFlight.has(host)) {
        faviconInFlight.set(
          host,
          manager.favicons
            .fetchDirect(host)
            .catch(() => null)
            .finally(() => faviconInFlight.delete(host)),
        );
      }
      icon = await faviconInFlight.get(host);
    }
    if (!icon) return res.status(404).json({ error: 'No favicon' });
    res.setHeader('Content-Type', icon.type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.send(icon.buffer);
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------- health */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    browser: manager.browser?.isConnected() ? 'ready' : 'starting',
    sandbox: manager.sandboxDisabled ? 'disabled' : 'enabled',
    audio: audio.info().status,
    version: config.version,
  });
});

/* ------------------------------------------------------------ legacy routes */

// Tab ids used to live in the path. Redirect those links to the canonical root
// so the browser's address bar only ever shows the proxy origin.
app.get(['/b/*', '/browser/*', '/tab/*'], (req, res) => res.redirect(302, '/'));

/* ------------------------------------------------------------------- static */

app.use(
  express.static(publicDir, {
    index: false,
    maxAge: 0,
    etag: true,
    setHeaders: (res, filePath) => {
      // Always revalidate the shell and ES modules so an update is never
      // served from a stale browser cache. ETags keep this cheap (304).
      if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  log.error('request failed', error?.stack || error?.message || error);
  return res.status(500).json({ error: 'Internal server error' });
});

/* -------------------------------------------------------------------- start */

const server = http.createServer(app);
const wss = attachWebSocketServer(server, { auth, manager, limiter, audio });

const shutdown = async (signal) => {
  log.info(`${signal} received, shutting down`);
  server.close();
  wss.close();
  audio.stop();
  limiter.stop();
  await manager.stop().catch(() => {});
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason));
process.on('uncaughtException', (error) => log.error('uncaught exception', error?.stack || error));

const banner = () => {
  const origin = config.publicOrigin || `http://${config.host}:${config.port}`;
  log.info(`${config.appName} v${config.version} listening on ${origin}`);
  log.info(`Browser engine: ${manager.browser?.version() || 'unknown'} (${config.browserMode})`);
  if (config.authMode === 'none') {
    log.warn('AUTH_MODE=none - anyone who can reach this port can use the proxy');
  } else if (config.generatedPassword) {
    log.warn('No ACCESS_PASSWORD was configured. A random password was generated:');
    log.warn(`    ${config.accessPassword}`);
    log.warn(`    stored in ${path.join(config.dataDir, 'access-password.txt')}`);
  }
};

if (config.authMode === 'none' && !config.allowNoAuth) {
  log.error('AUTH_MODE=none requires ALLOW_NO_AUTH=1. Refusing to start an unauthenticated proxy.');
  process.exit(1);
}

await manager.start();
server.listen(config.port, config.host, banner);
