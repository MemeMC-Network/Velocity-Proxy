#!/usr/bin/env bash
# ===========================================================================
#  Velocity Proxy — manual start (no systemd)
#    bash start.sh                 # production mode on the configured port
#    bash start.sh --dev           # auto-restart on file changes
#    PORT=9000 bash start.sh
# ===========================================================================
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${APP_DIR}"

MODE="start"
for arg in "$@"; do
  case "${arg}" in
    --dev) MODE="dev" ;;
    -h|--help)
      echo "Usage: bash start.sh [--dev]"
      exit 0 ;;
    *) echo "Unknown option: ${arg}" >&2; exit 1 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "Node.js is required (>=20)." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "${NODE_MAJOR}" -ge 20 ]] || { echo "Node.js 20+ is required (found $(node -v))." >&2; exit 1; }

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies…"
  npm install --no-audit --no-fund
fi

if [[ ! -f .env ]]; then
  echo "No .env found — copying .env.example. Set ACCESS_PASSWORD before exposing this publicly."
  cp .env.example .env
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

export NODE_ENV="${NODE_ENV:-production}"

PORT_LABEL="${PORT:-8080}"
if [[ "${BROWSER_MODE:-headless}" == "headed" && -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  echo "BROWSER_MODE=headed requires a display. Use xvfb-run or set BROWSER_MODE=headless." >&2
  exit 1
fi

echo "Starting Velocity Proxy on http://${HOST:-127.0.0.1}:${PORT_LABEL}"
if [[ "${MODE}" == "dev" ]]; then
  exec node --watch src/server.js
else
  exec node src/server.js
fi
