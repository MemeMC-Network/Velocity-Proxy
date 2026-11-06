import { config } from './config.js';
import { log } from './logger.js';
import { blockedQueryReason } from './security/content-filter.js';

export const ENGINES = {
  google: {
    name: 'Google',
    search: 'https://www.google.com/search?q=%s',
    safeSearch: '&safe=active',
    suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=%s',
    parseSuggest: (data) => (Array.isArray(data) ? data[1] : []),
  },
  duckduckgo: {
    name: 'DuckDuckGo',
    search: 'https://duckduckgo.com/?q=%s',
    safeSearch: '&kp=1',
    suggest: 'https://duckduckgo.com/ac/?type=list&q=%s',
    parseSuggest: (data) => (Array.isArray(data) ? data.map((item) => item?.phrase).filter(Boolean) : []),
  },
  bing: {
    name: 'Bing',
    search: 'https://www.bing.com/search?q=%s',
    safeSearch: '&adlt=strict',
    suggest: 'https://api.bing.com/osjson.aspx?query=%s',
    parseSuggest: (data) => (Array.isArray(data) ? data[1] : []),
  },
  brave: {
    name: 'Brave',
    search: 'https://search.brave.com/search?q=%s',
    safeSearch: '&safesearch=strict',
    suggest: 'https://search.brave.com/api/suggest?q=%s&source=web',
    parseSuggest: (data) => (Array.isArray(data?.results) ? data.results : Array.isArray(data?.[1]) ? data[1] : []),
  },
  startpage: {
    name: 'Startpage',
    search: 'https://www.startpage.com/sp/search?query=%s',
    suggest: 'https://www.startpage.com/api/suggest?q=%s',
    parseSuggest: (data) => (Array.isArray(data?.suggestions) ? data.suggestions : []),
  },
};

const HOST_LIKE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const IPV4_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:[/?#]\S*)?$/;
const IPV6_LIKE = /^\[[0-9a-f:]+\](?::\d{1,5})?(?:[/?#]\S*)?$/i;
const LOCALHOST_LIKE = /^localhost(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/** Decides whether the address bar text should become a URL or a search query. */
export const looksLikeUrl = (input) => {
  const value = input.trim();
  if (!value || /\s/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return true;
  if (LOCALHOST_LIKE.test(value) || IPV4_LIKE.test(value) || IPV6_LIKE.test(value)) return true;
  return HOST_LIKE.test(value);
};

export const normalizeTarget = (input, { engine = 'google', template = null } = {}) => {
  const value = String(input ?? '').trim();
  if (!value) return null;
  if (value.length > 8000) throw new Error('Input is too long');

  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    return url.href;
  }

  // Reject other schemes outright: never let javascript:/data:/file: through.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !LOCALHOST_LIKE.test(value) && !IPV6_LIKE.test(value)) {
    const scheme = value.split(':')[0].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return searchUrl(value, { engine, template });
  }

  if (looksLikeUrl(value)) return new URL(`https://${value}`).href;
  return searchUrl(value, { engine, template });
};

const searchUrl = (query, { engine, template }) => {
  if (template) {
    validateTemplate(template);
    return template.replace('%s', encodeURIComponent(query));
  }
  const definition = ENGINES[engine] || ENGINES.google;
  const url = definition.search.replace('%s', encodeURIComponent(query));
  // Safe search flags keep explicit results off the results page; the domain
  // blocklist still refuses the sites if someone follows a result link.
  return config.contentFilter && definition.safeSearch ? `${url}${definition.safeSearch}` : url;
};

export const validateTemplate = (template) => {
  if (typeof template !== 'string' || !template.includes('%s')) {
    throw new Error('A custom search URL must contain %s');
  }
  let parsed;
  try {
    parsed = new URL(template.replace('%s', 'test'));
  } catch {
    throw new Error('Custom search URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Custom search URL must use http or https');
  }
  return parsed;
};

const suggestCache = new Map();

export const getSuggestions = async (query, engine = 'google') => {
  const q = String(query ?? '').trim().slice(0, 200);
  if (!q) return [];
  if (blockedQueryReason(q)) return [];
  const definition = ENGINES[engine];
  if (!definition?.suggest) return [];
  const key = `${engine}:${q.toLowerCase()}`;
  const cached = suggestCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.items;

  try {
    const response = await fetch(definition.suggest.replace('%s', encodeURIComponent(q)), {
      signal: AbortSignal.timeout(3500),
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: 'application/json, text/javascript, */*; q=0.01',
      },
      redirect: 'error',
    });
    if (!response.ok) return [];
    const raw = await response.text();
    if (raw.length > 200_000) return [];
    const data = JSON.parse(raw);
    const items = (definition.parseSuggest(data) || [])
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item && item.toLowerCase() !== q.toLowerCase() && !blockedQueryReason(item))
      .slice(0, 8);
    if (suggestCache.size > 500) suggestCache.clear();
    suggestCache.set(key, { items, expiresAt: Date.now() + 60_000 });
    return items;
  } catch (error) {
    log.debug('suggest failed', error.message);
    return [];
  }
};
