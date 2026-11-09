#!/usr/bin/env node
/**
 * Lightweight-engine integration test.
 *
 * Boots the real server with a local fixture site and drives the light engine
 * end to end over the same WebSocket the viewer uses: page extraction, links,
 * history, the image proxy and the guards. It also asserts that rendering a
 * light page never starts a Chromium process.
 *
 *   npm run test:light
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.data-light-test');
const PORT = 8093;
const origin = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'light-test-pass';

const results = [];
const pass = (label) => {
  results.push({ label, ok: true });
  console.log(`  \u001b[32m✓\u001b[0m ${label}`);
};
const fail = (label, error) => {
  results.push({ label, ok: false, error });
  console.log(`  \u001b[31m✗\u001b[0m ${label}\n    ${error?.message || error}`);
};

const check = async (label, fn) => {
  try {
    await fn();
    pass(label);
  } catch (error) {
    fail(label, error);
    throw error;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ fixture */

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="description" content="${title} description">
<link rel="stylesheet" href="/style.css"></head><body>
<nav><a href="/">home</a><a href="/second">second</a></nav>
<main><article>${body}</article></main>
<footer>footer noise that must not be extracted</footer>
<script>window.x = 1;</script></body></html>`;

const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/style.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('body{font-family:sans-serif}');
    return;
  }
  if (url.pathname === '/pixel.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' });
    res.end(PIXEL);
    return;
  }
  if (url.pathname === '/article') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      page(
        'Fixture Article',
        `<h1>The fixture article</h1>
         <p>First paragraph with a <a href="/second">link to the second page</a> and a
         <strong>bold run</strong> plus <em>emphasis</em>.</p>
         <p>Second paragraph, long enough that the extractor keeps it.
         <img src="/pixel.png" alt="a pixel"></p>
         <h2>A subheading</h2>
         <ul><li>first item</li><li>second item</li></ul>
         <pre><code>const answer = 42;</code></pre>
         <blockquote>A quoted line worth keeping.</blockquote>`,
      ),
    );
    return;
  }
  if (url.pathname === '/second') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Second Page', '<h1>Second page</h1><p>Content of the second page.</p>'));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<title>Missing</title><p>not here</p>');
});

/* ------------------------------------------------------------------- server */

let server;
let cookie = '';
let socket;
const messages = [];
const frames = [];

const waitFor = async (predicate, timeoutMs = 8000, label = 'message') => {
  const started = Date.now();
  for (;;) {
    const found = messages.find(predicate);
    if (found) return found;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(60);
  }
};

const send = (message) => socket.send(JSON.stringify(message));

const cleanup = async () => {
  try {
    socket?.close();
  } catch {
    /* ignore */
  }
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await sleep(1200);
    try {
      server.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
};

const main = async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  const sitePort = await new Promise((resolve) => site.listen(0, '127.0.0.1', () => resolve(site.address().port)));
  const base = `http://127.0.0.1:${sitePort}`;

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      ACCESS_PASSWORD: PASSWORD,
      AUTH_MODE: 'password',
      ALLOW_PRIVATE_TARGETS: '1',
      AUDIO_ENABLED: '0',
      LOG_LEVEL: 'warn',
      BROWSER_MODE: 'headless',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (/error|Error/.test(text)) process.stderr.write(text);
  });

  const health = async () => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        // /api/health sits behind the auth guard; /api/info is the public probe.
        const response = await fetch(`${origin}/api/info`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) return response.json();
      } catch {
        /* not up yet */
      }
      await sleep(250);
    }
    throw new Error('server did not start');
  };

  await check('server boots', async () => {
    const body = await health();
    assert.equal(body.name, 'Velocity Proxy');
    assert.equal(typeof body.version, 'string');
  });

  await check('sign in', async () => {
    const response = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(response.status, 200);
    const raw = response.headers.getSetCookie?.()[0] || response.headers.get('set-cookie') || '';
    cookie = raw.split(';')[0];
    assert.match(cookie, /=/, 'expected a session cookie');
  });

  await check('websocket connects', async () => {
    socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { cookie, origin } });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        frames.push(data);
        return;
      }
      try {
        messages.push(JSON.parse(String(data)));
      } catch {
        /* ignore */
      }
    });
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    await waitFor((message) => message.t === 'ready', 5000, 'ready');
  });

  await check('light tab renders a page without Chromium', async () => {
    send({ t: 'tab:create', input: `${base}/article`, engine: 'light', viewport: { width: 1200, height: 760 } });
    const light = await waitFor((message) => message.t === 'light', 15000, 'light page');
    assert.equal(light.page.title, 'Fixture Article');
    assert.ok(light.page.blocks.length >= 5, `expected several blocks, got ${light.page.blocks.length}`);
    const headings = light.page.blocks.filter((block) => block.type === 'h1' || block.type === 'h2');
    assert.ok(headings.length >= 2, 'expected the headings to survive extraction');
    assert.ok(
      light.page.blocks.some((block) => block.runs?.some((run) => run.href?.endsWith('/second'))),
      'expected the link to be kept as a run',
    );
    assert.ok(
      light.page.blocks.some((block) => block.runs?.some((run) => run.img)),
      'expected the image to be kept as a proxy reference',
    );
    assert.equal(light.page.hints.requiresChromium, false);
  });

  await check('tab reports the light engine and no live browser', async () => {
    const tab = await waitFor(
      (message) => message.t === 'tab' && message.tab?.engine === 'light' && message.tab?.url?.endsWith('/article'),
      6000,
      'light tab state',
    );
    assert.equal(tab.tab.loading, false);
    const stats = await (await fetch(`${origin}/api/stats`, { headers: { cookie, origin } })).json();
    assert.equal(stats.resources.liveBrowsers, 0, 'light pages must not start Chromium');
    assert.ok(stats.resources.lightTabs >= 1, 'light tab should be counted');
  });

  await check('navigating a light tab loads the next page', async () => {
    const tabId = messages.find((message) => message.t === 'tab' && message.tab?.engine === 'light')?.tab.id;
    assert.ok(tabId, 'expected a light tab id');
    send({ t: 'nav', tabId, input: `${base}/second`, viewport: { width: 1200, height: 760 } });
    const next = await waitFor(
      (message) => message.t === 'light' && message.tabId === tabId && message.page.url.endsWith('/second'),
      15000,
      'second page',
    );
    assert.equal(next.page.title, 'Second Page');
  });

  await check('back returns to the previous light page', async () => {
    const tabId = messages.find((message) => message.t === 'tab' && message.tab?.engine === 'light')?.tab.id;
    send({ t: 'back', tabId });
    const back = await waitFor(
      (message) => message.t === 'light' && message.tabId === tabId && message.page.url.endsWith('/article'),
      15000,
      'back to article',
    );
    assert.equal(back.page.title, 'Fixture Article');
  });

  await check('a 404 becomes a tab error, not a silent blank page', async () => {
    const tabId = messages.find((message) => message.t === 'tab' && message.tab?.engine === 'light')?.tab.id;
    send({ t: 'nav', tabId, input: `${base}/missing` });
    const state = await waitFor(
      (message) => message.t === 'light:state' && message.tabId === tabId && message.error,
      15000,
      'error state',
    );
    assert.match(state.error, /404|answer/i);
  });

  await check('image proxy serves the picture same-origin', async () => {
    const response = await fetch(
      `${origin}/api/light/asset?u=${encodeURIComponent(`${base}/pixel.png`)}`,
      { headers: { cookie, origin } },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.ok((await response.arrayBuffer()).byteLength > 20);
  });

  await check('non-http destinations are rejected', async () => {
    const response = await fetch(`${origin}/api/light/page?u=${encodeURIComponent('file:///etc/passwd')}`, {
      headers: { cookie, origin },
    });
    assert.equal(response.status, 400);
  });

  await check('the light API needs a session', async () => {
    const response = await fetch(`${origin}/api/light/page?u=${encodeURIComponent(`${base}/article`)}`);
    assert.equal(response.status, 401);
  });

  await check('no binary frames were streamed for light pages', async () => {
    assert.equal(frames.length, 0, `expected no frames, received ${frames.length}`);
  });
};

main()
  .catch((error) => {
    fail('suite', error);
  })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((result) => !result.ok);
    console.log(
      `\n${failed.length ? `\u001b[31m${failed.length} failed\u001b[0m` : '\u001b[32mall passed\u001b[0m'} · ${results.length} checks`,
    );
    process.exit(failed.length ? 1 : 0);
  });
