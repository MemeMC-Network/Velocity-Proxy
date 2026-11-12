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

// Comma or whitespace separated list, lowercased and de-duplicated.
const list = (value) => [
  ...new Set(
    String(value ?? '')
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  ),
];

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

const sessionLimit = integer(process.env.MAX_SESSIONS, 40, 1, 500);

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
  maxSessions: sessionLimit,
  tabIdleMs: integer(process.env.TAB_IDLE_MINUTES, 10, 1, 720) * 60 * 1000,
  // Nothing is watching a closed tab's browser, so free it much sooner than a
  // tab's page: this is where most of the RAM goes.
  browserIdleMs: integer(process.env.BROWSER_IDLE_SECONDS, 180, 15, 3600) * 1000,
  // A background tab still holds a renderer (~60 MB each here). Suspending it
  // keeps the tab, its URL and its cookies, and reopens the page on the next
  // activation, so this is the one lever that returns memory per tab rather
  // than just freeing idle browsers. 0 disables the sweep.
  tabSuspendMs: integer(process.env.TAB_SUSPEND_SECONDS, 600, 0, 86400) * 1000,
  // Concurrent Chromium processes are capped; only idle sessions are evicted.
  maxLiveBrowsers: integer(process.env.MAX_LIVE_BROWSERS, Math.max(2, Math.min(6, sessionLimit)), 1, 32),
  // Hard cap on simultaneously open pages, which is what bounds peak memory.
  maxLiveTabs: integer(
    process.env.MAX_LIVE_TABS,
    Math.max(4, Math.min(16, sessionLimit)),
    1,
    64,
  ),
  // Streaming: byte budget, frame rate and the poll cadence used while nobody
  // is watching.
  screencastFps: integer(process.env.SCREENCAST_FPS, 30, 5, 60),
  idlePollMs: integer(process.env.IDLE_POLL_MS, 5000, 1000, 60000),
  navTimeoutMs: integer(process.env.NAV_TIMEOUT_MS, 45000, 5000, 180000),
  frameQuality: integer(process.env.FRAME_QUALITY, 62, 20, 90),
  // What the stream is allowed to spend on the wire. Thirty 100 KB frames a
  // second is 24 Mbps, which saturates a small VPS uplink and arrives as bursts
  // rather than smooth video. Quality drops first, then frame rate, then capture
  // resolution, to stay under this. 6000 kbps (750 KB/s) is the ceiling because
  // every byte above it is another JPEG encode on a CPU that has none to spare: a
  // playing video tab was measured at 795 KB/s, so the budget also bounds the
  // encoder instead of letting one tab eat a whole core.
  streamMaxKbps: integer(process.env.STREAM_MAX_KBPS, 6000, 1000, 50000),
  // Lightweight engine: the page is fetched server-side, reduced to readable
  // blocks and rendered by the viewer, so it costs no Chromium, no frame
  // encoding and no per-tab browser memory.
  lightEngine: boolean(process.env.LIGHT_ENGINE, true),
  lightMaxBytes: integer(process.env.LIGHT_MAX_BYTES, 2_000_000, 50_000, 20_000_000),
  lightTimeoutMs: integer(process.env.LIGHT_TIMEOUT_MS, 15_000, 2_000, 60_000),
  lightCacheEntries: integer(process.env.LIGHT_CACHE_ENTRIES, 60, 0, 500),
  lightCacheTtlMs: integer(process.env.LIGHT_CACHE_TTL_SECONDS, 300, 0, 3600) * 1000,

  viewportMaxWidth: integer(process.env.VIEWPORT_MAX_WIDTH, 1920, 640, 2560),
  viewportMaxHeight: integer(process.env.VIEWPORT_MAX_HEIGHT, 1200, 480, 1600),

  audioEnabled: boolean(process.env.AUDIO_ENABLED, true),
  audioSource: text(process.env.AUDIO_SOURCE, 'auto').toLowerCase(),
  audioDevice: text(process.env.AUDIO_DEVICE),
  audioFfmpegPath: text(process.env.AUDIO_FFMPEG_PATH, 'ffmpeg'),
  // `pcm` streams raw 16-bit PCM from parec and lets the browser decode it with
  // Web Audio, which removes the per-session Opus encode. `webm` keeps the
  // ffmpeg Opus path (lower bandwidth, more server CPU).
  audioCapture: text(process.env.AUDIO_CAPTURE, 'pcm').toLowerCase() === 'webm' ? 'webm' : 'pcm',
  audioParecPath: text(process.env.AUDIO_PAREC_PATH, 'parec'),
  audioBitrateKbps: integer(process.env.AUDIO_BITRATE_KBPS, 64, 24, 160),
  audioPulseServer: text(process.env.AUDIO_PULSE_SERVER),
  audioPulseSink: text(process.env.AUDIO_PULSE_SINK),
  // Give every signed-in session its own Chromium process and audio sink, so a
  // visitor never hears another visitor's tabs. Costs one browser per session.
  audioPerSession: boolean(process.env.AUDIO_PER_SESSION, true),
  audioPactlPath: text(process.env.AUDIO_PACTL_PATH, 'pactl'),

  chromiumPath: text(process.env.CHROMIUM_PATH),
  // Which binary to launch: `auto` prefers an installed, auto-updating Chrome,
  // then Edge, and falls back to Playwright's bundled Chromium.
  chromiumChannel: (() => {
    const value = text(process.env.CHROMIUM_CHANNEL, 'auto').toLowerCase();
    return ['auto', 'chrome', 'msedge', 'bundled'].includes(value) ? value : 'auto';
  })(),
  // Advertised Chrome version in User-Agent and Client Hints. Empty = the real
  // build's version; set it when a site gates on a specific version.
  chromeVersion: text(process.env.CHROME_VERSION),
  browserMode: text(process.env.BROWSER_MODE, 'headless').toLowerCase() === 'headed' ? 'headed' : 'headless',
  chromiumSandbox: text(process.env.CHROMIUM_SANDBOX, 'auto').toLowerCase(),
  chromiumArgs: text(process.env.CHROMIUM_ARGS).split(/\s+/).filter(Boolean),
  // Collapses Chromium into one process. Off by default: it disables site
  // isolation and the renderer sandbox, and is unsupported by Chromium.
  chromiumSingleProcess: boolean(process.env.CHROMIUM_SINGLE_PROCESS, false),
  // Caps each renderer's V8 old space so one heavy page cannot grow without
  // bound. 0 leaves Chromium's default in place.
  chromiumJsHeapMb: integer(process.env.CHROMIUM_JS_HEAP_MB, 512, 0, 4096),
  // Chromium's own audio output buffer, in frames. Smaller means the page's
  // sound reaches the Pulse sink (and the viewer) sooner; Chromium clamps the
  // value to 512–8192. 0 leaves the default.
  chromiumAudioBuffer: integer(process.env.CHROMIUM_AUDIO_BUFFER, 1024, 0, 8192),
  // Chrome 139+ no longer falls back to SwiftShader for WebGL on its own, which
  // makes WebGL pages blank on a GPU-less server. This opts back in for headless
  // launches; it does not touch the sandbox.
  chromiumSoftwareGl: boolean(process.env.CHROMIUM_SOFTWARE_GL, true),
  // A server has no GPU to use, so its GPU process exists only to run
  // SwiftShader and cost memory. Measured on a playing TikTok tab, `off` took
  // the browser from 992 MB to 744 MB (GPU process 187 MB -> 58 MB) at the same
  // frame rate. `auto` restores Chromium's default for a machine with a GPU.
  chromiumGpu: text(process.env.CHROMIUM_GPU, 'off').toLowerCase() === 'auto' ? 'auto' : 'off',
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

  // Content filter: blocks adult domains and explicit search terms, and turns
  // on safe search for the built-in engines.
  contentFilter: boolean(process.env.CONTENT_FILTER, true),
  contentFilterBlock: list(process.env.CONTENT_FILTER_BLOCK),
  contentFilterAllow: list(process.env.CONTENT_FILTER_ALLOW),
  contentFilterTerms: list(process.env.CONTENT_FILTER_TERMS),

  logLevel: text(process.env.LOG_LEVEL, 'info').toLowerCase(),
  isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
  isProduction: process.env.NODE_ENV === 'production',
});
