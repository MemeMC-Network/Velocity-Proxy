#!/usr/bin/env node
/**
 * Engine benchmark.
 *
 * Runs both engines against the same local fixture pages, on the same machine,
 * against the same server process, so the numbers are comparable:
 *
 *   - startup (spawn → first answered request)
 *   - light engine: latency and payload for one page, then ten pages at once
 *   - Chromium: cold launch + first frame + navigation time, then five tabs
 *   - server RSS, Chromium process count and RSS, CPU time for active and idle
 *
 *   npm run bench
 *
 * Nothing here is an estimate: every number is read from the running server or
 * from the OS process table.
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
const dataDir = path.join(root, '.data-bench');
const PORT = 8094;
const origin = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'bench-pass';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ fixture */

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const longText = Array.from({ length: 40 }, (_, index) => `<p>Paragraph ${index + 1}. ${'The quick brown fox jumps over the lazy dog. '.repeat(6)}</p>`).join('');
const heavyNodes = Array.from({ length: 2500 }, (_, index) => `<div class="row"><span>row ${index}</span><a href="/article">link</a></div>`).join('');

const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/pixel.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PIXEL);
    return;
  }
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
      h1 { font-size: 32px; } a { color: #e3b183; }
    </style><meta name="description" content="A benchmark article">
    <main><article><h1>Benchmark article</h1>${longText}</article></main></html>`);
});

/* ------------------------------------------------------------------- helpers */

let cookie = '';
const messages = [];
let socket;
const frames = { count: 0, bytes: 0, firstAt: 0 };
const send = (message) => socket.send(JSON.stringify(message));

let cursor = 0;
// Each match consumes everything before it, so a later phase cannot satisfy
// itself with a message an earlier phase already caused.
const waitFor = async (predicate, timeoutMs, label) => {
  const started = Date.now();
  for (;;) {
    while (cursor < messages.length) {
      const message = messages[cursor];
      cursor += 1;
      if (predicate(message)) return message;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(40);
  }
};

/** Waits for a tab to report the given title with loading finished. */
const waitForTab = (title, timeoutMs = 60000) =>
  waitFor(
    (message) =>
      message.t === 'tab' &&
      message.tab &&
      message.tab.loading === false &&
      (message.tab.title || '') === title,
    timeoutMs,
    `tab "${title}"`,
  );

const statsOf = async () => {
  const response = await fetch(`${origin}/api/stats`, { headers: { cookie, origin } });
  const body = await response.json();
  return {
    rssMb: body.process.rssMb,
    heapMb: body.process.heapMb,
    cpuUserMs: body.process.cpuUserMs,
    cpuSystemMs: body.process.cpuSystemMs,
    cores: body.process.cores,
    liveBrowsers: body.resources.liveBrowsers,
    liveTabs: body.resources.liveTabs,
    lightTabs: body.resources.lightTabs,
  };
};

const chromiumProcesses = async () => {
  try {
    if (process.platform === 'win32') {
      const script =
        "$p = Get-Process chrome,msedge -ErrorAction SilentlyContinue; if ($p) { '{0}|{1}' -f $p.Count, [math]::Round(($p | Measure-Object WorkingSet64 -Sum).Sum/1MB) } else { '0|0' }";
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 30000 });
      const [count, mb] = stdout.trim().split('|').map(Number);
      return { count: count || 0, mb: mb || 0 };
    }
    const { stdout } = await execFileAsync('bash', [
      '-lc',
      "ps -eo rss,comm | grep -E '(chrome|chromium)' | awk '{c+=1; r+=int($1/1024)} END {print c+0\"|\"r+0}'",
    ], { timeout: 30000 });
    const [count, mb] = stdout.trim().split('|').map(Number);
    return { count: count || 0, mb: mb || 0 };
  } catch {
    return { count: 0, mb: 0 };
  }
};

const cpuUsedMs = (after, before) => (after.cpuUserMs - before.cpuUserMs) + (after.cpuSystemMs - before.cpuSystemMs);
const corePercent = (after, before, wallMs) => Math.round((cpuUsedMs(after, before) / wallMs) * 1000) / 10;

const main = async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  const sitePort = await new Promise((resolve) => site.listen(0, '127.0.0.1', () => resolve(site.address().port)));
  const base = `http://127.0.0.1:${sitePort}`;
  const report = {};

  const spawnAt = Date.now();
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
      MAX_LIVE_TABS: '8',
      MAX_TABS: '12',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

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
    report.startupMs = Date.now() - spawnAt;

    const login = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const raw = login.headers.getSetCookie?.()[0] || login.headers.get('set-cookie') || '';
    cookie = raw.split(';')[0];

    socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { cookie, origin } });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        frames.count += 1;
        frames.bytes += data.byteLength;
        if (!frames.firstAt) frames.firstAt = Date.now();
        return;
      }
      try {
        messages.push(JSON.parse(String(data)));
      } catch {
        /* ignore */
      }
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await waitFor((message) => message.t === 'ready', 10000, 'ready');

    /* --------------------------------------------------------------- light -- */
    const baseline = await statsOf();
    const baselineProc = await chromiumProcesses();

    const timing = async (target) => {
      const started = Date.now();
      const response = await fetch(`${origin}/api/light/page?u=${encodeURIComponent(target)}`, {
        headers: { cookie, origin },
      });
      const text = await response.text();
      const body = JSON.parse(text);
      if (!body.ok) throw new Error(`light fetch failed: ${body.error}`);
      return { ms: Date.now() - started, bytes: text.length, blocks: body.page.blocks.length };
    };

    const lightSingle = [];
    for (let run = 0; run < 4; run += 1) lightSingle.push(await timing(`${base}/article`));
    const lightHeavy = await timing(`${base}/heavy`);

    const concurrentStart = Date.now();
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, (_, index) => timing(`${base}/${index % 2 ? 'heavy' : 'article'}`)),
    );
    const concurrentMs = Date.now() - concurrentStart;

    // Ten real light tabs, created the way the viewer creates them, so the
    // comparison is per tab rather than per HTTP call.
    const lightTabStart = Date.now();
    const lightTabIds = [];
    for (let index = 0; index < 10; index += 1) {
      send({
        t: 'tab:create',
        input: `${base}/${index % 2 ? 'heavy' : 'article'}?l=${index}`,
        engine: 'light',
        viewport: { width: 1200, height: 760 },
      });
      const created = await waitFor(
        (message) => message.t === 'light' && (message.page?.url || '').includes(`l=${index}`),
        30000,
        `light tab ${index}`,
      );
      lightTabIds.push(created.tabId);
    }
    const tenLightTabsMs = Date.now() - lightTabStart;

    const afterLight = await statsOf();
    const afterLightProc = await chromiumProcesses();
    for (const id of lightTabIds) send({ t: 'tab:close', id });
    await sleep(500);

    report.light = {
      singlePageMs: Math.round(lightSingle.reduce((sum, entry) => sum + entry.ms, 0) / lightSingle.length),
      heavyPageMs: lightHeavy.ms,
      singlePayloadKb: Math.round((lightSingle.at(-1).bytes / 1024) * 10) / 10,
      heavyBlocks: lightHeavy.blocks,
      tenPagesWallMs: concurrentMs,
      tenPagesPayloadKb: Math.round(concurrent.reduce((sum, entry) => sum + entry.bytes, 0) / 102.4) / 10,
      tenTabsWallMs: tenLightTabsMs,
      tabsAfterOpen: afterLight.lightTabs,
      serverRssDeltaMb: afterLight.rssMb - baseline.rssMb,
      serverHeapDeltaMb: afterLight.heapMb - baseline.heapMb,
      chromiumProcessesStarted: afterLightProc.count - baselineProc.count,
      chromiumMbStarted: afterLightProc.mb - baselineProc.mb,
      liveBrowsers: afterLight.liveBrowsers,
      lightTabs: afterLight.lightTabs,
    };

    /* ------------------------------------------------------------ chromium -- */
    const cpuIdleStart = await statsOf();
    const idleWall = Date.now();
    await sleep(4000);
    const cpuIdleEnd = await statsOf();
    report.light.idleCpuCorePercent = corePercent(cpuIdleEnd, cpuIdleStart, Date.now() - idleWall);

    const navStart = Date.now();
    send({ t: 'tab:create', input: `${base}/article`, viewport: { width: 1200, height: 760 } });
    const firstTab = await waitForTab('Benchmark Article');
    const firstFrameAt = frames.firstAt;
    while (!firstFrameAt && Date.now() - navStart < 60000) await sleep(50);
    report.chromium = {
      coldLaunchAndNavMs: Date.now() - navStart,
      firstFrameMs: frames.firstAt ? frames.firstAt - navStart : null,
    };

    const activeStart = await statsOf();
    const activeWall = Date.now();
    await sleep(6000);
    const activeEnd = await statsOf();
    report.chromium.activeCpuCorePercent = corePercent(activeEnd, activeStart, Date.now() - activeWall);
    report.chromium.framesInWindow = frames.count;
    report.chromium.frameKb = frames.count ? Math.round(frames.bytes / frames.count / 1024) : 0;

    const idleStart = await statsOf();
    const chromiumIdleWall = Date.now();
    await sleep(6000);
    const idleEnd = await statsOf();
    report.chromium.idleCpuCorePercent = corePercent(idleEnd, idleStart, Date.now() - chromiumIdleWall);

    // A page that animates: this is the "active" case, where frames, encode CPU
    // and bandwidth are all real rather than one static paint.
    const heavyStart = Date.now();
    send({ t: 'nav', tabId: firstTab.tab.id, input: `${base}/heavy`, viewport: { width: 1200, height: 760 } });
    await waitForTab('Heavy Page');
    const heavyNavMs = Date.now() - heavyStart;
    const heavyFrames = frames.count;
    const heavyBytes = frames.bytes;
    const heavyCpuStart = await statsOf();
    const heavyWall = Date.now();
    await sleep(6000);
    const heavyCpuEnd = await statsOf();
    const heavyElapsed = Date.now() - heavyWall;
    const heavyFrameCount = frames.count - heavyFrames;
    report.chromium.heavy = {
      navMs: heavyNavMs,
      fps: Math.round((heavyFrameCount / heavyElapsed) * 1000 * 10) / 10,
      frameKb: heavyFrameCount ? Math.round((frames.bytes - heavyBytes) / heavyFrameCount / 1024) : 0,
      cpuCorePercent: corePercent(heavyCpuEnd, heavyCpuStart, heavyElapsed),
      serverRssMb: heavyCpuEnd.rssMb,
    };

    // Five tabs, sequentially, to show how memory scales per live page.
    const opened = [];
    for (let index = 0; index < 4; index += 1) {
      const started = Date.now();
      send({ t: 'tab:create', input: `${base}/article?tab=${index}`, viewport: { width: 1200, height: 760 } });
      const tab = await waitFor(
        (message) =>
          message.t === 'tab' &&
          message.tab?.loading === false &&              (message.tab?.url || '').includes(`tab=${index}`) &&
          (message.tab?.title || '') === 'Benchmark Article',
        60000,
        `extra tab ${index}`,
      );
      opened.push({ id: tab.tab.id, ms: Date.now() - started });
    }
    const fiveTabs = await statsOf();
    const fiveProc = await chromiumProcesses();
    report.chromium.fiveTabs = {
      openMs: opened.map((entry) => entry.ms),
      serverRssMb: fiveTabs.rssMb,
      liveTabs: fiveTabs.liveTabs,
      processCount: fiveProc.count - baselineProc.count,
      processRssMb: fiveProc.mb - baselineProc.mb,
      // Five tabs were opened by this run (one navigated plus four added), so
      // divide by that rather than by a live count that can race with reporting.
      rssPerTabMb: Math.round(((fiveProc.mb - baselineProc.mb) / 5) * 10) / 10,
    };

    report.summary = {
      startupMs: report.startupMs,
      lightSinglePageMs: report.light.singlePageMs,
      chromiumColdLaunchAndNavMs: report.chromium.coldLaunchAndNavMs,
      lightTenPagesWallMs: report.light.tenPagesWallMs,
      lightTenTabsWallMs: report.light.tenTabsWallMs,
      lightChromiumProcesses: report.light.chromiumProcessesStarted,
      chromiumProcessesFiveTabs: report.chromium.fiveTabs.processCount,
      chromiumProcessRssMbFiveTabs: report.chromium.fiveTabs.processRssMb,
      chromiumServerRssMbFiveTabs: report.chromium.fiveTabs.serverRssMb,
      lightServerRssDeltaMb: report.light.serverRssDeltaMb,
      chromiumIdleCpuCorePercent: report.chromium.idleCpuCorePercent,
      chromiumHeavyFps: report.chromium.heavy.fps,
      chromiumHeavyCpuCorePercent: report.chromium.heavy.cpuCorePercent,
      chromiumHeavyFrameKb: report.chromium.heavy.frameKb,
      lightIdleCpuCorePercent: report.light.idleCpuCorePercent,
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    server.kill('SIGTERM');
    await sleep(1500);
    try {
      server.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    site.close();
  }
};

main().catch((error) => {
  console.error('benchmark failed:', error.message);
  process.exit(1);
});
