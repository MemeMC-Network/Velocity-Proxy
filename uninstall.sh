#!/usr/bin/env bash
# ===========================================================================
#  Velocity Proxy — uninstaller
#    sudo bash uninstall.sh            # stops the service, keeps data
#    sudo bash uninstall.sh --purge    # also removes data, user and certs
# ===========================================================================
set -Eeuo pipefail

APP_NAME="velocity-proxy"
APP_USER="velocity"
INSTALL_DIR="/opt/velocity-proxy"
DATA_DIR="/var/lib/velocity-proxy"
NGINX_SITE="/etc/nginx/sites-available/velocity-proxy"
SERVICE_FILE="/etc/systemd/system/velocity-proxy.service"
PURGE=0
ASSUME_YES=0

C_RESET="\033[0m"; C_BOLD="\033[1m"; C_BLUE="\033[38;5;111m"; C_GREEN="\033[38;5;114m"
C_YELLOW="\033[38;5;179m"; C_RED="\033[38;5;203m"
step() { printf "\n${C_BLUE}==>${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$*"; }
ok()   { printf "    ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn() { printf "    ${C_YELLOW}!${C_RESET} %s\n" "$*"; }
die()  { printf "\n${C_RED}✗ %s${C_RESET}\n" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Velocity Proxy uninstaller

Usage: sudo bash uninstall.sh [--purge] [-y]

  --purge   Remove application files, stored sessions, the service user and
            Let's Encrypt certificates for the configured domain.
  -y, --yes Assume yes; never prompt.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || die "Run as root: sudo bash uninstall.sh"

DOMAIN=""
if [[ -f "${INSTALL_DIR}/.env" ]]; then
  DOMAIN="$(grep -E '^PUBLIC_ORIGIN=' "${INSTALL_DIR}/.env" | head -1 | cut -d= -f2- | sed -e 's|https\?://||' -e 's|/.*||')"
fi

cat <<EOF
$(printf "${C_BOLD}")Velocity Proxy will be removed from this server.$(printf "${C_RESET}")

  Service    ${APP_NAME}
  App dir    ${INSTALL_DIR}
  Data dir   ${DATA_DIR}
  Nginx site ${NGINX_SITE}
EOF

if [[ "${ASSUME_YES}" -eq 0 ]]; then
  printf "\nType 'remove' to continue: "
  read -r answer
  [[ "${answer}" == "remove" ]] || die "Aborted."
fi

step "Stopping and removing the service"
systemctl stop "${APP_NAME}" 2>/dev/null || true
systemctl disable "${APP_NAME}" 2>/dev/null || true
rm -f "${SERVICE_FILE}"
systemctl daemon-reload
ok "Service removed"

step "Removing the Nginx site"
rm -f "${NGINX_SITE}" /etc/nginx/sites-enabled/velocity-proxy
if command -v nginx >/dev/null 2>&1; then
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || warn "Nginx config test failed; check /etc/nginx manually"
fi
ok "Nginx site removed"

if [[ "${PURGE}" -eq 1 ]]; then
  step "Purging application and data"
  rm -rf "${INSTALL_DIR}"
  rm -rf "${DATA_DIR}"
  ok "Application and session data deleted"

  if [[ -n "${DOMAIN}" ]] && command -v certbot >/dev/null 2>&1; then
    step "Removing Let's Encrypt certificate for ${DOMAIN}"
    certbot delete --cert-name "${DOMAIN}" --non-interactive 2>/dev/null \
      && ok "Certificate deleted" \
      || warn "No certificate named '${DOMAIN}' was found"
  fi

  if id -u "${APP_USER}" >/dev/null 2>&1; then
    step "Removing the service user"
    userdel "${APP_USER}" 2>/dev/null || true
    rm -rf "/var/lib/velocity-proxy"
    ok "User '${APP_USER}' removed"
  fi
else
  warn "Keeping ${INSTALL_DIR} and ${DATA_DIR} (run with --purge to delete them)."
fi

cat <<EOF

$(printf "${C_GREEN}")Velocity Proxy has been uninstalled.$(printf "${C_RESET}")

EOF
