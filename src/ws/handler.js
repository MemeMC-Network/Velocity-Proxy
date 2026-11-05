import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthService } from '../auth.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { log } from '../logger.js';
import { clientIp } from '../security/rate-limit.js';
import { assertPublicHttpUrl } from '../security/ip-guard.js';
import { normalizeTarget, validateTemplate } from '../search.js';
import { clamp } from '../util.js';

const reject = (socket, status, message) => {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* ignore */
  }
  socket.destroy();
};

const readViewport = (value) => {
  if (!value || typeof value !== 'object') return { width: 1280, height: 800 };
  return {
    width: clamp(value.width || 1280, 320, config.viewportMaxWidth),
    height: clamp(value.height || 800, 240, config.viewportMaxHeight),
  };
};

const resolveInput = async (message) => {
  const input = typeof message.input === 'string' ? message.input : '';
  if (!input.trim()) throw new HttpError(400, 'Type a URL or a search query');
  if (input.length > 8000) throw new HttpError(400, 'That input is too long');
  let template = null;
  if (typeof message.template === 'string' && message.template.trim()) {
    validateTemplate(message.template.trim());
    template = message.template.trim();
  }
  const engine = typeof message.engine === 'string' ? message.engine : 'google';
  let target;
  try {
    target = normalizeTarget(input, { engine, template });
  } catch (error) {
    throw new HttpError(400, error.message || 'That URL is not valid');
  }
  if (!target) throw new HttpError(400, 'Type a URL or a search query');
  await assertPublicHttpUrl(target);
  return target;
};

export function attachWebSocketServer(server, { auth, manager, limiter, audio }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
  const audioWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });

  audioWss.on('connection', (ws) => {
    if (!audio) {
      ws.close(1011, 'Audio unavailable');
      return;
    }
    audio.attach(ws);
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      try {
        const message = JSON.parse(String(raw));
        if (message?.t === 'ping' && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'pong' }));
        }
      } catch {
        /* ignore malformed control frames */
      }
    });
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    if (pathname !== '/ws' && pathname !== '/ws/audio') return reject(socket, 404, 'Not Found');
    if (pathname === '/ws/audio' && !audio) return reject(socket, 503, 'Audio Unavailable');

    const ip = clientIp(req);
    if (!limiter.consume(`ws:${ip}`, 40, 60_000)) return reject(socket, 429, 'Too Many Requests');
    if (!AuthService.isSameOrigin(req)) return reject(socket, 403, 'Forbidden');

    const body = auth.verifyCookieHeader(req.headers.cookie);
    const devAuth = config.authMode === 'none' && config.allowNoAuth;
    if (!body && !devAuth) return reject(socket, 401, 'Unauthorized');

    const target = pathname === '/ws/audio' ? audioWss : wss;
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req, body));
  });

  wss.on('connection', async (ws, req, body) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    let workspace;
    try {
      workspace = await manager.getWorkspace(body?.id || 'local-development');
    } catch (error) {
      log.error('workspace failed', error.message);
      ws.close(1011, 'Workspace unavailable');
      return;
    }

    const client = {
      id: crypto.randomBytes(4).toString('hex'),
      ws,
      tabId: null,
      closed: false,
      ready() {
        return ws.readyState === WebSocket.OPEN;
      },
      send(message) {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify(message));
        } catch {
          /* socket closing */
        }
      },
      sendFrame(packet) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 1_500_000) return; // do not queue stale video frames
        try {
          ws.send(packet, { binary: true });
        } catch {
          /* socket closing */
        }
      },
    };

    workspace.attachClient(client);

    // Per-socket token bucket so one client cannot flood the engine.
    let tokens = 600;
    let lastRefill = Date.now();
    const allow = (cost = 1) => {
      const now = Date.now();
      tokens = Math.min(600, tokens + ((now - lastRefill) / 1000) * 450);
      lastRefill = now;
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    };

    client.send({
      t: 'ready',
      serverTime: Date.now(),
      tabs: workspace.list(),
      history: workspace.historySnapshot(),
      limits: { maxTabs: config.maxTabs },
      version: config.version,
    });

    ws.on('close', () => {
      client.closed = true;
      workspace.detachClient(client);
    });
    ws.on('error', (error) => log.debug('ws error', error.message));

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return;
      if (!allow(1)) return;
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!message || typeof message.t !== 'string') return;

      try {
        await handle(client, workspace, message);
      } catch (error) {
        if (error instanceof HttpError) {
          client.send({ t: 'error', message: error.message, code: error.code, requestId: message.requestId });
        } else {
          log.warn('socket handler error', message.t, error.message);
          client.send({ t: 'error', message: 'Something went wrong handling that request', requestId: message.requestId });
        }
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

async function handle(client, workspace, message) {
  const activeId = typeof message.tabId === 'string' && message.tabId ? message.tabId : client.tabId;

  const requireRecord = () => {
    const record = workspace.getRecord(activeId);
    if (!record) throw new HttpError(404, 'That tab no longer exists');
    return record;
  };

  const requireLive = async () => {
    const record = requireRecord();
    if (!record.session) return { record, session: null };
    return { record, session: record.session };
  };

  switch (message.t) {
    case 'ping':
      client.send({ t: 'pong', ts: message.ts, serverTime: Date.now() });
      return;

    case 'hello': {
      const requested =
        typeof message.tabId === 'string' && workspace.getRecord(message.tabId) ? message.tabId : null;
      const fallback =
        workspace.activeRecordId && workspace.getRecord(workspace.activeRecordId)
          ? workspace.activeRecordId
          : workspace.order[0];
      const id = requested || fallback;
      if (id) await workspace.activate(client, id, readViewport(message.viewport));
      return;
    }

    case 'tab:create': {
      let url = null;
      if (typeof message.input === 'string' && message.input.trim()) {
        url = await resolveInput(message);
      }
      const record = await workspace.createTab({ url, pinned: Boolean(message.pinned) });
      await workspace.activate(client, record.id, readViewport(message.viewport));
      return;
    }

    case 'tab:activate': {
      if (typeof message.id !== 'string') throw new HttpError(400, 'Missing tab id');
      await workspace.activate(client, message.id, readViewport(message.viewport));
      return;
    }

    case 'tab:close': {
      if (typeof message.id !== 'string') throw new HttpError(400, 'Missing tab id');
      await workspace.closeTab(message.id);
      return;
    }

    case 'tab:duplicate': {
      const record = requireRecord();
      const copy = await workspace.createTab({ url: record.url, title: record.title, pinned: false });
      await workspace.activate(client, copy.id, readViewport(message.viewport));
      return;
    }

    case 'tab:pin': {
      const record = requireRecord();
      workspace.setPinned(record.id, message.pinned ?? !record.pinned);
      return;
    }

    case 'tab:mute': {
      const id = typeof message.id === 'string' && message.id ? message.id : client.tabId;
      if (!id) throw new HttpError(400, 'Missing tab id');
      workspace.setTabMuted(id, Boolean(message.muted));
      return;
    }

    case 'nav': {
      const record = requireRecord();
      const target = await resolveInput(message);
      record.url = target;
      record.status = 'loading';
      record.error = null;
      const viewport = readViewport(message.viewport);
      const session = await workspace.ensureLive(record, { viewport, restore: false });
      await session.setViewport(viewport.width, viewport.height);
      session.attach(client);
      client.send({
        t: 'viewport',
        tabId: record.id,
        width: session.viewport.width,
        height: session.viewport.height,
      });
      await session.navigate(target);
      return;
    }

    case 'back':
    case 'forward':
    case 'reload':
    case 'stop':
    case 'home': {
      const { record, session } = await requireLive();
      if (!session) {
        if (message.t === 'home') {
          record.url = null;
          record.title = 'New Tab';
          record.status = 'idle';
          record.error = null;
          workspace.broadcast({ t: 'tab', tab: workspace.publicTab(record) });
          workspace.save();
        }
        return;
      }
      if (message.t === 'back') await session.goBack();
      else if (message.t === 'forward') await session.goForward();
      else if (message.t === 'reload') await session.reload();
      else if (message.t === 'stop') await session.stop();
      else await session.goHome();
      return;
    }

    case 'viewport': {
      if (!client.tabId) return;
      const record = workspace.getRecord(client.tabId);
      if (!record?.session) return;
      const viewport = readViewport(message);
      await record.session.setViewport(viewport.width, viewport.height);
      client.send({
        t: 'viewport',
        tabId: record.id,
        width: record.session.viewport.width,
        height: record.session.viewport.height,
      });
      return;
    }

    case 'mouse': {
      const { session } = await requireLive();
      if (!session) return;
      const type = message.type;
      if (type !== 'move' && type !== 'down' && type !== 'up') return;
      await session.mouse(type, {
        x: Number(message.x) || 0,
        y: Number(message.y) || 0,
        button: message.button,
        clickCount: clamp(message.clickCount || 1, 1, 3),
      });
      return;
    }

    case 'wheel': {
      const { session } = await requireLive();
      if (!session) return;
      await session.wheel({
        x: clamp(message.x || 0, 0, config.viewportMaxWidth),
        y: clamp(message.y || 0, 0, config.viewportMaxHeight),
        deltaX: clamp(message.deltaX || 0, -4000, 4000),
        deltaY: clamp(message.deltaY || 0, -4000, 4000),
      });
      return;
    }

    case 'key': {
      const { session } = await requireLive();
      if (!session) return;
      const type = message.event === 'up' || message.type === 'up' ? 'up' : 'down';
      const key = typeof message.key === 'string' ? message.key.slice(0, 32) : '';
      if (!key) return;
      await session.key({
        type,
        key,
        code: typeof message.code === 'string' ? message.code.slice(0, 32) : '',
        keyCode: Number(message.keyCode) || 0,
        autoRepeat: Boolean(message.autoRepeat),
        modifiers: {
          ctrl: Boolean(message.ctrl),
          alt: Boolean(message.alt),
          meta: Boolean(message.meta),
          shift: Boolean(message.shift),
        },
      });
      return;
    }

    case 'text': {
      const { session } = await requireLive();
      if (!session) return;
      await session.insertText(typeof message.text === 'string' ? message.text : '');
      return;
    }

    case 'copy': {
      const { session } = await requireLive();
      if (!session) return;
      const text = await session.readSelection();
      client.send({ t: 'clipboard', text });
      return;
    }

    case 'quality': {
      const { session } = await requireLive();
      if (!session) return;
      session.setQuality(message.value);
      return;
    }

    case 'dialog': {
      const record = requireRecord();
      if (!record.session) return;
      await record.session.respondDialog(String(message.id || ''), {
        accept: Boolean(message.accept),
        text: typeof message.text === 'string' ? message.text : undefined,
      });
      return;
    }

    case 'history:clear': {
      workspace.clearHistory();
      return;
    }

    default:
      return;
  }
}
