# Velocity Proxy

A real browser running inside a website. Chromium renders the page on the server, streamed as
frames to a canvas, with mouse, wheel and keyboard input forwarded over one WebSocket.

The address bar never leaves the proxy origin. There are **no iframes**, no `window.open()` to
destinations, no redirects and no screenshots of pages: every destination is loaded by Chromium
inside a per-tab browser context and drawn into `<canvas>` on `https://proxy.example.com`.

```
Browser (proxy.example.com)                    Server
┌─────────────────────────────┐                ┌──────────────────────────────┐
│ tab bar · omnibox · canvas  │  WS (1 sock)   │ Express + ws                 │
│ canvas ← JPEG frames        │ ◀────────────  │  └ Workspace (1 per user)    │
│ mouse/key/wheel → messages  │  ────────────▶ │      └ BrowserContext per tab│
└─────────────────────────────┘                │          └ Chromium page     │
                                               └──────────────────────────────┘
```

Nothing in the client can navigate the top-level document away from the proxy: tab ids and
destinations live in server-side workspace state and travel over the WebSocket, so the address bar
always reads the proxy origin (`http://127.0.0.1:8092/` in development, `https://proxy.example.com/`
in production). There is no tab path, query parameter or hash to bookmark, and the client never
calls `history.pushState()` / `history.replaceState()`. Refreshing the page reattaches to the same
workspace through the session cookie and restores the previously active tab.

## Embedding

You can drop the proxy into any page with an iframe:

```html
<iframe
  src="https://proxy.example.com/"
  title="Velocity Proxy"
  allow="autoplay; fullscreen; clipboard-write"
  referrerpolicy="no-referrer"
  style="width: 100%; height: 720px; border: 0; border-radius: 12px"
></iframe>
```

A page opened straight from disk (`file:///…/page.html`) needs the scheme listed explicitly, because
CSP's `*` never matches non-network schemes: set `FRAME_ANCESTORS=* file:`. Cookies and the
WebSocket then behave exactly as they do for a hosted page, since the frame itself is still served
over HTTPS.

The shell sends `Content-Security-Policy: frame-ancestors *` and no `X-Frame-Options`, so it can be
framed by any origin (`FRAME_ANCESTORS=https://your-site.example` narrows this, `FRAME_ANCESTORS=none`
brings back `DENY`). Over HTTPS the session cookie is issued as `SameSite=None; Secure`, which is what
makes sign-in work inside a cross-site frame; set `EMBED_PARTITIONED_COOKIES=1` to use CHIPS when the
browser blocks unpartitioned third-party cookies (each embedding site then gets its own session).
`allow="autoplay"` is required for the audio stream to start after the visitor's first click. The
top-level page's address bar is never touched.

## Features

**Browser shell**
- Tabs: create, close, switch, duplicate, pin, middle-click close, context menu, `Ctrl+T` /
  `Ctrl+W` / `Ctrl+Tab` / `Ctrl+1…8`, titles and favicons from the live page, per-tab history.
- Omnibox: URL vs. query detection, automatic `https://`, destination title + host metadata,
  loading progress, history and live search suggestions, copy destination URL, `Ctrl+L`.
- Navigation: back, forward, reload, stop, home, error page with the failing URL.
- Sessions survive a page refresh: the server persists tabs and the active tab id, and the client
  reattaches over the WebSocket — the URL stays on the root path.

**Interface**
A quiet, typographic shell — hairline surfaces, one warm accent, a serif greeting — with a centered
search and engine chip (Google, DuckDuckGo, Bing, Brave, Startpage or a custom `%s` template),
editable shortcut tiles, a **Continue** row of the tabs you still have open, history grouped by day,
frequent-site chips, add/edit/remove shortcuts, light/dark theme and layouts that hold down to phone
widths. `Ctrl+K` opens a command palette over open tabs, history, shortcuts and browser commands;
a toolbar activity panel (`/api/stats`) shows server memory, live browsers and pages against their
caps, sessions, audio streams and uptime, and releases idle Chromium processes on demand
(`/api/reclaim`). Browsing adds page zoom (`Ctrl` +/-/`0`, a real reflow of the remote page),
fullscreen (`F11`, or a button), a screenshot capture that saves the remote page as JPEG, and
automatic edge-to-edge layout when a page enters HTML fullscreen.

**Rendering**
Per-tab `BrowserContext` (isolated cookies, localStorage, cache, permissions), CDP
`Page.startScreencast` JPEG frames, adaptive quality, popups adopted as proxy tabs, downloads
cancelled.

**Audio**
Each signed-in session gets its own Chromium process and its own PulseAudio null sink, captured by its
own ffmpeg instance (DirectShow loopback on Windows), encoded to WebM/Opus and streamed over
`/ws/audio`; the client plays it through Media Source Extensions. Audio is therefore per person: two
visitors never hear each other's tabs. Audio starts on the first interaction (autoplay-safe) with a
clear prompt if the browser blocks it. The toolbar has a global mute button, each tab has its own mute button and an
indicator when it is producing sound, the settings drawer has a volume slider and audio status, and
inactive tabs are muted inside the page so streams never leak between tabs. Capture stops after the
last listener disconnects and when a tab closes.

## Requirements

- Linux (Ubuntu 22.04+/Debian 12+) for production; Node.js 20+ anywhere for development.
- ~1 GB RAM per few concurrent tabs; Chromium is CPU-hungry on video-heavy sites.
- `ffmpeg` with libopus, plus PulseAudio or PipeWire on Linux for audio capture (the installer sets
  both up). Windows development needs a loopback capture device in `AUDIO_DEVICE`.
- Node dependencies: `express`, `ws`, `playwright`, `compression`, `dotenv`.
- For deployment: Docker (or the provided Render/Railway/Fly configs) — see [`DEPLOY.md`](DEPLOY.md).

## Install (Ubuntu / Debian VPS)

```bash
sudo bash install.sh
```

The installer:

1. Verifies Ubuntu/Debian + systemd.
2. Installs base packages (including `ffmpeg`, `pulseaudio` and `pulseaudio-utils`), Node.js 22 LTS
   (NodeSource) and Playwright's Chromium libraries.
3. Creates the unprivileged `velocity` system user (`/var/lib/velocity-proxy`).
4. Copies the project to `/opt/velocity-proxy`, runs `npm install --omit=dev`, downloads Chromium
   as the service user.
5. Asks for the domain, Let's Encrypt email and access password (or generates a strong password).
6. Writes `/opt/velocity-proxy/.env` (mode 0640, `root:velocity`).
7. Configures Nginx with WebSocket upgrade headers for `/ws`, then runs Certbot for HTTPS and the
   port-80 → 443 redirect.
8. Installs and starts `velocity-proxy.service`, health-checks `/api/info`, and prints the URL and
   the generated password.

The unit starts `scripts/start-with-audio.sh`, which brings up a private PulseAudio instance and
loads the `velocity_sink` null sink. Chromium plays into that sink and ffmpeg records its monitor
(`AUDIO_DEVICE=velocity_sink.monitor`), so audio works on a VPS with no sound card and no manual
device configuration.

Non-interactive and HTTP-only modes:

```bash
sudo bash install.sh --domain proxy.example.com --email you@example.com --password 'secret' -y
sudo bash install.sh --no-ssl --port 8080     # plain HTTP on port 80, no Certbot
```

Certificate renewal is Certbot's systemd timer (`certbot.timer`), which reloads Nginx after
renewal; no project-specific cron is needed.

### Bare Debian 12 (Bookworm) server, SSH only

Nothing has to be built beforehand and no desktop is needed: the installer pulls Node.js,
Chromium, ffmpeg and PulseAudio from the distro and starts everything with systemd. Run it as root
(`su -` on images that ship without `sudo`).

1. Put the sources on the server from your workstation (in the project directory):

   ```bash
   tar --exclude=node_modules --exclude='.data*' --exclude=.env --exclude=.git -czf velocity-proxy.tar.gz .
   scp velocity-proxy.tar.gz root@203.0.113.10:/root/
   ```

   Or push the project to a Git host and `git clone` it on the server. Do not copy `node_modules`
   or a Windows-made `.env`.

2. Unpack and install. Point the domain's `A`/`AAAA` record at the server first, otherwise Certbot
   cannot validate it:

   ```bash
   apt-get update && apt-get install -y tar
   mkdir -p /root/velocity-src && tar -xzf /root/velocity-proxy.tar.gz -C /root/velocity-src
   cd /root/velocity-src
   bash install.sh --domain proxy.example.com --email you@example.com --non-interactive -y
   ```

   Without a domain, `bash install.sh --no-ssl --non-interactive -y` serves plain HTTP on port 80
   (`http://<server-ip>/`). That is fine for a private test, but cross-site iframe embedding and the
   `SameSite=None` cookie need HTTPS.

   Expect roughly 700 MB of downloads (Node.js, Chromium and its libraries), so give the box at
   least 2 GB of free disk and 1 GB of RAM.

3. Check it:

   ```bash
   systemctl status velocity-proxy --no-pager
   curl -s http://127.0.0.1:8080/api/info        # "ok":true
   journalctl -u velocity-proxy -f               # live logs; Chromium and audio messages
   runuser -u velocity -- env XDG_RUNTIME_DIR=/run/velocity-proxy pactl list short sinks
   ```

   The last command should list `velocity_sink` — that is the null sink Chromium plays into and
   ffmpeg records. If your provider has a cloud firewall, allow TCP 22, 80 and 443.

4. To update later: extract a new tarball over `/root/velocity-src` and re-run
   `bash install.sh --non-interactive -y`. The existing `.env` (password, session secret) is
   preserved, dependencies and Chromium are refreshed and the unit restarts. `bash
   /opt/velocity-proxy/update.sh` does the same without re-copying sources; its `--pull` flag only
   applies if you cloned the repository directly into `/opt/velocity-proxy` yourself.

Container deploys (Render, Railway, Fly.io, plain Docker) are documented in [`DEPLOY.md`](DEPLOY.md).
Vercel Functions cannot host this app: they have no WebSocket upgrades, no long-running Chromium
process and no persistent disk.

## Run from source

```bash
npm install
npx playwright install chromium
cp .env.example .env          # edit ACCESS_PASSWORD etc.
npm start                     # or: npm run dev (watch mode)
```

Open `http://127.0.0.1:8080`, sign in with `ACCESS_PASSWORD`.

## Configuration (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Bind address; keep loopback behind Nginx. |
| `PUBLIC_ORIGIN` | – | Exact HTTPS origin; used for cookies and Origin checks. |
| `TRUST_PROXY` | `1` | Proxy hops in front of the app. |
| `AUTH_MODE` | `password` | `password` or `none` (the latter requires `ALLOW_NO_AUTH=1`). |
| `ACCESS_PASSWORD` | – | Login password. Generated by the installer when empty. |
| `SESSION_SECRET` | auto | HMAC key for session tokens; persisted in `DATA_DIR` when unset. |
| `SESSION_TTL_DAYS` | `30` | Session lifetime. |
| `ALLOW_NO_AUTH` | `0` | Explicit opt-in for an unauthenticated proxy; refused on public interfaces. |
| `MAX_TABS` / `MAX_SESSIONS` | `12` / `40` | Per user / global live Chromium contexts. |
| `TAB_IDLE_MINUTES` | `10` | Idle tabs are suspended (state saved, context closed). |
| `BROWSER_IDLE_SECONDS` | `180` | A session with no connected visitor loses its Chromium process, audio sink and ffmpeg after this long; tabs reload on reconnect. |
| `MAX_LIVE_BROWSERS` | `6` | Cap on concurrent Chromium processes. Only sessions with no connected visitor are evicted, least recently active first. |
| `MAX_LIVE_TABS` | `16` | Cap on live pages across all sessions; the least recently used tab without viewers is suspended. |
| `SCREENCAST_FPS` | `30` | Maximum frames pushed to viewers per second. Chromium skips the intermediate frames in the compositor, so they are never JPEG-encoded (at 30 fps this measured ~28% less browser CPU than encoding every frame), and the client drops anything still over the cap. |
| `IDLE_POLL_MS` | `5000` | Page polling interval for tabs nobody is watching; `1100` while watched. |
| `CHROMIUM_JS_HEAP_MB` | `512` | V8 old-space cap per renderer, so one heavy page cannot grow without bound. `0` keeps Chromium's default. |
| `NAV_TIMEOUT_MS` | `45000` | Navigation timeout. |
| `FRAME_QUALITY` | `62` | Initial JPEG quality (1–90), adapts to back-pressure. |
| `VIEWPORT_MAX_WIDTH/HEIGHT` | `1920` / `1200` | Caps for the remote viewport. |
| `BROWSER_MODE` | `headless` | `headless` or `headed` (needs X/xvfb). |
| `CHROMIUM_PATH` | – | Use a system Chromium instead of Playwright's build. |
| `CHROMIUM_SANDBOX` | `auto` | `auto`, `on`, `off`; `auto` turns it off only when it cannot work (e.g. root). |
| `CHROMIUM_ARGS` / `USER_AGENT` | – | Extra flags / UA override. |
| `AUDIO_ENABLED` | `1` | Stream browser audio to the visitor. |
| `AUDIO_SOURCE` | `auto` | `pulse`, `dshow`, `tone` or `off`; `auto` uses PulseAudio on Linux. |
| `AUDIO_DEVICE` | – | `velocity_sink.monitor` on Linux, or a DirectShow loopback device on Windows. |
| `AUDIO_FFMPEG_PATH` | `ffmpeg` | ffmpeg binary (needs libopus). |
| `AUDIO_BITRATE_KBPS` | `64` | Opus bitrate, 24–160. |
| `AUDIO_PULSE_SERVER` / `AUDIO_PULSE_SINK` | – | PulseAudio server/sink for Chromium's output. |
| `AUDIO_PER_SESSION` | `1` | One browser process, sink and capture per session (per-person audio). `0` shares one capture to save RAM. |
| `AUDIO_PACTL_PATH` | `pactl` | Used to create and unload the per-session sinks. |
| `FRAME_ANCESTORS` | `*` | CSP `frame-ancestors`: who may embed the shell. Add `file:` for local HTML pages. `none` sends `X-Frame-Options: DENY`. |
| `EMBED_PARTITIONED_COOKIES` | `0` | Use partitioned cookies (CHIPS) for third-party-iframe sessions. |
| `SSRF_GUARD` | `routes` | `routes` inspects every request; `nav` only top-level navigations. |
| `ALLOW_PRIVATE_TARGETS` | `0` | Development only: allow loopback/private destinations. |
| `RATE_LIMIT_PER_MINUTE` | `240` | Per-IP budget for HTTP APIs and WebSocket upgrades. |
| `CONTENT_FILTER` | `1` | Block adult domains and explicit search terms, and force safe search on the built-in engines. |
| `CONTENT_FILTER_BLOCK` | – | Extra blocked hosts, comma separated, suffix matched (`foo.com` also blocks `www.foo.com`). |
| `CONTENT_FILTER_ALLOW` | – | Hosts the filter must never block; wins over the built-in list and `CONTENT_FILTER_BLOCK`. |
| `CONTENT_FILTER_TERMS` | – | Extra blocked search terms (whole words), added to the built-in list. |
| `DATA_DIR` | `.data` | Sessions, tab metadata, secrets, favicon cache. |
| `LOG_LEVEL` | `info` | `debug` logs tab lifecycle and page errors. |

## Operations

```bash
systemctl start velocity-proxy
systemctl stop velocity-proxy
systemctl restart velocity-proxy
systemctl status velocity-proxy
journalctl -u velocity-proxy -f
```

- `sudo bash update.sh` copies the new code, reinstalls production dependencies, verifies Chromium,
  restarts the service and health-checks it.
- `sudo bash uninstall.sh` stops/disables the unit, removes the Nginx site and the service file.
  Add `--purge` to also delete `/opt/velocity-proxy`, `/var/lib/velocity-proxy` (all sessions and
  cookies) and the Let's Encrypt certificate for the domain.
- `bash start.sh` runs the app in the foreground with `.env` loaded (no systemd), for debugging.

## How it works

- **Sessions.** A signed, `HttpOnly` cookie (`velocity_session`, HMAC-SHA256, expiring) gates the
  SPA, `/api/*` and the WebSocket upgrade. It is `SameSite=Lax`, or `SameSite=None; Secure` when the
  proxy is served over HTTPS so a cross-site iframe can authenticate (add `EMBED_PARTITIONED_COOKIES=1`
  for CHIPS). The upgrade additionally requires a same-origin `Origin` header and passes the IP rate
  limiter.
- **Root URL.** Tabs are addressed only by internal ids inside WebSocket messages (`tab:create`,
  `tab:activate`, …). The server stores `activeTabId` next to the tab list in the workspace file and
  returns it from `/api/session`; the client never writes the address bar, and legacy `/b/*`,
  `/tab/*` and `/browser/*` links are redirected to `/`.
- **Tabs.** `WorkspaceManager` launches one Chromium process per workspace (when per-session audio is
  on) and creates one `BrowserContext` per tab. Each tab keeps its own URL/title/loading/pinned/muted state in
  `DATA_DIR/workspaces/<id>.json`; cookies and localStorage are saved with Playwright
  `storageState` so a suspended or restarted tab resumes signed in.
- **Audio.** Chromium launches without Playwright's `--mute-audio`. With `AUDIO_PER_SESSION=1`
  (default) every workspace gets its own Chromium process launched with `PULSE_SINK=velocity_<hash>`;
  the sink is created on demand with `pactl` and removed when the browser closes. `AudioService` runs
  one ffmpeg per session (`-f pulse -i velocity_<hash>.monitor -c:a libopus -f webm`) and sends that
  stream only to `/ws/audio` sockets carrying the same session, so each visitor hears their own
  tabs. Frames are dropped when a socket is backpressured; capture starts on the first listener and
  stops 12 s after the last one leaves (capped at 64 kbps). Without `pactl`, on Windows DirectShow,
  or with `AUDIO_PER_SESSION=0`, one shared capture is used instead. Only the active tab is unmuted:
  `TabSession.setMuted()` mutes every `audio`/`video` element in the page (and re-applies it on
  play), so background tabs stay silent without a per-tab mixer.
- **Frames.** The active tab runs `Page.startScreencast`; frames are packed as
  `magic "VXFP" (0x56584650) | version 1 | id length | tab id | JPEG` and sent over the tab's single
  WebSocket. The client decodes with `createImageBitmap` and draws to canvas; only the active tab
  streams, so switching tabs costs no reload.
- **Input.** Pointer, wheel and key events are translated to CDP `Input.*` calls with the canvas
  scaling factored in. Text uses `Input.insertText`; special keys use a US-layout code map.
  Popups (`window.open`, `target=_blank`) are adopted as new proxy tabs — the real browser window
  never opens them.
- **Search.** Queries are expanded server-side into the selected engine's URL; suggestions are
  proxied through an allowlist of engine endpoints so the client never talks to them directly.
- **SSRF.** `assertPublicHttpUrl` rejects non-http(s) schemes, credentials in URLs, and
  private/reserved/loopback/link-local addresses (including `169.254.169.254`) after DNS
  resolution, with a short-lived DNS cache. In `routes` mode every request of every context, plus
  WebSocket handshakes, is re-validated, so redirects and subresources cannot reach internal
  services either.
- **Content filter.** With `CONTENT_FILTER=1` (default) a target is refused when its host is on the
  built-in adult list or `CONTENT_FILTER_BLOCK`, or when a search query (or a query in a search
  engine URL) contains an explicit term; `CONTENT_FILTER_ALLOW` exempts hosts. The check runs when
  the address bar resolves a target, on every main-frame navigation, and in the same request route
  that enforces SSRF (`SSRF_GUARD=routes`, the default), so links, redirects, popups, WebSockets and
  embedded resources cannot load a blocked host either. A blocked navigation blanks the page and shows the tab's error overlay
  instead of rendering the content, and it is never added to history. Built-in engines append
  safe-search flags (`safe=active`, `adlt=strict`, `kp=1`, `safesearch=strict`) and YouTube gets its
  restricted-mode cookie.

## Cloud gaming (GeForce NOW and similar WebRTC apps)

`play.geforcenow.com` now renders through the proxy and reaches its sign-in screen. Two things were
in the way:

- The remote browser advertised `HeadlessChrome` in its UA string and Client Hints. Every context now
  presents a desktop Chrome identity (UA, `navigator.userAgentData` brands and high-entropy values
  agree); `USER_AGENT` still overrides the string if you need a different platform.
- The stealth script replaced `navigator.plugins` with `[1,2,3,4,5]`, and the GeForce NOW client
  threw `Cannot read properties of undefined (reading 'implementationType')` and left the app root
  empty. It now exposes plugin objects with `name`/`description`/`filename`, the shape real Chrome
  uses, so the SPA boots.

GeForce NOW can still print "You're not using a recommended browser". On this machine that notice
survives with the UA, Client Hints, plugins and `navigator.webdriver` each masked, so it is not
headless detection; the remaining difference is that the server renders with SwiftShader (no GPU).
It is a warning, not a block, but software H.264 decode is CPU-hungry, so a host with a GPU is the
right place for gaming sessions. The bundled Chromium already decodes H.264/AAC and offers H.264 in
WebRTC, so no extra browser build is required.

For a smoother session:

```
SCREENCAST_FPS=60      # frame rate of the JPEG stream; costs CPU per frame
FRAME_QUALITY=70       # sharper starting point before adaptation
```

The quality slider in Settings (or the palette's quality commands) now locks the value: before, a
manual choice was pulled back down by the adaptive downscaler within a few seconds. A locked value
stays put for that tab, and fullscreen plus pointer capture work through the existing canvas.

What it cannot fix: the game video is decoded by the server's Chromium and re-encoded as JPEG, so
there is one extra encode hop and frame granularity of 1/`SCREENCAST_FPS` on top of the NVIDIA round
trip - fine on a nearby data centre, not equal to the native client. Gamepads are not bridged (the
Gamepad API reads devices attached to the server, and none are), so pick titles that accept
keyboard and mouse, and DRM/Widevine content stays unavailable. Starting a real game needs an NVIDIA
account, so a live streaming session was not exercised here; the page, browser check and login flow
were.

## Verification

`npm run smoke` boots the real server with a throwaway data dir, a local target site and
`AUDIO_SOURCE=tone`, then drives the HTTP + WebSocket protocol end to end. It covers 37 assertions:
unauthenticated API/WS refusal, the `SameSite=None; Secure` login cookie, root SPA route,
`frame-ancestors *` / no `X-Frame-Options` / `autoplay=*` (iframe embedding), legacy tab-path
redirects, favicon
SSRF refusal, real Chromium render + binary frames, title/URL tracking, navigation and
back/forward, search expansion, text and key input reaching the remote DOM, tab
pin/duplicate/close, `activeTabId` persistence, per-tab mute round-trip, a live Opus/WebM audio
stream (ffmpeg → socket → EBML header), a separate capture for each session, refusal of
unauthenticated audio sockets, a screencast that stops receiving frames while the viewer reports it
is hidden and resumes on return, the auth-guarded `/api/stats` snapshot, cross-origin refusal on
`/api/reclaim`, the absence of
iframes/`window.open`/`history.pushState` in the client sources, SSRF unit checks, URL detection,
the content filter (blocked domain, explicit query, blocked in-page link), and a fingerprint check
that the remote browser does not present itself as headless.
The suite passed 37/37 on this machine (Chromium 156 headless, Node 22, ffmpeg 8.0.1).

Manual checks against the live UI (same build):

| Check | Result |
| --- | --- |
| Homepage, engine chip, shortcuts, recent/frequent, theme, settings | Rendered; suggestions and history populate |
| Command palette, activity panel | `Ctrl+K` searches tabs/history and runs commands; the panel reports live counters |
| `example.com`, `en.wikipedia.org`, `youtube.com`, `tiktok.com` | Rendered inside the canvas with correct titles/hosts |
| URL bar stays on the proxy | `location.pathname` stayed `/` through create, navigate, switch, refresh and close |
| No iframes anywhere | `document.querySelectorAll('iframe').length === 0` in the shell |
| Tabs: new, switch, close, duplicate, pin, restore after reload | Work; reload restored both tabs and the active tab |
| Audio playback | Live Opus stream decoded by MSE; `currentTime` advanced in realtime with `readyState 4` |
| Mute / volume | Toolbar mute sets `audio.muted`, the volume slider drives `audio.volume` and persists |
| Embedded in a cross-origin iframe | Framed shell rendered; every asset and `/api/session` returned 200 inside the frame |
| Back / forward / reload / stop, history per tab | Work (Wikipedia → example.com → Wikipedia) |
| Google search + suggestions | Query reached Google; the datacenter IP got a reCAPTCHA instead of results |
| Responsive layout | Desktop and 430 px layouts both behave (toolbar items collapse on narrow screens) |

Not verifiable on the Windows development machine: the systemd unit, Nginx/TLS and Certbot
renewal. The scripts pass `bash -n`; install/update/uninstall follow standard Ubuntu layouts but
should be exercised on a throwaway VPS before production.

## Limitations (honest list)

- **Framing is open by default.** `frame-ancestors *` lets any site embed the proxy (handy for a
  widget, but it also means the login form can be clickjacked). Set
  `FRAME_ANCESTORS=https://your-site.example` or `none` in production if the proxy is private.
- **Audio needs a capture device.** Linux uses the installer's PulseAudio null sink; on Windows set
  `AUDIO_DEVICE` to a loopback device. Opus over WebSocket trails the video by roughly 0.2–1 s, and
  the stream is one mix per workspace: tabs are silenced inside the page rather than mixed as
  separate streams.
- **Real site audio was not audibly verified on this Windows dev machine** (it has no PulseAudio
  monitor). The full transport was verified with ffmpeg's generated tone: the browser decoded the
  Opus/WebM stream and playback advanced in realtime.
- **Video is frame-streamed**, not WebRTC: playback works but smoothness depends on CPU, bandwidth
  and the site's player. DRM/Widevine is unavailable, so Netflix/Spotify-style content will not play.
- **Downloads are cancelled and file-upload pickers are not bridged** — downloading or uploading
  files through the proxy is not supported in this version.
- **Datacenter IPs get challenged.** Google served a reCAPTCHA to this test host; YouTube/TikTok may
  show consent or login walls. That is the site's bot policy, not a proxy failure.
- **Headless fingerprinting.** Some sites behave differently for headless Chromium; a few may block
  automated browsers outright.
- **The content filter is a blocklist, not a classifier.** It stops the listed adult hosts and
  obvious search terms and turns on safe search, but a page served from a host outside the list, or
  a site's own internal search box, is not judged. Add hosts with `CONTENT_FILTER_BLOCK`.
- **No browser extensions, DevTools, passkeys/WebAuthn, or native print dialogs.**
- Tabs are per user and capped (`MAX_TABS`, `MAX_SESSIONS`); heavy video tabs cost real CPU/RAM.
- Idle work is capped too: `MAX_LIVE_BROWSERS` / `MAX_LIVE_TABS` bound how many Chromium
  processes and pages exist at once, `BROWSER_IDLE_SECONDS` frees a disconnected session's browser,
  `SCREENCAST_FPS` limits frame encoding — frames above the cap are skipped in the compositor, so
  they are never encoded at all — and unwatched tabs are polled every `IDLE_POLL_MS` instead of
  every 1.1 s. Favicon refreshes are throttled to once per host per minute.
- The UI redraws only the tab bar and home tiles it must: chrome, tiles and cards are plain CSS
  with no backdrop blur or continuously animating decoration, so sitting on the home page costs
  nothing until you type.
- The UI ships as ES modules without a build step; a hard refresh may be needed after upgrading a
  running instance (assets are served `Cache-Control: no-cache` and revalidate by ETag).

## Project layout

```
src/
  server.js              Express app, auth gate, static assets, WS attach
  config.js              env parsing + validation
  auth.js                HMAC session tokens, cookies, same-origin checks
  search.js              engines, URL/query detection, suggestions proxy
  security/ip-guard.js   SSRF validation + DNS cache
  security/content-filter.js  adult domain blocklist + explicit search terms
  security/rate-limit.js per-IP limiter
  browser/workspaces.js  Chromium launch, contexts, tab records, persistence
  browser/tab.js         TabSession: screencast, navigation, input, dialogs
  browser/keys.js        key map (US layout) for CDP input
  browser/favicon.js     favicon fetch + cache
  audio/service.js       ffmpeg capture, Opus/WebM fan-out to /ws/audio
  ws/handler.js          authenticated socket protocol
public/
  index.html, css/app.css, css/audio.css
  js/{app,store,net,ui,icons,viewport,home,settings,audio}.js
deploy/
  nginx-velocity.conf, velocity-proxy.service
scripts/
  start-with-audio.sh    PulseAudio null sink + service entrypoint
  smoke-test.mjs         37-check end-to-end suite
install.sh · uninstall.sh · update.sh · start.sh
```

## Troubleshooting

- **Chromium fails to launch**: run `npx playwright install-deps chromium` and
  `npx playwright install chromium` as the service user, or set `CHROMIUM_PATH=/usr/bin/chromium`.
- **Blank canvas**: check `journalctl -u velocity-proxy -f`; a `pageerror` line is the site's own
  JS. Verify `PUBLIC_ORIGIN` matches the URL (cookies/Origin checks depend on it).
- **WebSocket disconnects behind a proxy**: Nginx must forward `Upgrade`/`Connection` for `/ws`
  (the provided config does) and must not buffer (`proxy_buffering off`).
- **401 after login**: the cookie is `Secure` on HTTPS; make sure you are not mixing HTTP and HTTPS
  origins, and that `TRUST_PROXY` matches your setup.
- **No audio**: check `curl -H 'Cookie: …' https://your-host/api/audio` for `status`/`reason`.
  `unavailable` usually means ffmpeg is missing or the capture device name is wrong. On Linux,
  confirm the sink exists (`pactl list short sinks`, looking for `velocity_sink`) and that
  `AUDIO_DEVICE` names its monitor (`velocity_sink.monitor`). On Windows, list DirectShow devices
  with `ffmpeg -f dshow -list_devices true -i dummy` and put a loopback device in `AUDIO_DEVICE`.
  Use `AUDIO_SOURCE=tone` to prove the browser → WebSocket → Opus path independently of capture.
