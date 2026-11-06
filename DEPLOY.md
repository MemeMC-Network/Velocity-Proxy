# Deploying Velocity Proxy

Velocity Proxy is a **stateful, long-running server**: one Node process keeps live Chromium
instances (one per signed-in session when per-session audio is on), WebSocket streams for frames and
audio, and on-disk tab/cookie state.

That shape rules out Vercel Functions (and Netlify Functions, Cloudflare Pages Functions, AWS
Lambda): those run request/response handlers with no WebSocket upgrade, no persistent process
between requests, no writable disk, and bundle limits far below a Chromium build. There is no
configuration that makes this app run correctly on Vercel — anything that appeared to work would
be faking the browser or the stream.

Everything below runs the real thing in a container, in one step.

## Docker (any host)

```bash
ACCESS_PASSWORD='choose-something-strong' docker compose up -d --build
# → http://localhost:8080
```

`docker-compose.yml` mounts a named volume for `/data` (tabs, cookies, session secret) and builds
the image with Chromium, ffmpeg and PulseAudio. Put the service behind HTTPS (Caddy, Nginx,
Traefik, or your platform's load balancer) so session cookies work inside iframes.

Audio is per session by default: every signed-in visitor gets a Chromium process, a PulseAudio sink
and a capture of their own, so nobody hears another visitor's tabs. That costs one browser per
concurrent session — on a 1 GB host set `AUDIO_PER_SESSION=0` to keep a single shared browser and
one shared capture instead.

Memory and CPU are bounded either way: `MAX_LIVE_BROWSERS` caps concurrent Chromium processes (idle
sessions are evicted first), `MAX_LIVE_TABS` caps live pages, `BROWSER_IDLE_SECONDS` frees a
disconnected session's browser, `SCREENCAST_FPS` limits frame encoding, and unwatched tabs are
polled every `IDLE_POLL_MS` instead of every 1.1 s.

`PUBLIC_ORIGIN` is optional but recommended once you have a domain:

```env
ACCESS_PASSWORD=choose-something-strong
PUBLIC_ORIGIN=https://proxy.example.com
```

## Render (closest one-click equivalent)

1. Push this repository to GitHub.
2. Render → **New → Blueprint** → select the repo. `render.yaml` is detected.
3. Deploy. Render builds the `Dockerfile`, provisions a 2 GB disk at `/data`, generates
   `ACCESS_PASSWORD` (visible in the service's Environment tab) and serves HTTPS.
4. Set `PUBLIC_ORIGIN` to the assigned `https://<service>.onrender.com` URL (or your domain).

A paid instance type is required: the free tier sleeps, has no disk and too little RAM for
Chromium.

## Railway

1. New Project → **Deploy from GitHub repo** (the `Dockerfile` is used automatically).
2. Add a volume mounted at `/data`.
3. Variables: `ACCESS_PASSWORD`, and optionally `PUBLIC_ORIGIN`, `FRAME_ANCESTORS`.
4. Generate a domain. `railway.json` sets the restart policy.

## Fly.io

```bash
fly launch --no-deploy          # keeps the provided fly.toml
fly volumes create velocity_data --size 2
fly secrets set ACCESS_PASSWORD='choose-something-strong' PUBLIC_ORIGIN='https://<app>.fly.dev'
fly deploy
```

## Plain VPS

`sudo bash install.sh --domain proxy.example.com --email you@example.com` installs Node, Chromium,
ffmpeg, PulseAudio, the `velocity_sink` null sink, systemd and Nginx with TLS (see README).

## Embedding the proxy in your site

Once the deployment is reachable over HTTPS:

```html
<iframe
  src="https://proxy.example.com/"
  title="Velocity Proxy"
  allow="autoplay; fullscreen; clipboard-write"
  referrerpolicy="no-referrer"
  style="width: 100%; height: 720px; border: 0; border-radius: 12px"
></iframe>
```

Notes:

- The server sends `Content-Security-Policy: frame-ancestors *` and no `X-Frame-Options`, so any
  origin may frame it. Restrict with `FRAME_ANCESTORS=https://your-site.example` when you want only
  your own pages to embed it.
- Inside a cross-site frame the session cookie must be `SameSite=None; Secure`; the server does this
  automatically when it sees HTTPS (`PUBLIC_ORIGIN=https://…` or `X-Forwarded-Proto: https`).
  Plain-HTTP deployments keep `SameSite=Lax` and only work top-level or same-site.
- If the embedding browser blocks unpartitioned third-party cookies (Safari ITP, Chrome with 3P
  cookies disabled), set `EMBED_PARTITIONED_COOKIES=1` to use CHIPS. Each top-level site then gets
  its own isolated session, which is usually the desired behaviour for an embedded widget.
- A page opened from disk (`file://`) can only frame the proxy if the scheme is listed:
  `FRAME_ANCESTORS=* file:`. CSP's `*` deliberately does not match non-network schemes, so the
  frame is refused otherwise. The proxy is still served over HTTPS, so cookies and the WebSocket
  work normally.
- `allow="autoplay"` lets the audio stream start after the visitor's first click inside the frame.
- Audio is isolated per session: a visitor hears only the tabs of their own login, never those of
  someone else using the same deployment. Each session has its own Chromium process, so budget RAM
  accordingly; `AUDIO_PER_SESSION=0` restores one shared browser and capture.
- The address bar of the *top* page is never touched: navigation, tabs and refreshes all happen
  inside the framed document, whose URL stays at `/`.
