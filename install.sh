#!/usr/bin/env bash
# ===========================================================================
#  Velocity Proxy — automated installer for Ubuntu / Debian
#
#    sudo bash install.sh
#    sudo bash install.sh --domain proxy.example.com --email you@example.com
#    sudo bash install.sh --domain proxy.example.com --email you@example.com --password 'secret' --non-interactive
#    sudo bash install.sh --no-ssl          # HTTP only (localhost testing)
# ===========================================================================
set -Eeuo pipefail

APP_NAME="velocity-proxy"
APP_USER="velocity"
INSTALL_DIR="/opt/velocity-proxy"
DATA_DIR="/var/lib/velocity-proxy/data"
NGINX_SITE="/etc/nginx/sites-available/velocity-proxy"
SERVICE_FILE="/etc/systemd/system/velocity-proxy.service"
NODE_MAJOR="22"
PORT="8080"

DOMAIN=""
EMAIL=""
ACCESS_PASSWORD=""
NO_SSL=0
NON_INTERACTIVE=0
ASSUME_YES=0

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --------------------------------------------------------------------- output
C_RESET="\033[0m"; C_DIM="\033[2m"; C_BOLD="\033[1m"
C_BLUE="\033[38;5;111m"; C_GREEN="\033[38;5;114m"; C_YELLOW="\033[38;5;179m"; C_RED="\033[38;5;203m"
step() { printf "\n${C_BLUE}==>${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$*"; }
info() { printf "    %s\n" "$*"; }
ok()   { printf "    ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn() { printf "    ${C_YELLOW}!${C_RESET} %s\n" "$*"; }
die()  { printf "\n${C_RED}✗ %s${C_RESET}\n" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Velocity Proxy installer

Usage: sudo bash install.sh [options]

  --domain <domain>       Public domain for the proxy (e.g. proxy.example.com)
  --email <email>         Email for Let's Encrypt registration
  --password <password>   Access password (generated when omitted)
  --no-ssl                Skip Nginx + Let's Encrypt; run HTTP only
  --port <port>           Local port for the Node process (default 8080)
  --non-interactive       Never prompt; use flags and defaults
  -y, --yes               Assume yes for package installation prompts
  -h, --help              Show this help

Examples:
  sudo bash install.sh
  sudo bash install.sh --domain proxy.example.com --email admin@example.com
  sudo bash install.sh --no-ssl --port 8080
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --password) ACCESS_PASSWORD="${2:-}"; shift 2 ;;
    --port) PORT="${2:-8080}"; shift 2 ;;
    --no-ssl) NO_SSL=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done

# ------------------------------------------------------------------ pre-flight
[[ "${EUID}" -eq 0 ]] || die "Run the installer as root:  sudo bash install.sh"

if [[ ! -f "${SRC_DIR}/package.json" || ! -d "${SRC_DIR}/src" ]]; then
  die "install.sh must live inside the Velocity Proxy project directory."
fi

[[ -r /etc/os-release ]] || die "Cannot read /etc/os-release; unsupported system."
# shellcheck disable=SC1091
. /etc/os-release
OS_ID="${ID:-unknown}"
OS_LIKE="${ID_LIKE:-}"
if [[ "${OS_ID}" != "ubuntu" && "${OS_ID}" != "debian" && "${OS_LIKE}" != *debian* ]]; then
  die "Unsupported distribution '${OS_ID}'. Ubuntu or Debian is required."
fi
command -v systemctl >/dev/null 2>&1 || die "systemd is required."

printf "\n${C_BOLD}Velocity Proxy installer${C_RESET}\n"
info "Distribution : ${PRETTY_NAME:-$OS_ID}"
info "Source       : ${SRC_DIR}"
info "Install to   : ${INSTALL_DIR}"

if [[ "${NON_INTERACTIVE}" -eq 0 && -t 0 ]]; then
  if [[ -z "${DOMAIN}" && "${NO_SSL}" -eq 0 ]]; then
    printf "\nDomain for the proxy (leave empty to skip SSL): "
    read -r DOMAIN
  fi
  if [[ -n "${DOMAIN}" && "${NO_SSL}" -eq 0 && -z "${EMAIL}" ]]; then
    printf "Email for Let's Encrypt certificates: "
    read -r EMAIL
  fi
  if [[ -z "${ACCESS_PASSWORD}" ]]; then
    printf "Access password (leave empty to generate one): "
    read -r -s ACCESS_PASSWORD
    printf "\n"
  fi
fi

DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
if [[ -n "${DOMAIN}" && "${NO_SSL}" -eq 0 && -z "${EMAIL}" ]]; then
  warn "No SSL email supplied — skipping Let's Encrypt and serving HTTP."
  NO_SSL=1
fi
if [[ -n "${DOMAIN}" && "${NO_SSL}" -eq 0 && "${DOMAIN}" != *.* ]]; then
  warn "'${DOMAIN}' does not look like a public domain — skipping Let's Encrypt."
  NO_SSL=1
fi

# ------------------------------------------------------------------- packages
step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
APT_FLAGS=(-y -qq -o Dpkg::Options::=--force-confold)
apt-get install "${APT_FLAGS[@]}" \
  ca-certificates curl gnupg lsb-release apt-transport-https \
  nginx certbot python3-certbot-nginx \
  unzip tar rsync \
  ffmpeg pulseaudio pulseaudio-utils \
  fonts-liberation fonts-noto-color-emoji
# Chromium's shared libraries are installed by `playwright install-deps` below;
# the audio library name differs between Debian 12 and Ubuntu 24.04.
apt-get install "${APT_FLAGS[@]}" libasound2t64 >/dev/null 2>&1 \
  || apt-get install "${APT_FLAGS[@]}" libasound2 >/dev/null 2>&1 \
  || true
ok "Base packages installed"

if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]]; then
  ok "Node.js $(node -v) already installed"
else
  step "Installing Node.js ${NODE_MAJOR} LTS"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install "${APT_FLAGS[@]}" nodejs
  ok "Node.js $(node -v) installed"
fi
command -v npm >/dev/null 2>&1 || die "npm is missing after installing Node.js"

# ----------------------------------------------------------------------- user
step "Creating the service account"
if id -u "${APP_USER}" >/dev/null 2>&1; then
  ok "User '${APP_USER}' already exists"
else
  useradd --system --create-home --home-dir /var/lib/velocity-proxy \
    --shell /usr/sbin/nologin "${APP_USER}"
  ok "Created system user '${APP_USER}' (no login shell)"
fi
install -d -m 0750 -o "${APP_USER}" -g "${APP_USER}" /var/lib/velocity-proxy
install -d -m 0750 -o "${APP_USER}" -g "${APP_USER}" "${DATA_DIR}"

# ---------------------------------------------------------------------- files
step "Installing application files"
install -d -m 0755 "${INSTALL_DIR}"
rsync -a --delete \
  --exclude node_modules --exclude '.data*' --exclude .env --exclude .git \
  "${SRC_DIR}/" "${INSTALL_DIR}/"
chown -R root:"${APP_USER}" "${INSTALL_DIR}"
chmod -R g+rX "${INSTALL_DIR}"
chmod +x "${INSTALL_DIR}/scripts/start-with-audio.sh" 2>/dev/null || true
ok "Copied project to ${INSTALL_DIR}"

step "Installing Node dependencies"
cd "${INSTALL_DIR}"
npm install --omit=dev --no-audit --no-fund --loglevel=error
ok "Dependencies installed"

step "Installing Chromium for Playwright"
if npx playwright install-deps chromium >/dev/null 2>&1; then
  ok "Chromium system libraries installed"
else
  warn "playwright install-deps reported an issue; continuing (the bundled browser may still work)"
fi
if runuser -u "${APP_USER}" -- env HOME=/var/lib/velocity-proxy \
  PLAYWRIGHT_BROWSERS_PATH=/var/lib/velocity-proxy/.cache/ms-playwright \
  npx --yes playwright install chromium 2>&1 | tail -3; then
  ok "Chromium downloaded"
else
  warn "Playwright could not download Chromium."
  warn "Install the chromium package manually and set CHROMIUM_PATH=/usr/bin/chromium in .env"
fi

# ------------------------------------------------------------------ env file
step "Writing configuration"
if [[ -z "${ACCESS_PASSWORD}" ]]; then
  ACCESS_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
  GENERATED_PASSWORD=1
else
  GENERATED_PASSWORD=0
fi
SESSION_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n/+)' | head -c 96)"

if [[ -n "${DOMAIN}" && "${NO_SSL}" -eq 0 ]]; then
  PUBLIC_ORIGIN="https://${DOMAIN}"
elif [[ -n "${DOMAIN}" ]]; then
  PUBLIC_ORIGIN="http://${DOMAIN}"
else
  PUBLIC_ORIGIN=""
fi

ENV_FILE="${INSTALL_DIR}/.env"
if [[ -f "${ENV_FILE}" ]]; then
  warn "Existing .env preserved (passwords and secrets are never overwritten)"
  if [[ "${GENERATED_PASSWORD}" -eq 0 ]]; then
    sed -i "s|^ACCESS_PASSWORD=.*|ACCESS_PASSWORD=${ACCESS_PASSWORD}|" "${ENV_FILE}" || true
  fi
  if [[ -n "${PUBLIC_ORIGIN}" ]]; then
    sed -i "s|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=${PUBLIC_ORIGIN}|" "${ENV_FILE}" || true
  fi
else
  cat > "${ENV_FILE}" <<EOF
# Generated by install.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
HOST=127.0.0.1
PORT=${PORT}
PUBLIC_ORIGIN=${PUBLIC_ORIGIN}
TRUST_PROXY=1

AUTH_MODE=password
ACCESS_PASSWORD=${ACCESS_PASSWORD}
SESSION_SECRET=${SESSION_SECRET}
SESSION_TTL_DAYS=30
ALLOW_NO_AUTH=0

MAX_TABS=12
MAX_SESSIONS=40
TAB_IDLE_MINUTES=10
BROWSER_IDLE_SECONDS=180
MAX_LIVE_BROWSERS=6
MAX_LIVE_TABS=16
SCREENCAST_FPS=30
IDLE_POLL_MS=5000
CHROMIUM_JS_HEAP_MB=512
NAV_TIMEOUT_MS=45000
FRAME_QUALITY=62
VIEWPORT_MAX_WIDTH=1920
VIEWPORT_MAX_HEIGHT=1200

BROWSER_MODE=headless
CHROMIUM_SANDBOX=auto
CHROMIUM_PATH=
CHROMIUM_ARGS=

# Chromium plays into a private PulseAudio null sink; ffmpeg records its monitor.
AUDIO_ENABLED=1
AUDIO_SOURCE=pulse
AUDIO_DEVICE=velocity_sink.monitor
AUDIO_FFMPEG_PATH=ffmpeg
AUDIO_BITRATE_KBPS=64
AUDIO_PULSE_SINK=velocity_sink
# One Chromium process, sink and capture per signed-in session, so visitors
# never hear each other's audio. Set to 0 on a small VPS to share one capture.
AUDIO_PER_SESSION=1
AUDIO_PACTL_PATH=pactl

SSRF_GUARD=routes
ALLOW_PRIVATE_TARGETS=0
RATE_LIMIT_PER_MINUTE=240

DATA_DIR=${DATA_DIR}
LOG_LEVEL=info
PLAYWRIGHT_BROWSERS_PATH=/var/lib/velocity-proxy/.cache/ms-playwright
EOF
  ok "Wrote ${ENV_FILE}"
fi
chown root:"${APP_USER}" "${ENV_FILE}"
chmod 0640 "${ENV_FILE}"
install -d -m 0750 -o "${APP_USER}" -g "${APP_USER}" "${DATA_DIR}"

# ------------------------------------------------------------------- systemd
step "Creating the systemd service"
cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Velocity Proxy - server side Chromium web proxy
Documentation=file://${INSTALL_DIR}/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
Environment=HOME=/var/lib/velocity-proxy
Environment=XDG_RUNTIME_DIR=/run/velocity-proxy
RuntimeDirectory=velocity-proxy
RuntimeDirectoryMode=0700
ExecStart=${INSTALL_DIR}/scripts/start-with-audio.sh
Restart=always
RestartSec=3
TimeoutStopSec=20
KillMode=mixed
LimitNOFILE=65535
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${DATA_DIR} /var/lib/velocity-proxy /run/velocity-proxy
# Chromium needs to create user namespaces for its sandbox; keep the rest locked down.
RestrictSUIDSGID=no
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable velocity-proxy >/dev/null 2>&1 || true
systemctl restart velocity-proxy
ok "velocity-proxy.service installed and started"

# --------------------------------------------------------------------- nginx
if true; then
  step "Configuring Nginx"
  SERVER_NAME="${DOMAIN:-_}"
  cat > "${NGINX_SITE}" <<EOF
# Velocity Proxy - reverse proxy with WebSocket streaming
map \$http_upgrade \$velocity_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAME};

    # Needed for ACME HTTP-01 validation before certificates exist.
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$velocity_connection_upgrade;

        # Streaming must not be buffered or cut short.
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        tcp_nodelay on;
        client_max_body_size 4m;
    }
}
EOF
  ln -sfn "${NGINX_SITE}" /etc/nginx/sites-enabled/velocity-proxy
  rm -f /etc/nginx/sites-enabled/default

  nginx -t >/dev/null 2>&1 || die "Nginx configuration test failed (nginx -t)"
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload nginx
  ok "Nginx reverse proxy configured on port 80"

  if [[ "${NO_SSL}" -eq 0 && -n "${DOMAIN}" ]]; then
    step "Requesting a Let's Encrypt certificate for ${DOMAIN}"
    if certbot --nginx -d "${DOMAIN}" --email "${EMAIL}" --agree-tos --non-interactive --redirect --keep-until-expiring 2>&1 | tail -6; then
      ok "HTTPS enabled with automatic renewal"
      systemctl enable --now certbot.timer >/dev/null 2>&1 || true
    else
      warn "certbot failed. The proxy is still available over HTTP."
      warn "Check DNS A/AAAA records point at this server, then run:"
      warn "  certbot --nginx -d ${DOMAIN} --redirect"
    fi
  else
    info "Skipping TLS (--no-ssl or no domain provided)."
  fi
fi

# -------------------------------------------------------------------- health
step "Waiting for the proxy to become healthy"
HEALTH_URL="http://127.0.0.1:${PORT}/api/info"
HEALTHY=0
for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 "${HEALTH_URL}" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [[ "${HEALTHY}" -ne 1 ]]; then
  warn "The service did not answer on ${HEALTH_URL}."
  warn "Inspect the logs:  journalctl -u velocity-proxy -n 80 --no-pager"
  systemctl status velocity-proxy --no-pager -l | tail -20 || true
  die "Installation finished but the service is not healthy."
fi
ok "Proxy is responding"

if [[ -n "${DOMAIN}" && "${NO_SSL}" -eq 0 ]]; then
  FINAL_URL="https://${DOMAIN}"
elif [[ -n "${DOMAIN}" ]]; then
  FINAL_URL="http://${DOMAIN}"
else
  FINAL_URL="http://$(curl -fsS --max-time 2 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
fi

cat <<EOF

$(printf "${C_GREEN}${C_BOLD}")Velocity Proxy is installed.$(printf "${C_RESET}")

  URL        ${FINAL_URL}
  Password   ${ACCESS_PASSWORD}
  Config     ${ENV_FILE}
  Data       ${DATA_DIR}
  Service    velocity-proxy

  systemctl status velocity-proxy
  journalctl -u velocity-proxy -f
  bash ${INSTALL_DIR}/update.sh
  bash ${INSTALL_DIR}/uninstall.sh

The password is also stored in ${ENV_FILE} (root-readable). Sign in, then type any
address — every page renders inside this origin. No iframes, no redirects.

EOF
