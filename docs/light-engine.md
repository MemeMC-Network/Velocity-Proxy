# Two engines: full browser and lightweight

Velocity Proxy now has two ways to produce a page. Both obey the same contract — the address bar
stays on the proxy origin, tabs are server-side objects, there are no iframes and no redirects — but
they cost very different amounts of server resources.

| | Full browser (default) | Lightweight |
| --- | --- | --- |
| Engine | server-side Chromium, CDP screencast | HTTP fetch + HTML extraction |
| Server cost per tab | one `BrowserContext` + renderers (~230 MB measured) | a fetch and a parse (~3 MB measured) |
| Wire cost | JPEG frames, ~23 KB each at ~30 fps on a video-ish page | one JSON payload, ~13 KB for an article |
| JavaScript | runs | does not run |
| Forms, logins, video, canvas, WebAuthn | work | not supported |
| Audio capture, per-person sinks | yes | n/a (no browser to capture) |
| Best for | apps, video, anything interactive | articles, docs, wikis, search results, changelogs |

Switch any tab with the **Full / Light** chip in the toolbar. The tab keeps its id, its URL and its
place in the strip; only the way the page is produced changes.

## What Ultraviolet is, and why it is not inside this codebase

Researched against the current sources before writing anything:

- **Ultraviolet is a service-worker proxy.** A service worker registered at the proxy origin
  intercepts requests for proxied URLs and answers them with rewritten documents, scripts and
  styles, fetched through a transport. Since v3 it uses **bare-mux** to swap transports
  (`EpoxyTransport`, `CurlTransport`, legacy Bare), and the transport speaks **Wisp** over a
  WebSocket to a server that only relays bytes. There is no Chromium anywhere in that path — that
  is the whole reason its overhead is so low: the *visitor's* browser renders and executes the
  destination. ([bare-mux](https://docs.titaniumnetwork.org/transports/bare-mux),
  [EpoxyTransport](https://docs.titaniumnetwork.org/transports/epoxy-transport))
- **Its rendered documents must be framed.** A service worker can only serve a document that the
  browser navigates to. In practice that document is loaded in a child frame (UV's client and
  Scramjet's `ScramjetFrame` both work this way), and the rewrite layer rewrites URLs to that
  document's scope.
- **It is deprecated.** The project page states Ultraviolet is now unmaintained and recommends
  Scramjet; the repository says the same. Scramjet 2.x has also moved off bare-mux to
  proxy-transports. ([Ultraviolet](https://docs.titaniumnetwork.org/proxies/ultraviolet/),
  [repository](https://github.com/titaniumnetwork-dev/Ultraviolet))
- **It is AGPL-3.0.** Both `titaniumnetwork-dev/Ultraviolet` and `Ultraviolet-App` ship the AGPL-3.0.
  Serving a derivative over the network carries source-offer obligations. Velocity Proxy is not
  AGPL, so vendoring those files would change this project's licence. Using their published
  packages as a dependency has the same practical constraint for a networked service.

Two of those are hard blockers for this project, not preferences:

1. **`frame-src 'none'` and "no iframes" are part of the product.** A service-worker proxy cannot
   render a third-party document into our own document; without a frame there is nothing for the
   worker to serve. Adopting UV would mean adding an iframe and relaxing the CSP that the shell
   currently ships.
2. **It could not reuse this UI.** UV produces a live page in a frame, not pixels on a canvas. Tabs,
   zoom, find-in-page, screenshot, audio capture, popup adoption and the input pipeline are all built
   on the screencast model; a UV tab would be a second, differently-behaved surface.

So Ultraviolet was studied, measured against the constraints, and **not integrated**. What was built
instead takes the same central idea — *the server should not run a browser to show an article* —
and implements it inside the existing contract.

## How the lightweight engine works

```
GET /api/light/page?u=…            (authenticated, rate limited, SSRF guarded, byte capped)
        │
        ├─ fetchResource()         manual redirects,每 hop re-validated, 2 MB cap default
        ├─ extractPage()           parse5 → blocks: h1-h6, p, li, blockquote, pre, img
        └─ JSON                    { title, siteName, blocks, words, hints, meta }
                │
                └─ public/js/light.js builds DOM with createElement/textContent
```

Nothing from the destination is ever injected as markup into the proxy origin. The block model is
the security boundary: there is no HTML string to sanitise, no script, no style, no `javascript:`
URL and no frame. Links become `data-href` attributes and are turned into in-app navigation
messages, so a click can never move the top-level document.

### Protocol

| Message | Direction | Meaning |
| --- | --- | --- |
| `light` | server → client | `{ tabId, page }` — the block model for that tab |
| `light:state` | server → client | loading / error / `requiresChromium` for that tab |
| `engine:set` | client → server | switch one tab to `light` or `chromium` |
| `engine` | server → client | the switch completed, with the new tab record |
| `nav`, `back`, `forward`, `reload`, `home` | client → server | routed to the engine the tab is using |

`GET /api/light/page` and `GET /api/light/asset` exist for the same data outside the socket; the
asset route proxies images so the viewer stays same-origin and the SSRF guard still applies.

### Cookies

A light tab has no Chromium profile, so the workspace keeps a small cookie jar (`src/light/cookies.js`)
scoped to that one signed-in visitor: host-only by default, `Domain` accepted only for the host or a
parent, path matched, expired entries dropped, hard cap of 600. Two visitors never share it, and it
is never written to disk.

### Automatic selection

The server marks a page `requiresChromium` when it is a known JavaScript application (TikTok,
YouTube, X, Instagram, Docs, Figma, …), when the title looks like a bot check, when a page has 20+
scripts and almost no text, or when extraction found under 120 characters. The light tab then shows a
banner with **Open in full browser** — it never switches engine on its own, because a silent switch
would lose the visitor's place.

### Switching semantics

- **Full → Light:** the tab's Chromium page is suspended (its storage state is captured first), then
  the same URL is fetched and rendered as blocks. The tab id, URL and order are unchanged.
- **Light → Full:** the same URL is opened in a fresh `BrowserContext`. Cookies from the light jar do
  **not** travel into Chromium, so a site that needs a login has to be signed into again. This is a
  deliberate trade: importing a jar into a browser profile is exactly how cross-user cookie leaks
  happen.
- **History:** light tabs keep their own stack, so Back/Forward work inside light mode; crossing an
  engine switch starts a fresh stack for the new engine.

## Compatibility matrix (verified against real pages during development)

| Page | Light | Notes |
| --- | --- | --- |
| Wikipedia / docs / blogs / news articles | ✅ | headings, lists, quotes, code, images, links |
| Search result pages that render server-side | ✅ | links navigate in-app |
| Marketing pages with real text in the HTML | ✅ | chrome and menus dropped |
| TikTok, YouTube, X, Instagram, web apps | ⚠️ banner | flagged `requiresChromium`; use the full browser |
| Login flows, forms, checkouts | ❌ | no form support |
| Video / canvas / WebGL | ❌ | no script execution |
| Cloudflare / hCaptcha challenges | ⚠️ banner | detected by title; full browser required |

## Limits, stated plainly

- No JavaScript, so anything client-rendered shows whatever text is in the HTML — often none.
- No forms: a page requiring a POST cannot be used in light mode.
- No client-side find-in-page, zoom reflow or screenshot in light mode; those are canvas features.
- CSS is not preserved: the reader applies its own typography to the extracted blocks.
- Light fetches are anonymous apart from the per-visitor cookie jar; no `Referer` chain is built.
- The engine is enabled by default but **never** becomes the default engine for a tab: new tabs open
  in the full browser. `LIGHT_ENGINE=0` removes the chip entirely.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LIGHT_ENGINE` | `1` | Enable the lightweight engine and its routes. |
| `LIGHT_MAX_BYTES` | `2000000` | Largest page body read, enforced while streaming the body. |
| `LIGHT_TIMEOUT_MS` | `15000` | Per-request timeout, including redirects. |
| `LIGHT_CACHE_ENTRIES` | `60` | Extraction cache size (per URL, not per viewer). |
| `LIGHT_CACHE_TTL_SECONDS` | `300` | Cache lifetime. `0` disables caching. |
