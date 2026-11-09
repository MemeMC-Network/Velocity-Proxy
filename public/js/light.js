/**
 * Viewer for the lightweight engine.
 *
 * The server never sends HTML: it sends blocks, and everything here is built
 * with createElement/textContent. A hostile page can therefore not inject
 * markup into the proxy origin, and there is no iframe anywhere in this path.
 */

const dom = {};
let navigate = () => {};
let currentTabId = null;
let lastFocus = null;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** One inline run: plain text, bold/italic/code, a link, or an image. */
const runNode = (run) => {
  if (run.img) {
    const figure = el('figure', 'light-figure');
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.decoding = 'async';
    image.alt = run.alt || '';
    image.src = `/api/light/asset?u=${encodeURIComponent(run.img)}`;
    image.addEventListener('error', () => figure.remove(), { once: true });
    figure.append(image);
    if (run.alt) figure.append(el('figcaption', 'light-caption', run.alt));
    return figure;
  }
  if (run.br) return document.createElement('br');
  let node = document.createTextNode(run.text || '');
  if (run.code) {
    const code = el('code', 'light-code');
    code.append(node);
    node = code;
  }
  if (run.i) {
    const em = el('em');
    em.append(node);
    node = em;
  }
  if (run.b) {
    const strong = el('strong');
    strong.append(node);
    node = strong;
  }
  if (run.href) {
    const link = el('a', 'light-link');
    link.href = run.href;
    link.dataset.href = run.href;
    link.append(node);
    return link;
  }
  return node;
};

const blockNode = (block) => {
  if (block.type === 'pre') {
    const pre = el('pre', 'light-pre');
    pre.textContent = block.text || '';
    return pre;
  }
  if (block.type === 'img') {
    const wrap = el('div', 'light-image-block');
    for (const run of block.runs || []) wrap.append(runNode(run));
    return wrap;
  }
  const tag = /^h[1-6]$/.test(block.type) ? block.type : block.type === 'blockquote' ? 'blockquote' : block.type === 'li' ? 'li' : 'p';
  const node = el(tag, `light-block light-${block.type}`);
  for (const run of block.runs || []) node.append(runNode(run));
  return node;
};

const listify = (blocks) => {
  const out = [];
  let list = null;
  for (const block of blocks) {
    if (block.type === 'li') {
      if (!list) {
        list = el('ul', 'light-list');
        out.push(list);
      }
      list.append(blockNode(block));
      continue;
    }
    list = null;
    out.push(blockNode(block));
  }
  return out;
};

const shell = () => dom.shell;

const renderBanner = (text, { label, action }) => {
  const banner = el('div', 'light-banner');
  banner.append(el('span', 'light-banner-text', text));
  const button = el('button', 'light-banner-btn', label);
  button.type = 'button';
  button.addEventListener('click', action);
  banner.append(button);
  return banner;
};

const renderFrame = ({ title, subtitle, blocks, notices = [] }) => {
  const article = el('article', 'light-doc');
  const header = el('header', 'light-head');
  if (subtitle) header.append(el('span', 'light-kicker', subtitle));
  header.append(el('h1', 'light-title', title));
  article.append(header);
  for (const notice of notices) article.append(notice);
  const body = el('div', 'light-body');
  for (const node of listify(blocks || [])) body.append(node);
  article.append(body);
  shell().replaceChildren(article);
};

export const initLightView = ({ onNavigate } = {}) => {
  navigate = typeof onNavigate === 'function' ? onNavigate : () => {};
  dom.view = document.getElementById('light-view');
  dom.shell = document.getElementById('light-shell');
  if (!dom.view) return;

  // One delegated listener: links are data-href, never real navigations, so the
  // address bar cannot leave the proxy origin.
  dom.view.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[data-href]');
    if (!link) return;
    event.preventDefault();
    const href = link.dataset.href;
    if (href) navigate(href);
  });
  dom.view.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const link = event.target.closest?.('a[data-href]');
    if (!link?.dataset.href) return;
    event.preventDefault();
    navigate(link.dataset.href);
  });

  // Links open on click only; middle-click would otherwise navigate the shell.
  dom.view.addEventListener('auxclick', (event) => {
    if (event.button === 1 && event.target.closest?.('a[data-href]')) event.preventDefault();
  });
};

export const hideLight = () => {
  if (!dom.view || dom.view.hidden) return;
  dom.view.hidden = true;
  lastFocus = null;
  currentTabId = null;
};

export const lightVisible = () => Boolean(dom.view && !dom.view.hidden);

/** Renders a light tab: page, skeleton, or error, always in the same surface. */
export const showLight = (tab, page, summary = null) => {
  if (!dom.view) return;
  dom.view.hidden = false;
  currentTabId = tab?.id || null;

  const switched = lastFocus !== currentTabId;
  const previousScroll = switched ? 0 : dom.view.scrollTop;
  lastFocus = currentTabId;

  if (page) {
    const notices = [];
    if (page.hints?.requiresChromium) {
      notices.push(
        renderBanner(
          `${page.hints.reason || 'This page needs JavaScript'}. The full browser engine can render it.`,
          {
            label: 'Open in full browser',
            action: () => {
              window.dispatchEvent(
                new CustomEvent('velocity:engine-request', { detail: { tabId: currentTabId, engine: 'chromium' } }),
              );
            },
          },
        ),
      );
    }
    renderFrame({
      title: page.title || tab?.title || 'Untitled',
      subtitle: [page.siteName, page.words ? `${page.words.toLocaleString()} words` : '', page.readingMinutes ? `${page.readingMinutes} min read` : '']
        .filter(Boolean)
        .join(' · '),
      blocks: page.blocks,
      notices,
    });
    dom.view.scrollTop = previousScroll;
    return;
  }

  if (summary?.error) {
    const article = el('article', 'light-doc');
    article.append(el('span', 'light-kicker', 'Lightweight engine'));
    article.append(el('h1', 'light-title', 'This page could not be loaded'));
    article.append(el('p', 'light-block', summary.error));
    const actions = el('div', 'light-actions');
    const retry = el('button', 'light-banner-btn', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('velocity:light-retry', { detail: { tabId: currentTabId } }));
    });
    const fallback = el('button', 'light-banner-btn ghost', 'Open in full browser');
    fallback.type = 'button';
    fallback.addEventListener('click', () => {
      window.dispatchEvent(
        new CustomEvent('velocity:engine-request', { detail: { tabId: currentTabId, engine: 'chromium' } }),
      );
    });
    actions.append(retry, fallback);
    article.append(actions);
    shell().replaceChildren(article);
    return;
  }

  // Loading skeleton: the page is one request, so this is brief, but a slow
  // host should look like it is working rather than like a blank tab.
  const article = el('article', 'light-doc is-loading');
  article.append(el('span', 'light-kicker', 'Lightweight engine'));
  article.append(el('h1', 'light-title', tab?.title && tab.title !== 'New Tab' ? tab.title : 'Loading page…'));
  for (const width of ['92%', '86%', '94%', '72%', '88%']) {
    const line = el('div', 'light-skeleton-line');
    line.style.width = width;
    article.append(line);
  }
  article.append(el('p', 'light-block light-hint', 'Fetching and extracting the page. No server browser is involved.'));
  shell().replaceChildren(article);
};

export const renderLightError = (message) => {
  if (!dom.view) return;
  dom.view.hidden = false;
  const article = el('article', 'light-doc');
  article.append(el('h1', 'light-title', 'This page could not be loaded'));
  article.append(el('p', 'light-block', message || 'Unknown error'));
  shell().replaceChildren(article);
};

