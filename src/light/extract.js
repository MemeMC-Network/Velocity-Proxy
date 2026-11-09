/**
 * HTML → structured blocks for the lightweight engine.
 *
 * Third-party HTML is never handed to the client: it is parsed here and turned
 * into a small block model (headings, paragraphs, lists, quotes, code, images)
 * that the viewer renders with its own DOM calls. That removes the whole class
 * of injection bugs a sanitizer would have to get exactly right, and it keeps
 * the payload roughly an order of magnitude smaller than the page.
 */

import { parse } from 'parse5';

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link',
  'svg', 'canvas', 'iframe', 'object', 'embed', 'video', 'audio', 'source',
  'form', 'button', 'select', 'option', 'input', 'textarea',
  'nav', 'footer', 'aside',
]);

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'figcaption', 'dd', 'dt']);

// Site chrome that is not content. Matched against class and id, so an article
// wrapper called "article-body" is kept while "sidebar" and "cookie-banner" go.
const NOISE =
  /(^|[-_\s])(nav|navbar|nav-|menu|sidebar|side-bar|footer|comments?|banner|promo|advert|advertisement|ads?|sponsor|share|social|cookie|consent|breadcrumb|subscribe|newsletter|related|recommend|popup|modal|toolbar|skip-link|byline-social)([-_\s]|$)/i;

const MAX_BLOCKS = 500;
const MAX_NODES = 120_000;
const MAX_RUNS = 400;

const isElement = (node) => Boolean(node && node.tagName);
const attr = (node, name) => (node.attrs || []).find((entry) => entry.name === name)?.value;
const classAndId = (node) => `${attr(node, 'class') || ''} ${attr(node, 'id') || ''}`;
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const absolute = (href, base) => {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

/** Raw text of a <pre>, keeping its newlines. */
const rawText = (node, budget) => {
  let out = '';
  const visit = (current) => {
    for (const child of current.childNodes || []) {
      if (budget.nodes++ > MAX_NODES) return;
      if (child.nodeName === '#text') out += child.value;
      else if (isElement(child)) {
        if (child.tagName === 'br') out += '\n';
        else if (!SKIP_TAGS.has(child.tagName)) visit(child);
      }
    }
  };
  visit(node);
  return out.replace(/\n{3,}/g, '\n\n').trim();
};

const normalizeRuns = (runs) => {
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    const key = run.img ? null : JSON.stringify([run.b, run.i, run.code, run.href]);
    if (last && !run.img && !last.img && JSON.stringify([last.b, last.i, last.code, last.href]) === key) {
      last.text = clean(`${last.text} ${run.text}`);
      if (!last.text) merged.pop();
      continue;
    }
    merged.push(run);
  }
  return merged
    .map((run) => (run.img ? run : { ...run, text: clean(run.text) }))
    .filter((run) => run.img || run.text || run.br)
    .slice(0, MAX_RUNS);
};

/** Inline content of one block, with bold/italic/code/link runs preserved. */
const collectRuns = (node, base, style, runs, budget) => {
  for (const child of node.childNodes || []) {
    if (budget.nodes++ > MAX_NODES) return runs;
    if (child.nodeName === '#text') {
      const value = clean(child.value);
      if (value) runs.push({ text: value, ...style });
      continue;
    }
    if (!isElement(child)) continue;
    const tag = child.tagName;
    if (SKIP_TAGS.has(tag)) continue;
    if (tag === 'br') {
      runs.push({ br: true });
      continue;
    }
    if (tag === 'img') {
      const src = absolute(attr(child, 'src') || attr(child, 'data-src'), base);
      if (src) runs.push({ img: src, alt: clean(attr(child, 'alt')) });
      continue;
    }
    const next = { ...style };
    if (tag === 'b' || tag === 'strong') next.b = true;
    if (tag === 'i' || tag === 'em') next.i = true;
    if (tag === 'code' || tag === 'kbd' || tag === 'samp') next.code = true;
    if (tag === 'a') {
      const href = absolute(attr(child, 'href'), base);
      if (href) next.href = href;
    }
    collectRuns(child, base, next, runs, budget);
  }
  return runs;
};

const pushBlock = (blocks, type, node, base, budget, extra = {}) => {
  if (blocks.length >= MAX_BLOCKS) return;
  const runs = normalizeRuns(collectRuns(node, base, extra.style || {}, [], budget));
  const text = runs.map((run) => run.text || '').join(' ').trim();
  const hasImage = runs.some((run) => run.img);
  if (!text && !hasImage) return;
  blocks.push({ type, ...extra, runs });
};

/** Does this element contain any element that becomes its own block? */
const hasBlockChild = (node, budget, depth = 0) => {
  if (depth > 8) return true;
  for (const child of node.childNodes || []) {
    if (!isElement(child) || SKIP_TAGS.has(child.tagName)) continue;
    if (BLOCK_TAGS.has(child.tagName) || child.tagName === 'table' || child.tagName === 'img') return true;
    if (budget.nodes++ > MAX_NODES) return true;
    if (hasBlockChild(child, budget, depth + 1)) return true;
  }
  return false;
};

const pushTable = (table, blocks, base, budget) => {
  const rows = [];
  const visit = (node) => {
    for (const child of node.childNodes || []) {
      if (!isElement(child)) continue;
      if (budget.nodes++ > MAX_NODES) return;
      if (child.tagName === 'tr') {
        const cells = [];
        for (const cell of child.childNodes || []) {
          if (isElement(cell) && (cell.tagName === 'td' || cell.tagName === 'th')) {
            const runs = normalizeRuns(collectRuns(cell, base, {}, [], budget));
            const text = runs.map((run) => run.text || '').join(' ').trim();
            if (text) cells.push(text);
          }
        }
        if (cells.length) rows.push(cells.join(' · '));
      } else {
        visit(child);
      }
    }
  };
  visit(table);
  for (const row of rows.slice(0, 60)) {
    if (blocks.length >= MAX_BLOCKS) return;
    blocks.push({ type: 'p', runs: [{ text: row }] });
  }
};

const walk = (node, ctx) => {
  for (const child of node.childNodes || []) {
    if (!isElement(child)) continue;
    if (ctx.budget.nodes++ > MAX_NODES || ctx.blocks.length >= MAX_BLOCKS) return;
    const tag = child.tagName;
    if (SKIP_TAGS.has(tag)) continue;

    if (tag === 'img') {
      const src = absolute(attr(child, 'src') || attr(child, 'data-src'), ctx.base);
      if (src && ctx.blocks.length < MAX_BLOCKS) {
        ctx.blocks.push({ type: 'img', runs: [{ img: src, alt: clean(attr(child, 'alt')) }] });
      }
      continue;
    }
    if (tag === 'table') {
      pushTable(child, ctx.blocks, ctx.base, ctx.budget);
      continue;
    }
    if (NOISE.test(classAndId(child)) && tag !== 'article' && tag !== 'main') continue;

    if (BLOCK_TAGS.has(tag)) {
      if (tag === 'pre') {
        const text = rawText(child, ctx.budget);
        if (text && ctx.blocks.length < MAX_BLOCKS) ctx.blocks.push({ type: 'pre', text });
        continue;
      }
      pushBlock(ctx.blocks, tag, child, ctx.base, ctx.budget, tag[0] === 'h' ? { level: Number(tag[1]) || 2 } : {});
      continue;
    }

    // A container with nothing block-like inside is one paragraph; otherwise
    // recurse so its paragraphs keep their own structure.
    if (!hasBlockChild(child, ctx.budget)) {
      pushBlock(ctx.blocks, 'p', child, ctx.base, ctx.budget);
      continue;
    }
    walk(child, ctx);
  }
};

const findBody = (document) => {
  const html = (document.childNodes || []).find((node) => isElement(node) && node.tagName === 'html');
  return (html?.childNodes || []).find((node) => isElement(node) && node.tagName === 'body') || document;
};

/** Prefers the semantic content root so navigation and footers are skipped. */
const findRoot = (body) => {
  let article = null;
  let main = null;
  const visit = (node, depth) => {
    if (depth > 40 || (article && main)) return;
    for (const child of node.childNodes || []) {
      if (!isElement(child)) continue;
      if (child.tagName === 'article' && !article) article = child;
      else if (child.tagName === 'main' && !main) main = child;
      visit(child, depth + 1);
    }
  };
  visit(body, 0);
  // Whichever comes first in the document wins; <article> is usually the story.
  return article || main || body;
};

const metaContent = (head, selector) => {
  for (const node of head.childNodes || []) {
    if (!isElement(node) || node.tagName !== 'meta') continue;
    const property = attr(node, 'property') || attr(node, 'name');
    if (property && selector.test(property)) return clean(attr(node, 'content'));
  }
  return '';
};

const titleText = (head) => {
  for (const node of head.childNodes || []) {
    if (isElement(node) && node.tagName === 'title') {
      return clean((node.childNodes || []).map((child) => child.value || '').join(''));
    }
  }
  return '';
};

const countScripts = (node, counter = { count: 0 }, depth = 0) => {
  if (depth > 60) return counter.count;
  for (const child of node.childNodes || []) {
    if (!isElement(child)) continue;
    if (child.tagName === 'script') counter.count += 1;
    countScripts(child, counter, depth + 1);
  }
  return counter.count;
};

const APP_HOSTS = [
  /(^|\.)tiktok\.com$/i, /(^|\.)youtube\.com$/i, /(^|\.)youtu\.be$/i, /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i, /(^|\.)instagram\.com$/i, /(^|\.)facebook\.com$/i, /(^|\.)netflix\.com$/i,
  /(^|\.)spotify\.com$/i, /(^|\.)discord\.com$/i, /(^|\.)twitch\.tv$/i, /(^|\.)roblox\.com$/i,
  /(^|\.)docs\.google\.com$/i, /(^|\.)mail\.google\.com$/i, /(^|\.)web\.whatsapp\.com$/i,
  /(^|\.)figma\.com$/i, /(^|\.)notion\.so$/i, /(^|\.)canva\.com$/i, /(^|\.)store\.steampowered\.com$/i,
];

const CHALLENGE_TITLE = /(just a moment|attention required|are you a robot|checking your browser|access denied)/i;

/**
 * Which pages the light engine should not pretend to render. The caller shows a
 * banner offering the Chromium engine instead of switching silently, so the
 * visitor keeps their place.
 */
const assess = ({ url, text, scriptCount, title }) => {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* invalid url */
  }
  if (APP_HOSTS.some((pattern) => pattern.test(host))) {
    return { requiresChromium: true, reason: 'This site is a JavaScript application' };
  }
  if (CHALLENGE_TITLE.test(title)) {
    return { requiresChromium: true, reason: 'This site is showing a bot check' };
  }
  if (scriptCount >= 20 && text.length < 400) {
    return { requiresChromium: true, reason: 'This page needs JavaScript to show its content' };
  }
  if (text.length < 120) {
    return { requiresChromium: true, reason: 'Almost no readable text was found on this page' };
  }
  return { requiresChromium: false, reason: null };
};

/** Parses one HTML document into the block model the viewer renders. */
export const extractPage = (html, url) => {
  const document = parse(String(html || ''));
  const head = (document.childNodes || [])
    .flatMap((node) => node.childNodes || [])
    .find((node) => isElement(node) && node.tagName === 'head');
  const body = findBody(document);
  const root = findRoot(body);

  const budget = { nodes: 0 };
  const blocks = [];
  walk(root, { blocks, budget, base: url });

  const title = titleText(head) || metaContent(head, /^(og:title|twitter:title)$/i) || '';
  const description = metaContent(head, /^(description|og:description|twitter:description)$/i);
  const siteName = metaContent(head, /^(og:site_name|application-name)$/i);
  const scriptCount = countScripts(document);
  const text = blocks
    .map((block) => (block.text || '').trim() || (block.runs || []).map((run) => run.text || '').join(' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = text ? text.split(/\s+/).length : 0;

  return {
    title: title || url,
    siteName,
    description,
    blocks,
    words,
    readingMinutes: Math.max(1, Math.round(words / 220)),
    hints: assess({ url, text, scriptCount, title }),
    meta: { scriptCount, textLength: text.length },
  };
};
