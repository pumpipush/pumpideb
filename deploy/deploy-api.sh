#!/usr/bin/env bash
# deploy/deploy-api.sh
#
# Pulls the latest code, rebuilds the API server, then does a GRACEFUL reload
# so in-flight HTTP requests are not dropped.
#
# How graceful reload works:
#   PM2 sends SIGINT to the old process.  The server finishes all active
#   requests (up to kill_timeout=10s in ecosystem.config.cjs), then exits.
#   The new process starts in parallel and takes over as soon as it's ready.
#   Result: zero dropped connections.
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
ssh "$VPS_USER_HOST" "cd $APP_DIR && pnpm install --frozen-lockfile --filter @workspace/api-server... 2>&1 | tail -5"

# ── 3. Build the API server ─────────────────────────────────────────────────
echo "    [3/4] Building API server"
ssh "$VPS_USER_HOST" "cd $APP_DIR/artifacts/api-server && pnpm run build"

# ── 4. Graceful reload (zero dropped connections) ───────────────────────────
# pm2 reload sends SIGINT to the old process and starts the new one in
# parallel.  In-flight requests have up to kill_timeout (10 s) to complete.
# Use 'restart' as a fallback if the process isn't running yet.
echo "    [4/4] Graceful reload via PM2"
ssh "$VPS_USER_HOST" "
  cd $APP_DIR
  if pm2 describe $PM2_APP_NAME >/dev/null 2>&1; then
    pm2 reload ecosystem.config.cjs --update-env --only $PM2_APP_NAME
  else
    echo 'Process not found — doing a fresh start'
    pm2 start ecosystem.config.cjs --update-env
  fi
  pm2 save
"

# ── 5. Health check ─────────────────────────────────────────────────────────
echo "    Waiting for API to be healthy …"
ssh "$VPS_USER_HOST" "
  for i in \$(seq 1 10); do
    status=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/health 2>/dev/null || true)
    if [[ \"\$status\" == '200' ]]; then
      echo '    Health check passed (HTTP 200)'
      exit 0
    fi
    echo \"    Attempt \$i/10: HTTP \$status — retrying in 2 s …\"
    sleep 2
  done
  echo 'ERROR: API did not become healthy within 20 s' >&2
  pm2 logs $PM2_APP_NAME --lines 20 >&2
  exit 1
"

echo "==> Done. API server is running and accepting connections."
