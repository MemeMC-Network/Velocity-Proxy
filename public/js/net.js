/** Thin API + WebSocket client for the proxy. */

const jsonHeaders = { 'content-type': 'application/json' };

export const api = {
  async request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body ? jsonHeaders : {}), ...(options.headers || {}) },
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = new Error(body?.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return body;
  },
  get(path) {
    return this.request(path);
  },
  post(path, body) {
    return this.request(path, { method: 'POST', body: JSON.stringify(body || {}) });
  },
  del(path) {
    return this.request(path, { method: 'DELETE' });
  },
};

export class Connection extends EventTarget {
  constructor() {
    super();
    this.socket = null;
    this.attempts = 0;
    this.manuallyClosed = false;
    this.timer = null;
    this.status = 'connecting';
  }

  connect() {
    clearTimeout(this.timer);
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try {
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.setStatus('connecting');

    socket.addEventListener('open', () => {
      this.attempts = 0;
      this.setStatus('open');
      this.dispatchEvent(new CustomEvent('open'));
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message && typeof message.t === 'string') {
          this.dispatchEvent(new CustomEvent(message.t, { detail: message }));
          this.dispatchEvent(new CustomEvent('message', { detail: message }));
        }
        return;
      }
      this.dispatchEvent(new CustomEvent('frame', { detail: event.data }));
    });

    socket.addEventListener('close', (event) => {
      this.socket = null;
      if (this.manuallyClosed) return;
      if (event.code === 4401 || event.code === 1008) {
        this.setStatus('denied');
        this.dispatchEvent(new CustomEvent('denied'));
        return;
      }
      this.setStatus('offline');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      /* close handles recovery */
    });
  }

  scheduleReconnect() {
    clearTimeout(this.timer);
    const delay = Math.min(6000, 500 * 2 ** Math.min(this.attempts, 4));
    this.attempts += 1;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status } }));
  }

  get isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(message) {
    if (!this.isOpen) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.manuallyClosed = true;
    clearTimeout(this.timer);
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

export const connection = new Connection();
