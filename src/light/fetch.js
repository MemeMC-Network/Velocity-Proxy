/**
 * Fetching for the lightweight engine.
 *
 * The light engine has no browser to enforce policy, so every hop is validated
 * here with the same SSRF guard the Chromium path uses, and responses are read
 * through a byte cap instead of being buffered whole: a proxy must not let one
 * destination decide how much memory it uses.
 */

import { assertPublicHttpUrl, isBlockedUrl } from '../security/ip-guard.js';
import { blockedUrlReason } from '../security/content-filter.js';
import { HttpError } from '../errors.js';

const MAX_REDIRECTS = 5;

const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Charset from the Content-Type header, else from a <meta> sniff, else utf-8. */
const charsetOf = (contentType, preview) => {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = preview.slice(0, 2048).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return (fromMeta?.[1] || 'utf-8').toLowerCase();
};

const decode = (buffer, charset) => {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
};

/** Reads a response body, stopping at the cap instead of trusting Content-Length. */
const readCapped = async (response, maxBytes) => {
  if (!response.body) return { buffer: Buffer.alloc(0), bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (bytes - maxBytes))));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { buffer: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), bytes, truncated };
};

const decodeLocation = (value) => {
  try {
    return new URL(value, 'http://placeholder.invalid').href;
  } catch {
    return null;
  }
};

/**
 * Fetches one URL with redirects followed manually so each hop is validated.
 * Returns the final URL, status, content type and a capped body.
 */
export const fetchResource = async (
  rawUrl,
  { jar = null, timeoutMs = 15_000, maxBytes = 2_000_000, accept = '*/*', referer = null } = {},
) => {
  let url = await assertPublicHttpUrl(rawUrl);
  const started = Date.now();
  let cookies = '';

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (blockedUrlReason(url.href)) throw new HttpError(403, 'That destination is blocked by the content filter');
    if (await isBlockedUrl(url.href)) {
      throw new HttpError(403, 'That destination resolves to a private or reserved address');
    }

    const headers = {
      'user-agent': DESKTOP_UA,
      accept,
      'accept-language': 'en-US,en;q=0.9',
      // No accept-encoding here: undici negotiates gzip/br itself and decodes
      // the response. Setting it by hand would hand back compressed bytes.
      ...(referer ? { referer } : {}),
    };
    cookies = jar ? jar.header(url.href) : '';
    if (cookies) headers.cookie = cookies;

    let response;
    try {
      response = await fetch(url.href, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        credentials: 'omit',
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? 'The destination took too long to answer' : 'Could not reach that destination';
      throw new HttpError(504, reason);
    }

    if (jar) {
      const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      jar.absorb(url.href, setCookies);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new HttpError(502, 'The destination redirected without a location');
      let next;
      try {
        next = new URL(location, url.href);
      } catch {
        throw new HttpError(502, 'The destination sent an invalid redirect');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new HttpError(400, 'Only http:// and https:// destinations are supported');
      }
      url = next;
      referer = url.href;
      continue;
    }

    const contentType = response.headers.get('content-type') || '';
    const { buffer, bytes, truncated } = await readCapped(response, maxBytes);
    return {
      url: url.href,
      status: response.status,
      contentType,
      bytes,
      truncated,
      ms: Date.now() - started,
      body: buffer,
      charset: charsetOf(contentType, buffer),
      text: decode(buffer, charsetOf(contentType, buffer)),
    };
  }

  throw new HttpError(502, 'Too many redirects');
};

/** True when a content type can be rendered by the light engine. */
export const isHtmlContentType = (contentType) =>
  /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i.test(String(contentType || '').trim());

export const isImageContentType = (contentType) =>
  /^image\/(png|jpeg|jpg|gif|webp|avif|bmp|svg\+xml)\b/i.test(String(contentType || '').trim());

export { decodeLocation };
