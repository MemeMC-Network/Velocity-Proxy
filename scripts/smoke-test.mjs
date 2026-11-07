#!/usr/bin/env node
/**
 * Velocity Proxy smoke test.
 *
 * Boots the real server with a throwaway data directory and a local target
 * site, then drives the WebSocket protocol end to end: login, tab creation,
 * screencast streaming, title/URL tracking, remote input, history navigation,
 * tab management and the SSRF guards.
 *
 *   npm run smoke
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.data-smoke');
const PROXY_PORT = 8091;
const origin = `http://127.0.0.1:${PROXY_PORT}`;

process.env.DATA_DIR = dataDir;
process.env.ALLOW_PRIVATE_TARGETS = '0';

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

const listen = (server, port = 0) =>
  new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForHttp = async (url, timeoutMs = 60_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return response;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

/* ------------------------------------------------------------------ fixtures */

const page = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
</head><body><main>${body}</main></body></html>`;

const siteServer = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/style.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('body{background:#0b0d12;color:#fff;font-family:sans-serif}');
    return;
  }
  if (pathname === '/favicon.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#5b8cff"/></svg>');
    return;
  }
  if (pathname === '/second') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Second Page', '<h1>second</h1>'));
    return;
  }
  if (pathname === '/input') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      page(
        'Input Page',
        '<input id="q" autofocus oninput="document.title = \'Typed:\' + this.value">',
      ),
    );
    return;
  }
  if (pathname === '/fingerprint') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      page(
        'Fingerprint',
        '<script>const b=(navigator.userAgentData?.brands||[]).map((x)=>x.brand).join(",");document.title=[navigator.userAgent,navigator.webdriver,b,typeof navigator.plugins[0]?.name].join("|")</script>',
      ),
    );
    return;
  }
  if (pathname === '/motion') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      page(
        'Motion Page',
        '<h1>motion</h1><script>let n=0;setInterval(()=>{document.body.style.background=n++%2?"#12161f":"#1d2430"},120)</script>',
      ),
    );
    return;
  }
  if (pathname === '/link') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      page(
        'Link Page',
        '<a href="https://www.pornhub.com/" style="position:fixed;left:0;top:0;width:400px;height:150px;display:block">blocked link</a>',
      ),
    );
    return;
  }
  if (pathname === '/redirect') {
    res.writeHead(302, { location: '/second' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page('Velocity Test Page', '<h1>Velocity test</h1><a href="/second">second</a>'));
});

await fs.rm(dataDir, { recursive: true, force: true });
const sitePort = await listen(siteServer);
const siteUrl = `http://127.0.0.1:${sitePort}/`;

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(PROXY_PORT),
    DATA_DIR: dataDir,
    ACCESS_PASSWORD: 'smoke-password',
    AUTH_MODE: 'password',
    PUBLIC_ORIGIN: origin,
    ALLOW_PRIVATE_TARGETS: '1',
    BROWSER_MODE: 'headless',
    LOG_LEVEL: 'info',
    MAX_TABS: '4',
    AUDIO_ENABLED: '1',
    AUDIO_SOURCE: 'tone',
    AUDIO_BITRATE_KBPS: '48',
    // Exercise the HTTPS/iframe cookie path (SameSite=None; Secure).
    PUBLIC_ORIGIN: 'https://proxy.example.com',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLogs = '';
child.stdout.on('data', (chunk) => {
  serverLogs += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  serverLogs += chunk.toString();
});

const stopChild = async () => {
  if (child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(4000).then(() => false),
  ]);
  if (!exited) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  siteServer.close();
};

console.log('\nVelocity Proxy smoke test\n');

try {
  await waitForHttp(`${origin}/api/info`);
  pass('server boots and answers /api/info');

  const info = await (await fetch(`${origin}/api/info`)).json();
  assert.equal(info.name, 'Velocity Proxy');
  assert.equal(info.authMode, 'password');

  /* ---------------------------------------------------------------- auth */

  await check('unauthenticated API access is rejected', async () => {
    const response = await fetch(`${origin}/api/session`);
    assert.equal(response.status, 401);
  });

  await check('cross-origin login attempts are rejected', async () => {
    const response = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ password: 'smoke-password' }),
    });
    assert.equal(response.status, 403);
  });

  await check('wrong password is rejected', async () => {
    const response = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert.equal(response.status, 401);
  });

  let cookie = '';
  await check('password login issues a hardened session cookie', async () => {
    const response = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ password: 'smoke-password' }),
    });
    assert.equal(response.status, 200);
    const raw = response.headers.getSetCookie?.()[0] || response.headers.get('set-cookie');
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=None/i);
    assert.match(raw, /Secure/i);
    cookie = raw.split(';')[0];
    assert.match(cookie, /^velocity_session=/);
  });

  const session = await (await fetch(`${origin}/api/session`, { headers: { cookie } })).json();
  await check('fresh session has no tabs and exposes search engines', () => {
    assert.deepEqual(session.tabs, []);
    assert.equal(session.activeTabId, null);
    assert.ok(session.engines.some((engine) => engine.id === 'google'));
    assert.equal(session.limits.maxTabs, 4);
    assert.equal(typeof session.audio?.enabled, 'boolean');
  });

  await check('the SPA shell is served at the proxy root', async () => {
    const response = await fetch(`${origin}/`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(html, /Velocity Proxy/);
    assert.doesNotMatch(html, /<iframe/i);
  });

  await check('the shell can be framed by any origin and allows audio playback', async () => {
    const response = await fetch(`${origin}/`, { headers: { cookie } });
    const csp = response.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-ancestors \*/);
    assert.equal(response.headers.get('x-frame-options'), null);
    assert.match(response.headers.get('permissions-policy') || '', /autoplay=\*/);
  });

  await check('legacy tab paths redirect to the root without exposing a destination', async () => {
    for (const path of ['/b/abcdef0123456789', '/tab/abcdef0123456789', '/browser/abcdef0123456789']) {
      const response = await fetch(`${origin}${path}`, { headers: { cookie }, redirect: 'manual' });
      assert.equal(response.status, 302, `${path} should redirect`);
      assert.equal(response.headers.get('location'), '/');
    }
  });

  await check('favicon endpoint refuses private hosts', async () => {
    const response = await fetch(`${origin}/api/favicon?host=127.0.0.1`, { headers: { cookie } });
    assert.equal(response.status, 400);
  });

  /* ------------------------------------------------------------- WebSocket */

  const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/ws`, { headers: { cookie, origin } });

  const nextMessage = (type, predicate = () => true, timeout = 30_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', handler);
        reject(new Error(`timed out waiting for "${type}"`));
      }, timeout);
      const handler = (data, isBinary) => {
        if (isBinary) return;
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message.t !== type || !predicate(message)) return;
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(message);
      };
      ws.on('message', handler);
    });

  const nextFrame = (timeout = 40_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', handler);
        reject(new Error('timed out waiting for a screencast frame'));
      }, timeout);
      const handler = (data, isBinary) => {
        if (!isBinary) return;
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(Buffer.from(data));
      };
      ws.on('message', handler);
    });

  const ready = nextMessage('ready');
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  await check('WebSocket handshake authenticates with the session cookie', async () => {
    const message = await ready;
    assert.deepEqual(message.tabs, []);
    assert.equal(message.limits.maxTabs, 4);
  });

  let tabId = null;
  await check('creating a tab renders the destination with Chromium and streams frames', async () => {
    const framePromise = nextFrame();
    const activePromise = nextMessage('tab:active', (message) => message.tab?.url === siteUrl);
    ws.send(JSON.stringify({ t: 'tab:create', input: siteUrl, viewport: { width: 1200, height: 760 } }));
    const active = await activePromise;
    tabId = active.id;
    assert.equal(active.tab.url, siteUrl);
    assert.equal(active.viewport.width, 1200);

    const frame = await framePromise;
    assert.equal(frame.readUInt32BE(0), 0x56584650, 'frame magic');
    assert.equal(frame.readUInt8(4), 2, 'frame version');
    const idLength = frame.readUInt8(5);
    const frameWidth = frame.readUInt16BE(6);
    const frameHeight = frame.readUInt16BE(8);
    assert.equal(frame.toString('utf8', 10, 10 + idLength), tabId);
    assert.ok(frameWidth >= 320 && frameHeight >= 240, 'frame carries its pixel size');
    assert.ok(frame.length > 10 + idLength + 500, 'frame contains JPEG data');
    assert.equal(frame[10 + idLength], 0xff, 'JPEG SOI marker');
    assert.equal(frame[11 + idLength], 0xd8, 'JPEG SOI marker');
  });

  await check('page title is tracked from the live DOM', async () => {
    const message = await nextMessage(
      'tab',
      (entry) => entry.tab.id === tabId && entry.tab.title === 'Velocity Test Page',
    );
    assert.equal(message.tab.url, siteUrl);
    assert.equal(message.tab.secure, false);
    assert.ok(message.tab.live);
  });

  await check('navigating inside the session updates the tab model', async () => {
    const promise = nextMessage(
      'tab',
      (entry) => entry.tab.id === tabId && entry.tab.url === `${siteUrl}second` && entry.tab.title === 'Second Page',
    );
    ws.send(JSON.stringify({ t: 'nav', tabId, input: `${siteUrl}second` }));
    const message = await promise;
    assert.equal(message.tab.host, `127.0.0.1:${sitePort}`);
  });

  await check('back and forward use the remote browser history', async () => {
    const back = nextMessage('tab', (entry) => entry.tab.id === tabId && entry.tab.url === siteUrl);
    ws.send(JSON.stringify({ t: 'back', tabId }));
    await back;
    const forward = nextMessage('tab', (entry) => entry.tab.id === tabId && entry.tab.url === `${siteUrl}second`);
    ws.send(JSON.stringify({ t: 'forward', tabId }));
    await forward;
  });

  await check('the remote browser does not present itself as headless', async () => {
    const loaded = nextMessage(
      'tab',
      (entry) => entry.tab.id === tabId && /Chrome\//.test(entry.tab.title || ''),
    );
    ws.send(JSON.stringify({ t: 'nav', tabId, input: `${siteUrl}fingerprint` }));
    const message = await loaded;
    const title = message.tab.title;
    assert.doesNotMatch(title, /headless/i);
    assert.match(title, /Google Chrome/);
    assert.doesNotMatch(title, /\|true\|/); // navigator.webdriver is hidden
    // Plugin entries must be objects: a list of numbers crashes real apps.
    assert.match(title, /\|string$/);
  });

  await check('a bare query is expanded with the search engine template', async () => {
    const promise = nextMessage(
      'tab',
      (entry) => entry.tab.id === tabId && /\/search\?q=velocity(?:%20|\+)proxy$/.test(entry.tab.url || ''),
    );
    ws.send(
      JSON.stringify({
        t: 'nav',
        tabId,
        input: 'velocity proxy',
        template: `${siteUrl}search?q=%s`,
      }),
    );
    await promise;
  });

  await check('the content filter refuses an explicit search query', async () => {
    const promise = nextMessage('error');
    ws.send(JSON.stringify({ t: 'nav', tabId, input: 'explicit porn videos' }));
    const message = await promise;
    assert.match(message.message, /content filter/i);
  });

  await check('the content filter refuses a blocked destination', async () => {
    const promise = nextMessage('error');
    ws.send(JSON.stringify({ t: 'nav', tabId, input: 'https://www.pornhub.com/' }));
    const message = await promise;
    assert.match(message.message, /blocked|content filter/i);
  });

  await check('a link to a blocked host is refused inside the page', async () => {
    const loaded = nextMessage(
      'tab',
      (entry) => entry.tab.id === tabId && entry.tab.title === 'Link Page',
    );
    ws.send(JSON.stringify({ t: 'nav', tabId, input: `${siteUrl}link` }));
    await loaded;

    const blocked = nextMessage(
      'tab',
      (entry) =>
        entry.tab.id === tabId && entry.tab.status === 'error' && /content filter/i.test(entry.tab.error || ''),
      30_000,
    );
    ws.send(JSON.stringify({ t: 'mouse', tabId, type: 'move', x: 60, y: 40 }));
    ws.send(JSON.stringify({ t: 'mouse', tabId, type: 'down', x: 60, y: 40, button: 'left', clickCount: 1 }));
    ws.send(JSON.stringify({ t: 'mouse', tabId, type: 'up', x: 60, y: 40, button: 'left', clickCount: 1 }));
    const message = await blocked;
    assert.match(message.tab.host, /pornhub\.com/);
  });

  await check('keystrokes and inserted text reach the remote page', async () => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('input page did not load')), 25_000);
      const handler = (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.t === 'tab' && message.tab.id === tabId && message.tab.title === 'Input Page') {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve();
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ t: 'nav', tabId, input: `${siteUrl}input` }));
    });

    const typed = nextMessage('tab', (entry) => entry.tab.id === tabId && entry.tab.title === 'Typed:hello');
    ws.send(JSON.stringify({ t: 'text', tabId, text: 'hello' }));
    await typed;

    const keyed = nextMessage('tab', (entry) => entry.tab.id === tabId && entry.tab.title === 'Typed:hello!');
    ws.send(JSON.stringify({ t: 'key', tabId, event: 'down', key: '!', code: 'Digit1', keyCode: 49, shift: true }));
    ws.send(JSON.stringify({ t: 'key', tabId, event: 'up', key: '!', code: 'Digit1', keyCode: 49, shift: true }));
    await keyed;
  });

  await check('a moved mouse updates hover state inside the page', async () => {
    ws.send(JSON.stringify({ t: 'mouse', tabId, type: 'move', x: 40, y: 40 }));
    ws.send(JSON.stringify({ t: 'wheel', tabId, x: 40, y: 40, deltaX: 0, deltaY: 120 }));
    ws.send(JSON.stringify({ t: 'copy', tabId }));
    const clipboard = await nextMessage('clipboard');
    assert.equal(typeof clipboard.text, 'string');
  });

  await check('tabs can be pinned and duplicated', async () => {
    const pinned = nextMessage('tab', (entry) => entry.tab.id === tabId && entry.tab.pinned === true);
    ws.send(JSON.stringify({ t: 'tab:pin', tabId, pinned: true }));
    await pinned;

    const active = nextMessage('tab:active');
    ws.send(JSON.stringify({ t: 'tab:duplicate', tabId }));
    const duplicate = await active;
    assert.notEqual(duplicate.id, tabId);
    assert.equal(duplicate.tab.url, `${siteUrl}input`);

    const closed = nextMessage('tab:closed', (message) => message.id === duplicate.id);
    ws.send(JSON.stringify({ t: 'tab:close', id: duplicate.id }));
    await closed;
  });

  await check('unauthenticated WebSocket upgrades are refused', async () => {
    const denied = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/ws`, { headers: { origin } });
    const outcome = await new Promise((resolve) => {
      denied.once('open', () => resolve('open'));
      denied.once('error', () => resolve('error'));
      setTimeout(() => resolve('timeout'), 5000);
    });
    assert.notEqual(outcome, 'open');
    denied.terminate();
  });

  await check('the active tab is persisted server-side, not in the URL', async () => {
    await sleep(1400);
    const files = (await fs.readdir(path.join(dataDir, 'workspaces'))).filter((file) => file.endsWith('.json'));
    const states = await Promise.all(
      files.map(async (file) => {
        try {
          return JSON.parse(await fs.readFile(path.join(dataDir, 'workspaces', file), 'utf8'));
        } catch {
          return {};
        }
      }),
    );
    const state = states.find((entry) => (entry.tabs || []).some((tab) => tab.id === tabId));
    assert.ok(state, 'workspace holding the tab');
    assert.equal(state.activeTabId, tabId);
    const sessionState = await (await fetch(`${origin}/api/session`, { headers: { cookie } })).json();
    assert.equal(sessionState.activeTabId, tabId);
  });

  await check('per-tab mute is persisted and reported to the client', async () => {
    const muted = nextMessage('tab', (entry) => entry.tab.id === tabId && entry.tab.muted === true);
    ws.send(JSON.stringify({ t: 'tab:mute', id: tabId, muted: true }));
    await muted;
    const unmuted = nextMessage('tab', (entry) => entry.tab.id === tabId && entry.tab.muted === false);
    ws.send(JSON.stringify({ t: 'tab:mute', id: tabId, muted: false }));
    await unmuted;
  });

  await check('audio streams live PCM or Opus over an authenticated socket', async () => {
    const info = await (await fetch(`${origin}/api/audio`, { headers: { cookie } })).json();
    assert.equal(info.enabled, true);
    if (info.status === 'unavailable') {
      // ffmpeg missing on this host: the transport is still checked below.
      assert.ok(info.reason);
      return;
    }
    const socket = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/ws/audio`, { headers: { cookie, origin } });
    const chunks = [];
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no audio data from ffmpeg')), 25_000);
        socket.on('message', (data, isBinary) => {
          if (!isBinary) return;
          chunks.push(Buffer.from(data));
          const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          if (total < 2048) return;
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', reject);
      });
      const audio = Buffer.concat(chunks);
      if (info.transport === 'pcm') {
        assert.equal(info.format?.encoding, 'pcm_s16le');
        assert.equal(audio.length % 4, 0, '16-bit stereo frame alignment');
        assert.ok(audio.some((byte) => byte !== 0), 'non-silent samples');
      } else {
        assert.equal(audio.readUInt32BE(0), 0x1a45dfa3, 'WebM/EBML header');
      }
    } finally {
      socket.close();
    }
  });

  await check('each session gets its own audio capture', async () => {
    const info = await (await fetch(`${origin}/api/audio`, { headers: { cookie } })).json();
    if (info.status === 'unavailable') return;

    const login = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ password: 'smoke-password' }),
    });
    assert.equal(login.status, 200);
    const secondCookie = (login.headers.getSetCookie?.()[0] || login.headers.get('set-cookie')).split(';')[0];
    assert.notEqual(secondCookie, cookie, 'a second login is a second session');

    const listen = (session) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/ws/audio`, {
          headers: { cookie: session, origin },
        });
        const timer = setTimeout(() => reject(new Error('no audio for this session')), 25_000);
        let total = 0;
        socket.on('message', (data, isBinary) => {
          if (!isBinary) return;
          total += data.length;
          if (total < 2048) return;
          clearTimeout(timer);
          socket.close();
          resolve();
        });
        socket.once('error', reject);
      });

    await listen(cookie);
    await listen(secondCookie);

    const health = await (await fetch(`${origin}/api/health`, { headers: { cookie } })).json();
    assert.ok(health.audioStreams >= 2, `expected one capture per session, saw ${health.audioStreams}`);
  });

  await check('audio socket refuses unauthenticated clients', async () => {
    const denied = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/ws/audio`, { headers: { origin } });
    const outcome = await new Promise((resolve) => {
      denied.once('open', () => resolve('open'));
      denied.once('error', () => resolve('error'));
      setTimeout(() => resolve('timeout'), 5000);
    });
    assert.notEqual(outcome, 'open');
    denied.terminate();
  });

  await check('streaming pauses while the viewer is hidden', async () => {
    const countFrames = (ms) =>
      new Promise((resolve) => {
        let count = 0;
        const onMessage = (data, isBinary) => {
          if (isBinary) count += 1;
        };
        ws.on('message', onMessage);
        setTimeout(() => {
          ws.off('message', onMessage);
          resolve(count);
        }, ms);
      });

    ws.send(JSON.stringify({ t: 'tab:activate', id: tabId }));
    ws.send(JSON.stringify({ t: 'nav', tabId, input: `${siteUrl}motion` }));
    const visible = await countFrames(2200);
    assert.ok(visible > 0, `expected frames while visible, saw ${visible}`);

    ws.send(JSON.stringify({ t: 'stream', tabId, active: false }));
    await sleep(700);
    const hidden = await countFrames(1500);
    assert.equal(hidden, 0, `a hidden viewer still received ${hidden} frames`);

    ws.send(JSON.stringify({ t: 'stream', tabId, active: true }));
    await sleep(500);
    const resumed = await countFrames(2200);
    assert.ok(resumed > 0, 'frames should resume when the viewer returns');
  });

  await check('activity stats are auth-guarded and report bounded resources', async () => {
    const denied = await fetch(`${origin}/api/stats`);
    assert.equal(denied.status, 401);
    const response = await fetch(`${origin}/api/stats`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const stats = await response.json();
    assert.equal(stats.ok, true);
    assert.ok(stats.process.rssMb > 0, 'resident memory should be reported');
    assert.ok(stats.resources.liveBrowsers <= stats.resources.maxLiveBrowsers, 'browsers stay within the cap');
    assert.ok(stats.resources.liveTabs <= stats.resources.maxLiveTabs, 'pages stay within the cap');
    assert.ok(stats.resources.maxLiveTabs >= 1);
    assert.ok(stats.limits.browserIdleSeconds >= 15);
  });

  await check('reclaim refuses cross-origin calls and reports releases', async () => {
    const cross = await fetch(`${origin}/api/reclaim`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', cookie },
    });
    assert.equal(cross.status, 403);
    const response = await fetch(`${origin}/api/reclaim`, { method: 'POST', headers: { origin, cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.ok(body.released >= 0);
  });

  await check('closing a tab removes it from the persisted workspace', async () => {
    const closed = nextMessage('tab:closed', (message) => message.id === tabId);
    ws.send(JSON.stringify({ t: 'tab:close', id: tabId }));
    await closed;
    await sleep(1200);
    const files = (await fs.readdir(path.join(dataDir, 'workspaces'))).filter((file) => file.endsWith('.json'));
    const states = await Promise.all(
      files.map(async (file) => {
        try {
          return JSON.parse(await fs.readFile(path.join(dataDir, 'workspaces', file), 'utf8'));
        } catch {
          return { tabs: [] };
        }
      }),
    );
    const ids = states.flatMap((state) => (state.tabs || []).map((tab) => tab.id));
    assert.ok(!ids.includes(tabId), 'closed tab should not be persisted');
  });

  ws.close();

  /* ------------------------------------------------------- client-side rules */

  await check('frontend uses no iframes and never opens external windows', async () => {
    const entries = await fs.readdir(path.join(root, 'public'), { recursive: true });
    for (const entry of entries) {
      const full = path.join(root, 'public', entry);
      const stat = await fs.stat(full);
      if (!stat.isFile() || !/\.(html|js|css)$/.test(full)) continue;
      const source = await fs.readFile(full, 'utf8');
      assert.doesNotMatch(source, /<iframe/i, `${entry} contains an iframe`);
      assert.doesNotMatch(source, /window\.open\s*\(/, `${entry} calls window.open`);
      assert.doesNotMatch(source, /history\.(pushState|replaceState)/, `${entry} writes the browser URL`);
      assert.doesNotMatch(source, /\/b\//, `${entry} contains a tab-specific path`);
    }
  });

  await check('SSRF guard blocks loopback, private ranges and metadata endpoints', async () => {
    const guard = await import('../src/security/ip-guard.js');
    assert.equal(guard.isPrivateIp('127.0.0.1'), true);
    assert.equal(guard.isPrivateIp('10.1.2.3'), true);
    assert.equal(guard.isPrivateIp('172.20.0.1'), true);
    assert.equal(guard.isPrivateIp('192.168.1.10'), true);
    assert.equal(guard.isPrivateIp('169.254.169.254'), true);
    assert.equal(guard.isPrivateIp('100.64.0.5'), true);
    assert.equal(guard.isPrivateIp('::1'), true);
    assert.equal(guard.isPrivateIp('fd00::1'), true);
    assert.equal(guard.isPrivateIp('8.8.8.8'), false);
    assert.equal(guard.isPrivateIp('1.1.1.1'), false);
    assert.equal(guard.isBlockedHostname('metadata.google.internal'), true);
    await assert.rejects(() => guard.assertPublicHttpUrl('http://127.0.0.1:8099/'), /private|reserved/i);
    await assert.rejects(
      () => guard.assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/'),
      /private|reserved/i,
    );
    await assert.rejects(() => guard.assertPublicHttpUrl('file:///etc/passwd'), /http/i);
    await assert.rejects(() => guard.assertPublicHttpUrl('javascript:alert(1)'), /http/i);
    await assert.rejects(() => guard.assertPublicHttpUrl('http://user:pass@example.com/'), /credentials/i);
  });

  await check('URL detection prepends https and falls back to search', async () => {
    const search = await import('../src/search.js');
    assert.equal(search.normalizeTarget('youtube.com'), 'https://youtube.com/');
    assert.equal(search.normalizeTarget('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(
      search.normalizeTarget('how to bake bread'),
      'https://www.google.com/search?q=how%20to%20bake%20bread&safe=active',
    );
    assert.equal(
      search.normalizeTarget('bread', { engine: 'duckduckgo' }),
      'https://duckduckgo.com/?q=bread&kp=1',
    );
    assert.match(
      search.normalizeTarget('cats', { template: 'https://search.example/?q=%s' }),
      /search\.example\/\?q=cats/,
    );
  });

  await check('content filter blocks adult domains and explicit searches', async () => {
    const filter = await import('../src/security/content-filter.js');
    assert.equal(filter.isBlockedHost('www.pornhub.com'), true);
    assert.equal(filter.isBlockedHost('pornhub.com'), true);
    assert.equal(filter.isBlockedHost('example.com'), false);
    assert.match(filter.blockedUrlReason('https://www.xvideos.com/'), /content filter/i);
    assert.match(filter.blockedUrlReason('https://www.google.com/search?q=porn'), /blocked/i);
    assert.equal(filter.blockedUrlReason('https://example.com/pornography'), null);
    assert.match(filter.blockedQueryReason('nude pics'), /blocked/i);
    assert.equal(filter.blockedQueryReason('how to bake bread'), null);
    assert.ok(filter.blockedDomains().length > 50);
  });

  await check('site compatibility rewrites a broken TikTok search to discover', async () => {
    const fixes = await import('../src/browser/site-fixes.js');
    assert.equal(
      fixes.rewriteDocumentTarget('https://www.tiktok.com/search?q=funny%20cats'),
      'https://www.tiktok.com/discover/funny-cats',
    );
    assert.equal(
      fixes.rewriteDocumentTarget('https://www.tiktok.com/search/video?q=dogs'),
      'https://www.tiktok.com/discover/dogs',
    );
    assert.equal(fixes.rewriteDocumentTarget('https://www.tiktok.com/@someone/video/1'), null);
    assert.equal(fixes.rewriteDocumentTarget('https://example.com/search?q=cats'), null);
  });

  console.log(`\n${results.filter((entry) => entry.ok).length}/${results.length} checks passed\n`);
  await stopChild();
  process.exit(0);
} catch (error) {
  console.error(`\nSmoke test failed: ${error.message}\n`);
  console.error('--- server log tail ---');
  console.error(serverLogs.split('\n').slice(-50).join('\n'));
  await stopChild();
  process.exit(1);
}
