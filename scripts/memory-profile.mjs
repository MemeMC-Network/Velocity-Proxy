#!/usr/bin/env node
/**
 * Memory profile.
 *
 * Starts the real server against a local fixture, opens N browser-engine tabs
 * the same way the viewer does, and reports where the memory actually went:
 *
 *   - every Chromium process, grouped by type (browser, gpu-process, renderer,
 *     utility, zygote) with resident size and, on Linux, PSS from smaps_rollup
 *   - the Node server's own RSS/heap, read from /api/stats
 *   - per-tab cost, derived from the deltas — never estimated
 *
 *   node scripts/memory-profile.mjs --tabs 5 --label baseline
 *   CHROMIUM_ARGS="--disable-gpu ..." node scripts/memory-profile.mjs --label tuned
 *
 * Exit code is 0 even when the numbers are bad: this is a measuring tool.
 */
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const TAB_COUNT = Number.parseInt(arg('tabs', '5'), 10);
const LABEL = arg('label', 'run');
const PORT = Number.parseInt(arg('port', '8096'), 10);
// Time to let a policy act (idle sweeps, background-tab suspension) before the
// post-policy measurement, so "after" is measured rather than assumed.
const PAUSE_MS = Number.parseInt(arg('pause', '0'), 10);
// Opens one real site instead of the local fixture, for measuring a page like a
// video feed rather than a synthetic article.
const TARGET_URL = arg('url', null);
// Time to let the target settle (video buffering, lazy modules) before reading.
const SETTLE_MS = Number.parseInt(arg('settle', '0'), 10);
// Capture surface the page renders into. A video site picks its decode
// resolution from this, so it is a memory lever, not just a layout choice.
const VIEWPORT = (() => {
  const [width, height] = String(arg('viewport', '1280x800')).split('x');
  return { width: Number(width) || 1280, height: Number(height) || 800 };
})();
const dataDir = path.join(root, `.data-mem-${PORT}`);
const origin = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'mem-pass';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ fixture */

const longText = Array.from(
  { length: 40 },
  (_, index) => `<p>Paragraph ${index + 1}. ${'The quick brown fox jumps over the lazy dog. '.repeat(6)}</p>`,
).join('');
const heavyNodes = Array.from(
  { length: 1200 },
  (_, index) => `<div class="row"><span>row ${index}</span><a href="/article">link</a></div>`,
).join('');

const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/heavy') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Heavy Page</title><style>
      @keyframes spin { to { transform: rotate(360deg); } }
      .spinner { width: 40px; height: 40px; background: #333; animation: spin 1s linear infinite; }
      body { background: #101216; color: #eee; font-family: sans-serif; }
    </style><main><article><h1>Heavy page</h1><div class="spinner"></div>${heavyNodes}</article></main></html>`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Benchmark Article</title><style>
      body { background: #0d0f13; color: #e8eaef; font-family: Georgia, serif; max-width: 720px; margin: 40px auto; }
    </style><main><article><h1>Article</h1>${longText}</article></main></html>`);
});

/* ---------------------------------------------------------- process reader */

const round = (value) => Math.round(value * 10) / 10;

// Only the browser this server launched counts. Playwright always starts Chromium
// with its own throwaway profile and a debugging pipe, so both the browser and
// every child it forks carry that marker; the user's own Chrome does not.
const belongsToServer = (args) => /playwright_chromiumdev_profile|remote-debugging-pipe/.test(String(args || ''));

/** Reads every browser process with its type and memory, per platform. */
const readProcesses = async () => {
  if (process.platform === 'linux') {
    // PSS is the only honest number when Chromium shares pages between
    // processes; RSS sums double-count those pages.
    const { stdout } = await execFileAsync('bash', [
      '-lc',
      `ps -eo pid=,rss=,args= | grep -Ei '(chrome|chromium|headless_shell)' | grep -v grep || true`,
    ]);
    const rows = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!match) return null;
        const args = match[3];
        if (!belongsToServer(args)) return null;
        const typeMatch = args.match(/--type=([a-z-]+)/);
        return {
          pid: Number(match[1]),
          rssMb: round(Number(match[2]) / 1024),
          pssMb: null,
          type: typeMatch ? typeMatch[1] : 'browser',
        };
      })
      .filter(Boolean);
    for (const row of rows) {
      try {
        const { stdout: rollup } = await execFileAsync('bash', [
          '-lc',
          `awk '/^Pss:/{print $2}' /proc/${row.pid}/smaps_rollup 2>/dev/null || true`,
        ]);
        const kb = Number.parseInt(rollup.trim(), 10);
        if (Number.isFinite(kb)) row.pssMb = round(kb / 1024);
      } catch {
        /* process exited mid-read */
      }
    }
    return rows;
  }

  if (process.platform === 'win32') {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | " +
      'ForEach-Object { $t = "browser"; if ($_.CommandLine -match "--type=([a-z-]+)") { $t = $matches[1] }; ' +
      '"{0}|{1}|{2}|{3}|{4}" -f $_.ProcessId, $t, [math]::Round($_.WorkingSetSize/1MB,1), [math]::Round($_.PrivatePageCount/1MB,1), $_.CommandLine }';
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 30000 });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => belongsToServer(line))
      .map((line) => {
        const [pid, type, rss, priv] = line.split('|');
        return { pid: Number(pid), type, rssMb: Number(rss), privateMb: Number(priv), pssMb: null };
      })
      .filter((row) => Number.isFinite(row.rssMb));
  }

  const { stdout } = await execFileAsync('bash', [
    '-lc',
    "ps -Ao pid=,rss=,command= | grep -Ei 'Google Chrome|Chromium' | grep -v grep || true",
  ]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      if (!belongsToServer(match[3])) return null;
      const typeMatch = match[3].match(/--type=([a-z-]+)/);
      return { pid: Number(match[1]), rssMb: round(Number(match[2]) / 1024), type: typeMatch ? typeMatch[1] : 'browser', pssMb: null };
    })
    .filter(Boolean);
};

const summarise = (rows) => {
  const byType = {};
  for (const row of rows) {
    const bucket = (byType[row.type] ||= { count: 0, rssMb: 0, pssMb: 0 });
    bucket.count += 1;
    bucket.rssMb = round(bucket.rssMb + row.rssMb);
    bucket.pssMb = round(bucket.pssMb + (row.pssMb ?? row.rssMb));
  }
  return {
    processes: rows.length,
    rssMb: round(rows.reduce((sum, row) => sum + row.rssMb, 0)),
    pssMb: round(rows.reduce((sum, row) => sum + (row.pssMb ?? row.rssMb), 0)),
    byType,
  };
};

/* --------------------------------------------------------------------- run */

const main = async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  const sitePort = await new Promise((resolve) => site.listen(0, '127.0.0.1', () => resolve(site.address().port)));
  const base = `http://127.0.0.1:${sitePort}`;
  const report = { label: LABEL, tabs: TAB_COUNT, platform: process.platform };

  const before = summarise(await readProcesses());
  report.machineChromiumBefore = { processes: before.processes, rssMb: before.rssMb };

  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      ACCESS_PASSWORD: PASSWORD,
      ALLOW_PRIVATE_TARGETS: '1',
      AUDIO_ENABLED: '0',
      LOG_LEVEL: 'warn',
      MAX_TABS: '16',
      MAX_LIVE_TABS: '16',
      MAX_LIVE_BROWSERS: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (data) => serverLog.push(String(data)));
  server.stderr.on('data', (data) => serverLog.push(String(data)));

  let socket;
  try {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try {
        const response = await fetch(`${origin}/api/info`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch {
        /* starting */
      }
      await sleep(100);
    }

    const login = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const raw = login.headers.getSetCookie?.()[0] || login.headers.get('set-cookie') || '';
    const cookie = raw.split(';')[0];

    const messages = [];
    socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { cookie, origin } });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          messages.push(JSON.parse(String(data)));
        } catch {
          /* ignore */
        }
      }
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const waitFor = async (predicate, timeoutMs, label) => {
      const started = Date.now();
      for (;;) {
        const found = messages.find(predicate);
        if (found) return found;
        if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
        await sleep(50);
      }
    };
    await waitFor((message) => message.t === 'ready', 10000, 'ready');

    const stats = async () => {
      const response = await fetch(`${origin}/api/stats`, { headers: { cookie, origin } });
      const body = await response.json();
      return body;
    };

    // One tab first, so cold-launch cost is separated from per-tab cost.
    const target = TARGET_URL || `${base}/article`;
    const targetHost = TARGET_URL ? new URL(TARGET_URL).hostname.replace(/^www\./, '') : null;
    const openedAt = Date.now();
    socket.send(JSON.stringify({ t: 'tab:create', input: target, viewport: VIEWPORT }));
    await waitFor(
      (message) =>
        message.t === 'tab' &&
        message.tab?.loading === false &&
        (targetHost ? (message.tab?.url || '').includes(targetHost) : (message.tab?.title || '') === 'Benchmark Article'),
      90000,
      'first tab',
    );
    report.firstTabMs = Date.now() - openedAt;
    report.target = target;
    await sleep(SETTLE_MS > 0 ? SETTLE_MS : 2500);
    const one = summarise(await readProcesses());
    const oneStats = await stats();
    report.oneTab = {
      chromium: one,
      serverRssMb: round(oneStats.process.rssMb / 10) / 10,
      serverHeapMb: oneStats.process.heapMb,
      liveTabs: oneStats.resources.liveTabs,
    };

    for (let index = 1; index < TAB_COUNT && !TARGET_URL; index += 1) {
      socket.send(
        JSON.stringify({ t: 'tab:create', input: `${base}/article?n=${index}`, viewport: VIEWPORT }),
      );
      await waitFor(
        (message) => message.t === 'tab' && message.tab?.loading === false && (message.tab?.url || '').includes(`n=${index}`),
        60000,
        `tab ${index}`,
      );
    }
    await sleep(3000);
    if (PAUSE_MS > 0) {
      await sleep(PAUSE_MS);
      const settled = await stats();
      report.afterPolicy = {
        liveTabs: settled.resources.liveTabs,
        liveBrowsers: settled.resources.liveBrowsers,
        serverRssMb: settled.process.rssMb,
      };
    }
    const many = summarise(await readProcesses());
    const manyStats = await stats();
    const perTabPss = TAB_COUNT > 1 ? (many.pssMb - one.pssMb) / (TAB_COUNT - 1) : 0;
    report.processRows = await readProcesses();
    report.allTabs = {
      chromium: many,
      serverRssMb: manyStats.process.rssMb,
      serverHeapMb: manyStats.process.heapMb,
      liveTabs: manyStats.resources.liveTabs,
      liveBrowsers: manyStats.resources.liveBrowsers,
      // Cold launch is inside the oneTab measurement, so this delta is the
      // marginal cost of each additional open tab on this machine.
      perExtraTabPssMb: Math.round(perTabPss),
      perExtraTabRssMb: Math.round((many.rssMb - one.rssMb) / (TAB_COUNT - 1)),
    };

    // Idle cost: nothing is typing, so this is what a parked tab costs.
    const idleStart = await stats();
    const idleWall = Date.now();
    await sleep(5000);
    const idleEnd = await stats();
    const cpuMs =
      idleEnd.process.cpuUserMs - idleStart.process.cpuUserMs + (idleEnd.process.cpuSystemMs - idleStart.process.cpuSystemMs);
    report.idleCpuCorePercent = Math.round((cpuMs / (Date.now() - idleWall)) * 1000) / 10;
  } finally {
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    server.kill('SIGTERM');
    await sleep(2000);
    try {
      server.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    site.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  if (process.env.PROFILE_LOG === '1') console.error(serverLog.join(''));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error('memory profile failed:', error.message);
  process.exit(1);
});
