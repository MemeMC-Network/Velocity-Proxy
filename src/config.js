import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const text = (value, fallback = '') =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

const integer = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const boolean = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};

const dataDir = path.resolve(rootDir, text(process.env.DATA_DIR, '.data'));
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'workspaces'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'storage'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'favicons'), { recursive: true });

const readOrCreateSecret = (fileName, bytes = 32) => {
  const file = path.join(dataDir, fileName);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* create below */
  }
  const secret = crypto.randomBytes(bytes).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
};

const authMode = text(process.env.AUTH_MODE, 'password').toLowerCase() === 'none' ? 'none' : 'password';
const allowNoAuth = boolean(process.env.ALLOW_NO_AUTH, false);

let accessPassword = text(process.env.ACCESS_PASSWORD);
let generatedPassword = false;
if (authMode === 'password' && !accessPassword) {
  accessPassword = readOrCreateSecret('access-password.txt', 9);
  generatedPassword = true;
}

export const config = Object.freeze({
  rootDir,
  dataDir,
  appName: 'Velocity Proxy',
  version: '1.0.0',

  host: text(process.env.HOST, '127.0.0.1'),
  port: integer(process.env.PORT, 8080, 1, 65535),
  publicOrigin: text(process.env.PUBLIC_ORIGIN).replace(/\/+$/, ''),
  trustProxy: integer(process.env.TRUST_PROXY, 1, 0, 5),

  authMode,
  allowNoAuth,
  accessPassword,
  generatedPassword,
  sessionSecret: text(process.env.SESSION_SECRET) || readOrCreateSecret('session-secret.txt', 48),
  sessionTtlMs: integer(process.env.SESSION_TTL_DAYS, 30, 1, 365) * 24 * 60 * 60 * 1000,

  maxTabs: integer(process.env.MAX_TABS, 12, 1, 40),
  maxSessions: integer(process.env.MAX_SESSIONS, 40, 1, 500),
  tabIdleMs: integer(process.env.TAB_IDLE_MINUTES, 10, 1, 720) * 60 * 1000,
  navTimeoutMs: integer(process.env.NAV_TIMEOUT_MS, 45000, 5000, 180000),
  frameQuality: integer(process.env.FRAME_QUALITY, 62, 20, 90),
  viewportMaxWidth: integer(process.env.VIEWPORT_MAX_WIDTH, 1920, 640, 2560),
  viewportMaxHeight: integer(process.env.VIEWPORT_MAX_HEIGHT, 1200, 480, 1600),

  audioEnabled: boolean(process.env.AUDIO_ENABLED, true),
  audioSource: text(process.env.AUDIO_SOURCE, 'auto').toLowerCase(),
  audioDevice: text(process.env.AUDIO_DEVICE),
  audioFfmpegPath: text(process.env.AUDIO_FFMPEG_PATH, 'ffmpeg'),
  audioBitrateKbps: integer(process.env.AUDIO_BITRATE_KBPS, 64, 24, 160),
  audioPulseServer: text(process.env.AUDIO_PULSE_SERVER),
  audioPulseSink: text(process.env.AUDIO_PULSE_SINK),

  chromiumPath: text(process.env.CHROMIUM_PATH),
  browserMode: text(process.env.BROWSER_MODE, 'headless').toLowerCase() === 'headed' ? 'headed' : 'headless',
  chromiumSandbox: text(process.env.CHROMIUM_SANDBOX, 'auto').toLowerCase(),
  chromiumArgs: text(process.env.CHROMIUM_ARGS).split(/\s+/).filter(Boolean),
  userAgent: text(process.env.USER_AGENT),

  // CSP frame-ancestors. "*" allows embedding on any site; "'none'" (or "none")
  // blocks framing entirely.
  frameAncestors: text(process.env.FRAME_ANCESTORS, '*').replace(/[;\r\n]/g, ' ').trim() || '*',
  // CHIPS: give every embedding site its own session cookie partition. Needed
  // only when the browser blocks unpartitioned third-party cookies.
  embedPartitionedCookies: boolean(process.env.EMBED_PARTITIONED_COOKIES, false),

  ssrfGuard: text(process.env.SSRF_GUARD, 'routes').toLowerCase() === 'nav' ? 'nav' : 'routes',
  allowPrivateTargets: boolean(process.env.ALLOW_PRIVATE_TARGETS, false),
  rateLimitPerMinute: integer(process.env.RATE_LIMIT_PER_MINUTE, 240, 20, 10000),

  logLevel: text(process.env.LOG_LEVEL, 'info').toLowerCase(),
  isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
  isProduction: process.env.NODE_ENV === 'production',
});
