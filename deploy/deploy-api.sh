#!/usr/bin/env bash
# deploy/deploy-api.sh
#
# Pulls the latest code, rebuilds the API server, and reloads it via PM2.
#
# Reload behaviour (fork mode, instances: 1):
#   PM2 sends SIGINT to the running process.  The server has up to
#   kill_timeout (10 s) to finish active requests before PM2 force-kills it,
#   then the new process starts.  There is a brief window (typically < 1 s)
#   between the old process exiting and the new one accepting connections.
#   For true zero-downtime reloads, switch ecosystem.config.cjs to cluster
#   mode with instances ≥ 2 so PM2 can roll workers one at a time.
#
# Usage:
#   ./deploy/deploy-api.sh user@your-vps
#
# Environment variables (override defaults):
#   VPS_USER_HOST  — e.g. "deploy@203.0.113.42"  (or pass as first argument)
#   APP_DIR        — absolute path on VPS (default: /opt/rocketfi)
#   PM2_APP_NAME   — PM2 process name (default: rocketfi-api)
#   API_PORT       — port the API server listens on (default: 8080, must
#                    match the PORT env var in artifacts/api-server/.env and
#                    the proxy_pass port in deploy/nginx/rocketfi)

set -euo pipefail

# ── resolve target host ─────────────────────────────────────────────────────
VPS_USER_HOST="${1:-${VPS_USER_HOST:-}}"
if [[ -z "$VPS_USER_HOST" ]]; then
  echo "Error: VPS host not specified." >&2
  echo "Usage: $0 user@your-vps  OR  export VPS_USER_HOST=user@your-vps" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/rocketfi}"
PM2_APP_NAME="${PM2_APP_NAME:-rocketfi-api}"
# Must match PORT in artifacts/api-server/.env and proxy_pass in deploy/nginx/rocketfi
API_PORT="${API_PORT:-8080}"

echo "==> Deploying API server to $VPS_USER_HOST …"

# ── 1. Pull latest code ─────────────────────────────────────────────────────
echo "    [1/4] Pulling latest code"
ssh "$VPS_USER_HOST" "cd $APP_DIR && git pull origin main"

# ── 2. Install/update dependencies ─────────────────────────────────────────
echo "    [2/4] Installing dependencies"
ssh "$VPS_USER_HOST" "cd $APP_DIR && pnpm install --frozen-lockfile 2>&1 | tail -3"

# ── 3. Build the API server ─────────────────────────────────────────────────
echo "    [3/4] Building API server"
ssh "$VPS_USER_HOST" "cd $APP_DIR/artifacts/api-server && pnpm run build"

# ── 4. Reload via PM2 ───────────────────────────────────────────────────────
# pm2 reload sends SIGINT to the old process; it has up to kill_timeout (10 s)
# to drain in-flight requests before PM2 force-kills it, then the new process
# starts.  Use 'start' as a fallback if the process isn't running yet.
echo "    [4/4] Reload via PM2"
ssh "$VPS_USER_HOST" "
  cd $APP_DIR
  if pm2 describe $PM2_APP_NAME >/dev/null 2>&1; then
    pm2 reload ecosystem.config.cjs --update-env --only $PM2_APP_NAME
  else
    echo '  Process not running — doing a fresh start'
    pm2 start ecosystem.config.cjs --update-env
  fi
  pm2 save
"

# ── 5. Health check — confirm the process is accepting requests ─────────────
echo "    Waiting for API to pass health check …"
ssh "$VPS_USER_HOST" "
  for i in \$(seq 1 12); do
    status=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:$API_PORT/api/healthz 2>/dev/null || true)
    if [[ \"\$status\" == '200' ]]; then
      echo '    Health check passed (HTTP 200 /api/healthz)'
      exit 0
    fi
    echo \"    Attempt \$i/12: HTTP \$status — retrying in 2 s …\"
    sleep 2
  done
  echo 'ERROR: API did not become healthy within 24 s' >&2
  pm2 logs $PM2_APP_NAME --lines 30 --nostream >&2
  exit 1
"

echo "==> Done. API server is running and accepting connections."
