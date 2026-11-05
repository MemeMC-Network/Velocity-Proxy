#!/usr/bin/env bash
# ===========================================================================
#  Velocity Proxy — updater
#    sudo bash update.sh              # update deps + restart
#    sudo bash update.sh --pull       # git pull first, then update
#    sudo bash update.sh --skip-browser
# ===========================================================================
set -Eeuo pipefail

APP_NAME="velocity-proxy"
APP_USER="velocity"
INSTALL_DIR="/opt/velocity-proxy"
ENV_FILE="${INSTALL_DIR}/.env"
PULL=0
SKIP_BROWSER=0

C_RESET="\033[0m"; C_BOLD="\033[1m"; C_BLUE="\033[38;5;111m"; C_GREEN="\033[38;5;114m"
C_YELLOW="\033[38;5;179m"; C_RED="\033[38;5;203m"
step() { printf "\n${C_BLUE}==>${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$*"; }
ok()   { printf "    ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn() { printf "    ${C_YELLOW}!${C_RESET} %s\n" "$*"; }
die()  { printf "\n${C_RED}✗ %s${C_RESET}\n" "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pull) PULL=1; shift ;;
    --skip-browser) SKIP_BROWSER=1; shift ;;
    -h|--help)
      echo "Usage: sudo bash update.sh [--pull] [--skip-browser]"
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || die "Run as root: sudo bash update.sh"
[[ -d "${INSTALL_DIR}" ]] || die "${INSTALL_DIR} not found — is Velocity Proxy installed?"
[[ -f "${ENV_FILE}" ]] || die "${ENV_FILE} is missing. Reinstall with install.sh."

cd "${INSTALL_DIR}"

if [[ "${PULL}" -eq 1 ]]; then
  if [[ -d .git ]]; then
    step "Pulling the latest source"
    git fetch --all --prune
    git pull --ff-only
    ok "Source updated"
  else
    warn "No git repository at ${INSTALL_DIR}; skipping pull"
  fi
fi

step "Backing up configuration"
BACKUP="${INSTALL_DIR}/.env.backup.$(date +%s)"
cp "${ENV_FILE}" "${BACKUP}"
chmod 600 "${BACKUP}"
ok "Saved ${BACKUP}"

[[ -f package-lock.json ]] && LOCK_BACKUP="package-lock.json.bak.$(date +%s)" && cp package-lock.json "${LOCK_BACKUP}" || true

step "Installing dependencies"
npm install --omit=dev --no-audit --no-fund --loglevel=error
ok "Dependencies updated"

if [[ "${SKIP_BROWSER}" -eq 0 ]]; then
  step "Refreshing Chromium"
  if runuser -u "${APP_USER}" -- env HOME=/var/lib/velocity-proxy \
    PLAYWRIGHT_BROWSERS_PATH=/var/lib/velocity-proxy/.cache/ms-playwright \
    npx --yes playwright install chromium 2>&1 | tail -2; then
    ok "Chromium ready"
  else
    warn "Could not refresh Chromium; the existing install will be used"
  fi
fi

chown -R root:"${APP_USER}" "${INSTALL_DIR}"
chmod -R g+rX "${INSTALL_DIR}"

step "Restarting the service"
systemctl restart "${APP_NAME}"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$(grep -E '^PORT=' "${ENV_FILE}" | cut -d= -f2 | head -1 || echo 8080)/api/info" >/dev/null 2>&1; then
    ok "Proxy is healthy again"
    echo
    exit 0
  fi
  sleep 1
done

warn "The service did not answer its health check."
warn "Logs: journalctl -u ${APP_NAME} -n 80 --no-pager"
warn "Configuration backup: ${BACKUP}"
exit 1
