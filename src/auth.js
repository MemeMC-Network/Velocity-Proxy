import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE_NAME = 'velocity_session';

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const fromB64url = (value) => Buffer.from(value, 'base64url');

const safeEqual = (a, b) => {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
};

export const parseCookies = (header) => {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
};

export class AuthService {
  constructor() {
    this.revoked = new Map();
    this.cleanup = setInterval(() => {
      const now = Date.now();
      for (const [id, expiresAt] of this.revoked) {
        if (expiresAt <= now) this.revoked.delete(id);
      }
    }, 10 * 60 * 1000);
    this.cleanup.unref?.();
  }

  sign(payload) {
    return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  }

  issue() {
    const body = { v: 1, id: crypto.randomBytes(18).toString('base64url'), iat: Date.now(), exp: Date.now() + config.sessionTtlMs };
    const payload = b64url(JSON.stringify(body));
    return { token: `${payload}.${this.sign(payload)}`, body };
  }

  verify(token) {
    if (typeof token !== 'string' || token.length < 10 || token.length > 1024) return null;
    const separator = token.lastIndexOf('.');
    if (separator < 1) return null;
    const payload = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    let expected;
    try {
      expected = this.sign(payload);
    } catch {
      return null;
    }
    const given = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
    let body;
    try {
      body = JSON.parse(fromB64url(payload).toString('utf8'));
    } catch {
      return null;
    }
    if (!body || body.v !== 1 || typeof body.id !== 'string' || typeof body.exp !== 'number') return null;
    if (body.exp <= Date.now()) return null;
    if (this.revoked.has(body.id)) return null;
    return body;
  }

  verifyCookieHeader(header) {
    const cookies = parseCookies(header);
    return this.verify(cookies[COOKIE_NAME]);
  }

  checkPassword(input) {
    if (config.authMode === 'none') return true;
    if (typeof input !== 'string' || input.length === 0 || input.length > 512) return false;
    return safeEqual(input, config.accessPassword);
  }

  revoke(body) {
    if (body?.id) this.revoked.set(body.id, body.exp || Date.now() + config.sessionTtlMs);
  }

  cookie(token, { secure = false, crossSite = false, partitioned = false } = {}) {
    const maxAge = Math.floor(config.sessionTtlMs / 1000);
    // SameSite=None is required inside a cross-site iframe and only valid on
    // HTTPS; everything else keeps the stricter Lax default.
    const sameSite = crossSite && secure ? 'None' : 'Lax';
    const attributes = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      `SameSite=${sameSite}`,
      `Max-Age=${maxAge}`,
    ];
    if (secure) attributes.push('Secure');
    if (secure && crossSite && partitioned) attributes.push('Partitioned');
    return attributes.join('; ');
  }

  clearCookie({ secure = false, crossSite = false } = {}) {
    const sameSite = crossSite && secure ? 'None' : 'Lax';
    return [
      `${COOKIE_NAME}=`,
      'Path=/',
      'HttpOnly',
      `SameSite=${sameSite}`,
      'Max-Age=0',
      secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ');
  }

  /** Middleware: resolves req.auth (or auto-auth in explicitly allowed dev mode). */
  middleware() {
    return (req, res, next) => {
      const body = this.verifyCookieHeader(req.headers.cookie);
      if (body) {
        req.auth = body;
        req.workspaceKey = body.id;
        return next();
      }
      if (config.authMode === 'none' && config.allowNoAuth) {
        req.auth = { id: 'local-development', anonymous: true };
        req.workspaceKey = 'local-development';
        return next();
      }
      req.auth = null;
      return next();
    };
  }

  /** True when the request looks like it comes from the proxy's own origin. */
  static isSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients still need a valid session
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host && originHost === String(host)) return true;
    if (config.publicOrigin) {
      try {
        if (originHost === new URL(config.publicOrigin).host) return true;
      } catch {
        /* ignore malformed PUBLIC_ORIGIN */
      }
    }
    return false;
  }

  static isSecureRequest(req) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto === 'https') return true;
    if (config.publicOrigin.startsWith('https://')) return true;
    return Boolean(req.secure);
  }

  static tokenFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    return cookies[COOKIE_NAME];
  }
}

export const authMiddleware = (auth) => auth.middleware();
