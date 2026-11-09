/**
 * A tiny cookie jar for the lightweight engine.
 *
 * Chromium keeps cookies in its own profile per tab; the light engine has no
 * browser, so the same job is done here, scoped to one workspace (one signed-in
 * visitor) so two visitors can never see each other's session. Only what a
 * server sends back is stored: nothing is shared between hosts.
 */

const MAX_COOKIES = 600;
const MAX_COOKIE_BYTES = 4096;

const domainMatches = (host, domain) => {
  const target = domain.replace(/^\./, '').toLowerCase();
  const value = host.toLowerCase();
  return value === target || value.endsWith(`.${target}`);
};

const pathMatches = (path, cookiePath) => {
  if (!cookiePath || cookiePath === '/') return true;
  if (path === cookiePath) return true;
  if (!path.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || path[cookiePath.length] === '/';
};

/** Parses one Set-Cookie header into a jar entry, or null when malformed. */
const parseSetCookie = (header, host) => {
  if (typeof header !== 'string' || header.length > MAX_COOKIE_BYTES) return null;
  const [pair, ...attributes] = header.split(';');
  const index = pair.indexOf('=');
  if (index <= 0) return null;
  const name = pair.slice(0, index).trim();
  const value = pair.slice(index + 1).trim();
  if (!name || /[\s,;]/.test(name)) return null;

  const entry = { name, value, domain: host.toLowerCase(), path: '/', expiresAt: null, hostOnly: true };
  for (const attribute of attributes) {
    const separator = attribute.indexOf('=');
    const key = (separator === -1 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
    const raw = separator === -1 ? '' : attribute.slice(separator + 1).trim();
    if (key === 'domain' && raw) {
      const domain = raw.replace(/^\./, '').toLowerCase();
      // A host may only set cookies for itself or a parent domain.
      if (!domainMatches(host, domain)) return null;
      entry.domain = domain;
      entry.hostOnly = false;
    } else if (key === 'path' && raw.startsWith('/')) {
      entry.path = raw;
    } else if (key === 'max-age') {
      const seconds = Number.parseInt(raw, 10);
      if (Number.isFinite(seconds)) {
        entry.expiresAt = seconds <= 0 ? 0 : Date.now() + seconds * 1000;
      }
    } else if (key === 'expires' && entry.expiresAt == null) {
      const at = Date.parse(raw);
      if (Number.isFinite(at)) entry.expiresAt = at;
    }
  }
  return entry;
};

export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  /** Stores the Set-Cookie headers of one response. */
  absorb(url, setCookieHeaders = []) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    for (const header of setCookieHeaders) {
      const entry = parseSetCookie(header, host);
      if (!entry) continue;
      const key = `${entry.domain}|${entry.path}|${entry.name}`;
      if (entry.expiresAt === 0) {
        this.cookies.delete(key);
        continue;
      }
      if (this.cookies.size >= MAX_COOKIES && !this.cookies.has(key)) {
        // Drop the oldest entry rather than growing without bound.
        const oldest = this.cookies.keys().next().value;
        if (oldest) this.cookies.delete(oldest);
      }
      this.cookies.set(key, entry);
    }
  }

  /** The Cookie header value for a request, '' when nothing matches. */
  header(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return '';
    }
    const now = Date.now();
    const parts = [];
    for (const [key, entry] of this.cookies) {
      if (entry.expiresAt != null && entry.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (entry.hostOnly ? parsed.hostname !== entry.domain : !domainMatches(parsed.hostname, entry.domain)) {
        continue;
      }
      if (!pathMatches(parsed.pathname || '/', entry.path)) continue;
      parts.push(`${entry.name}=${entry.value}`);
    }
    return parts.join('; ');
  }

  clear() {
    this.cookies.clear();
  }
}
