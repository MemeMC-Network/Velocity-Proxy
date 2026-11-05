import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPublicHttpUrl } from '../security/ip-guard.js';
import { log } from '../logger.js';
import { shortHash } from '../util.js';

const MAX_ICON_BYTES = 512 * 1024;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sniffType = (buffer) => {
  if (!buffer || buffer.length < 4) return 'image/x-icon';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  const head = buffer.toString('utf8', 0, 12).toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  return 'image/x-icon';
};

/**
 * Host based favicon cache. Icons are fetched server-side (guarded against
 * SSRF), stored on disk and served from the proxy origin so the browser never
 * contacts a third-party host.
 */
export class FaviconCache {
  constructor(directory) {
    this.directory = directory;
    this.memory = new Map();
    fs.mkdir(directory, { recursive: true }).catch(() => {});
  }

  fileFor(host) {
    return path.join(this.directory, `${shortHash(host.toLowerCase(), 24)}.bin`);
  }

  async read(host) {
    const key = host.toLowerCase();
    const cached = this.memory.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached;

    try {
      const file = this.fileFor(key);
      const [stat, buffer] = await Promise.all([fs.stat(file), fs.readFile(file)]);
      if (Date.now() - stat.mtimeMs > MAX_AGE_MS) return null;
      const entry = {
        buffer,
        type: sniffType(buffer),
        hash: shortHash(buffer, 12),
        fresh: true,
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
      this.memory.set(key, entry);
      return entry;
    } catch {
      return null;
    }
  }

  async get(host) {
    return this.read(host);
  }

  async store(host, buffer) {
    if (!buffer || !buffer.length || buffer.length > MAX_ICON_BYTES) return null;
    const key = host.toLowerCase();
    const entry = {
      buffer,
      type: sniffType(buffer),
      hash: shortHash(buffer, 12),
      fresh: true,
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    this.memory.set(key, entry);
    if (this.memory.size > 600) this.memory.clear();
    try {
      await fs.writeFile(this.fileFor(key), buffer);
    } catch (error) {
      log.debug('favicon write failed', error.message);
    }
    return entry;
  }

  /** Fetch an icon URL (with manual redirect checks) and cache it for the host. */
  async fetchAndStore(host, iconUrl) {
    const existing = await this.read(host);
    if (existing) return existing;

    let current = iconUrl;
    for (let hop = 0; hop < 3; hop += 1) {
      let target;
      try {
        target = await assertPublicHttpUrl(current);
      } catch {
        return null;
      }
      let response;
      try {
        response = await fetch(target.href, {
          redirect: 'manual',
          signal: AbortSignal.timeout(6000),
          headers: { 'user-agent': USER_AGENT, accept: 'image/*,*/*;q=0.8' },
        });
      } catch {
        return null;
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return null;
        current = new URL(location, target).href;
        continue;
      }
      if (!response.ok) return null;
      const type = (response.headers.get('content-type') || '').toLowerCase();
      if (type && !type.startsWith('image/') && !type.includes('octet-stream')) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_ICON_BYTES) return null;
      return this.store(host, buffer);
    }
    return null;
  }

  /** Best effort fetch of https://host/favicon.ico for history entries. */
  async fetchDirect(host) {
    if (!/^[a-z0-9.-]+$/i.test(host)) return null;
    return this.fetchAndStore(host, `https://${host}/favicon.ico`);
  }
}
