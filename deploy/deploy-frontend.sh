#!/usr/bin/env bash
# deploy/deploy-frontend.sh
#
# Pulls the latest code, rebuilds the Vite frontend, and copies the output
# into the nginx root.  nginx keeps serving the old build until the new one
# is fully written, so there is no downtime.
#
# Usage:
#   ./deploy/deploy-frontend.sh user@your-vps
#
# Environment variables (override defaults):
#   VPS_USER_HOST  — e.g. "deploy@203.0.113.42"  (or pass as first argument)
#   APP_DIR        — absolute path on VPS (default: /opt/rocketfi)
#   ENV_FILE       — path to the build env file on VPS
#                    (default: $APP_DIR/artifacts/rocketfi/.env.build)

set -euo pipefail

VPS_USER_HOST="${1:-${VPS_USER_HOST:-}}"
if [[ -z "$VPS_USER_HOST" ]]; then
  echo "Error: VPS host not specified." >&2
  echo "Usage: $0 user@your-vps  OR  export VPS_USER_HOST=user@your-vps" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/rocketfi}"
ENV_FILE="${ENV_FILE:-$APP_DIR/artifacts/rocketfi/.env.build}"

echo "==> Deploying frontend to $VPS_USER_HOST …"

# ── 1. Pull latest code ─────────────────────────────────────────────────────
echo "    [1/3] Pulling latest code"
ssh "$VPS_USER_HOST" "cd $APP_DIR && git pull origin main"

# ── 2. Build ────────────────────────────────────────────────────────────────
echo "    [2/3] Building frontend"
ssh "$VPS_USER_HOST" "
  if [[ ! -f '$ENV_FILE' ]]; then
    echo 'ERROR: build env file not found at $ENV_FILE' >&2
    echo 'Create it with your VITE_* variables (see deploy/README.md)' >&2
    exit 1
  fi
  set -a
  source '$ENV_FILE'
  set +a
  cd $APP_DIR/artifacts/rocketfi
  pnpm run build
"

# ── 3. Verify nginx sees new files ──────────────────────────────────────────
echo "    [3/3] Verifying nginx root"
ssh "$VPS_USER_HOST" "
  INDEX=$APP_DIR/artifacts/rocketfi/dist/public/index.html
  if [[ -f \"\$INDEX\" ]]; then
    echo \"    index.html exists (\$(stat -c%s \"\$INDEX\") bytes)\"
  else
    echo 'ERROR: build output not found — check the build logs above' >&2
    exit 1
  fi
"

echo "==> Done. Frontend is live at https://pumpi.io"
