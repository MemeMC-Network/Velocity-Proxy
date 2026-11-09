/**
 * The lightweight engine.
 *
 * No Chromium, no CDP, no frame encoding: a page is fetched once, reduced to a
 * block model and rendered by the viewer. The per-tab cost on the server is the
 * fetch (bounded by LIGHT_MAX_BYTES) plus parsing, and it disappears the moment
 * the response is sent, which is what makes far more concurrent pages possible
 * than one server-side browser per tab.
 */

import { HttpError } from '../errors.js';
import { log } from '../logger.js';
import { extractPage } from './extract.js';
import { fetchResource, isHtmlContentType, isImageContentType } from './fetch.js';

const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.1';

export class LightEngine {
  constructor(config) {
    this.config = config;
    this.cache = new Map();
    this.enabled = config.lightEngine !== false;
  }

  /** Newest-first eviction; tiny, because a page is cheap to fetch again. */
  remember(key, value) {
    const limit = Math.max(0, this.config.lightCacheEntries || 0);
    if (!limit) return;
    this.cache.set(key, { value, expiresAt: Date.now() + (this.config.lightCacheTtlMs || 300_000) });
    while (this.cache.size > limit) {
      const oldest = this.cache.keys().next().value;
      if (oldest == null) break;
      this.cache.delete(oldest);
    }
  }

  async load(url, { jar = null, force = false } = {}) {
    if (!this.enabled) throw new HttpError(503, 'The lightweight engine is disabled on this server');
    if (!force) {
      const cached = this.cache.get(url);
      if (cached && cached.expiresAt > Date.now()) {
        return { ...cached.value, cached: true };
      }
    }

    const response = await fetchResource(url, {
      jar,
      timeoutMs: this.config.lightTimeoutMs,
      maxBytes: this.config.lightMaxBytes,
      accept: HTML_ACCEPT,
    });
    if (!isHtmlContentType(response.contentType)) {
      throw new HttpError(415, `The lightweight engine cannot render ${response.contentType || 'this file'}`);
    }
    if (response.status >= 400) {
      throw new HttpError(response.status === 404 ? 404 : 502, `The destination answered ${response.status}`);
    }

    const started = Date.now();
    const page = extractPage(response.text, response.url);
    const value = {
      url: response.url,
      title: page.title,
      siteName: page.siteName,
      description: page.description,
      blocks: page.blocks,
      words: page.words,
      readingMinutes: page.readingMinutes,
      hints: page.hints,
      meta: {
        status: response.status,
        bytes: response.bytes,
        truncated: response.truncated,
        fetchMs: response.ms,
        extractMs: Date.now() - started,
        scriptCount: page.meta.scriptCount,
      },
    };
    this.remember(url, value);
    if (this.cache.size > 0 && response.bytes > this.config.lightMaxBytes * 0.9) {
      log.debug('light page truncated at byte cap', response.url.slice(0, 90));
    }
    return value;
  }

  /** Proxies one image so the viewer stays same-origin and the guard applies. */
  async asset(url, { jar = null } = {}) {
    const response = await fetchResource(url, {
      jar,
      timeoutMs: this.config.lightTimeoutMs,
      maxBytes: Math.min(this.config.lightMaxBytes, 3_000_000),
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
    });
    if (!isImageContentType(response.contentType)) {
      throw new HttpError(415, 'That resource is not an image');
    }
    return { body: response.body, contentType: response.contentType.split(';')[0].trim(), bytes: response.bytes };
  }

  stats() {
    return { enabled: this.enabled, cached: this.cache.size, maxBytes: this.config.lightMaxBytes };
  }

  clear() {
    this.cache.clear();
  }
}
