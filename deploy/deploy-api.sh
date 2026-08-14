#!/usr/bin/env bash
# deploy/deploy-api.sh
#
# Pulls the latest code, rebuilds the API server, then does a ROLLING RELOAD
# across cluster workers so in-flight HTTP requests are never dropped.
#
# How zero-downtime works (cluster mode, 2 workers):
#   PM2 replaces one worker at a time:
#     1. Stop worker A (SIGINT → drain ≤ kill_timeout=10 s → exit)
#     2. Start new worker A (new code)
#     3. New A healthy → stop worker B → start new B
#   Worker B handles all traffic while A is being replaced, and vice versa.
#   Result: at least one worker is always serving requests.
#
# Usage:
#   ./deploy/deploy-api.sh user@your-vps
#
# Environment variables (override defaults):
#   VPS_USER_HOST  — e.g. "deploy@203.0.113.42"  (or pass as first argument)
#   APP_DIR        — absolute path on VPS (default: /opt/rocketfi)
#   PM2_APP_NAME   — PM2 process name (default: rocketfi-api)

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

# ── 4. Rolling reload across cluster workers (zero dropped connections) ─────
# pm2 reload replaces workers one at a time so at least one is always up.
# Falls back to 'pm2 start' if the process has never been started.
echo "    [4/4] Rolling reload via PM2 cluster"
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

# ── 5. Health check — confirm workers are accepting requests ────────────────
echo "    Waiting for API to pass health check …"
ssh "$VPS_USER_HOST" "
  for i in \$(seq 1 12); do
    status=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/healthz 2>/dev/null || true)
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
