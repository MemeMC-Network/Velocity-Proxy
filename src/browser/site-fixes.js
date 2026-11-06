/**
 * Small, explicit per-site compatibility shims.
 *
 * These exist because a proxied browser cannot fix a site's own bug: TikTok's
 * `/search?q=` page currently ships a worker script that 404s, so its results
 * grid sits on skeleton tiles forever, while `/discover/<term>` renders the
 * same kind of grid from the server. Rewriting the document request keeps the
 * search box usable instead of showing an endless loading state.
 *
 * Every rewrite stays on the same origin and keeps the query term.
 */

const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com']);

const slugify = (value) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/** Rewrites a document target that is known to be broken server-side, or null. */
export const rewriteDocumentTarget = (rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!TIKTOK_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.pathname !== '/search' && url.pathname !== '/search/video') return null;
  const term = url.searchParams.get('q');
  if (!term) return null;
  const slug = slugify(term);
  if (!slug) return null;
  return `https://www.tiktok.com/discover/${slug}`;
};
