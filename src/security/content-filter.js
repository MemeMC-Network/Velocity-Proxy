import { config } from '../config.js';

/**
 * Optional content filter (CONTENT_FILTER, on by default).
 *
 * Two independent layers:
 *  - a domain blocklist, checked before a navigation and again in the request
 *    route every context installs (SSRF_GUARD=routes), so links, redirects,
 *    popups, WebSockets and subresources cannot load a blocked host either;
 *  - an explicit-term check for search queries and for search-engine URLs,
 *    which is what stops someone typing a term into the address bar.
 *
 * Safe-search flags are added to the built-in engines (see search.js) and
 * YouTube gets its restricted-mode cookie. This is a household/office filter,
 * not a classifier: it keeps known sites and obvious searches out and cannot
 * judge every page on the open web.
 */

const BUILTIN_DOMAINS = [
  'pornhub.com',
  'pornhub.org',
  'pornhub.net',
  'xvideos.com',
  'xvideos.es',
  'xnxx.com',
  'xhamster.com',
  'xhamster.desi',
  'xhwebsite.com',
  'xhopen.com',
  'redtube.com',
  'youporn.com',
  'porn.com',
  'porn300.com',
  'pornhd.com',
  'beeg.com',
  'spankbang.com',
  'eporner.com',
  'txxx.com',
  'tnaflix.com',
  'tube8.com',
  'keezmovies.com',
  'extremetube.com',
  'drtuber.com',
  'hqporner.com',
  'hdzog.com',
  'porntrex.com',
  'xfantazy.com',
  'jable.tv',
  'missav.com',
  'motherless.com',
  'erome.com',
  'fapello.com',
  'thothub.tv',
  'nudostar.com',
  'sex.com',
  'adultfriendfinder.com',
  'onlyfans.com',
  'fansly.com',
  'chaturbate.com',
  'stripchat.com',
  'camsoda.com',
  'cam4.com',
  'bongacams.com',
  'livejasmin.com',
  'myfreecams.com',
  'imlive.com',
  'brazzers.com',
  'realitykings.com',
  'bangbros.com',
  'mofos.com',
  'nhentai.net',
  'hentaihaven.xxx',
  'hanime.tv',
  'e-hentai.org',
  'exhentai.org',
  'rule34.xxx',
  'rule34.paheal.net',
  'e621.net',
  'literotica.com',
  'asstr.org',
];

/** Unambiguous terms only: a false positive hides legitimate research. */
const BUILTIN_TERMS = [
  'porn',
  'porno',
  'pornography',
  'pornhub',
  'xvideos',
  'xnxx',
  'xhamster',
  'redtube',
  'youporn',
  'spankbang',
  'brazzers',
  'onlyfans',
  'chaturbate',
  'hentai',
  'nhentai',
  'rule34',
  'nsfw',
  'nude',
  'nudes',
  'naked',
  'camgirl',
  'camgirls',
  'sexcam',
  'xxx',
];

/** Only these get their URL query scanned, so article titles stay reachable. */
const SEARCH_HOSTS = [
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'search.brave.com',
  'startpage.com',
  'search.yahoo.com',
  'yandex.com',
  'yandex.ru',
  'ecosia.org',
  'youtube.com',
  'm.youtube.com',
];

export const filterEnabled = Boolean(config.contentFilter);

const normalize = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');

const safeDecode = (value) => {
  const raw = String(value ?? '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const allowedByAdmin = (domain, allow) =>
  allow.some((entry) => domain === entry || domain.endsWith(`.${entry}`));

const buildDomains = () => {
  const allow = config.contentFilterAllow.map(normalize).filter(Boolean);
  const extra = config.contentFilterBlock.map(normalize).filter(Boolean);
  const set = new Set();
  for (const raw of [...BUILTIN_DOMAINS, ...extra]) {
    const domain = normalize(raw);
    if (!domain || allowedByAdmin(domain, allow)) continue;
    set.add(domain);
  }
  return set;
};

const DOMAINS = buildDomains();

const TERMS = [
  ...new Set([...BUILTIN_TERMS, ...config.contentFilterTerms].map(normalize).filter(Boolean)),
];
const TERM_PATTERN = TERMS.length
  ? new RegExp(`(?<![a-z0-9])(?:${TERMS.map(escapeRegex).join('|')})(?![a-z0-9])`, 'i')
  : null;

export const blockedDomains = () => [...DOMAINS];

export const isBlockedHost = (hostname) => {
  if (!filterEnabled) return false;
  const host = normalize(hostname);
  if (!host) return false;
  const labels = host.split('.');
  for (let index = 0; index < labels.length; index += 1) {
    if (DOMAINS.has(labels.slice(index).join('.'))) return true;
  }
  return false;
};

export const blockedMessage = (label) =>
  `${label || 'That site'} is blocked by the content filter.`;

/** Why a navigation target must not load, or null. */
export const blockedUrlReason = (rawUrl) => {
  if (!filterEnabled || !rawUrl) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = normalize(url.hostname);
  if (isBlockedHost(host)) return blockedMessage(host);
  if (!TERM_PATTERN) return null;
  const isSearch = SEARCH_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!isSearch) return null;
  const text = safeDecode(`${url.pathname} ${url.search}`).replace(/\+/g, ' ');
  return TERM_PATTERN.test(text) ? 'That search is blocked by the content filter.' : null;
};

/** Why a typed search query must not be sent, or null. */
export const blockedQueryReason = (query) => {
  if (!filterEnabled || !TERM_PATTERN) return null;
  const text = safeDecode(query);
  if (!text.trim()) return null;
  return TERM_PATTERN.test(text) ? 'That search is blocked by the content filter.' : null;
};
