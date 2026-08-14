#!/usr/bin/env bash
# deploy/deploy-frontend.sh
#
# Builds the Vite SPA into a timestamped release directory, then atomically
# swaps the nginx-served symlink so there is no window where nginx can serve
# partial or missing assets.
#
# Directory layout on VPS after first deploy:
#   /opt/rocketfi/releases/
#     20260814_185500/     ← previous release (kept for rollback)
#     20260814_190012/     ← current release
#   /opt/rocketfi/current  →  releases/20260814_190012  ← nginx root (symlink)
#
# The nginx root MUST be /opt/rocketfi/current — matches the `root` directive
# in deploy/nginx/rocketfi.  Run ./deploy/deploy-nginx.sh once after updating
# the nginx config to apply any root-path changes.
#
# Usage:
#   ./deploy/deploy-frontend.sh user@your-vps
#
# Environment variables (override defaults):
#   VPS_USER_HOST   — e.g. "deploy@203.0.113.42"  (or pass as first argument)
#   APP_DIR         — absolute path on VPS (default: /opt/rocketfi)
#   RELEASES_DIR    — where release snapshots live
#                     (default: $APP_DIR/releases)
#                     must be on the same filesystem as NGINX_ROOT for atomic mv
#   NGINX_ROOT      — nginx document root (default: $APP_DIR/current)
#                     must match the `root` directive in deploy/nginx/rocketfi
#   ENV_FILE        — path to the build env file on VPS
#                     (default: $APP_DIR/artifacts/rocketfi/.env.build)
#   KEEP_RELEASES   — number of old releases to keep for rollback (default: 3)

set -euo pipefail

VPS_USER_HOST="${1:-${VPS_USER_HOST:-}}"
if [[ -z "$VPS_USER_HOST" ]]; then
  echo "Error: VPS host not specified." >&2
  echo "Usage: $0 user@your-vps  OR  export VPS_USER_HOST=user@your-vps" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/rocketfi}"
RELEASES_DIR="${RELEASES_DIR:-$APP_DIR/releases}"
NGINX_ROOT="${NGINX_ROOT:-$APP_DIR/current}"
ENV_FILE="${ENV_FILE:-$APP_DIR/artifacts/rocketfi/.env.build}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"

echo "==> Deploying frontend to $VPS_USER_HOST …"

# ── 1. Pull latest code ─────────────────────────────────────────────────────
echo "    [1/4] Pulling latest code"
ssh "$VPS_USER_HOST" "cd $APP_DIR && git pull origin main"

# ── 2. Build into a fresh release directory ─────────────────────────────────
# Build output goes into a timestamped snapshot — NOT the live nginx root.
# nginx keeps serving the previous release uninterrupted during the build.
echo "    [2/4] Building into release snapshot"
RELEASE_DIR=$(ssh "$VPS_USER_HOST" "
  set -euo pipefail
  RELEASE_TS=\$(date +%Y%m%d_%H%M%S)
  RELEASE_PATH=$RELEASES_DIR/\$RELEASE_TS
  mkdir -p \$RELEASE_PATH

  if [[ ! -f '$ENV_FILE' ]]; then
    echo 'ERROR: build env file not found at $ENV_FILE' >&2
    echo 'Create it once: see deploy/README.md for the required VITE_* variables' >&2
    exit 1
  fi

  set -a
  source '$ENV_FILE'
  set +a
  cd $APP_DIR/artifacts/rocketfi
  pnpm run build

  # Move the built output into the release snapshot
  mv dist/public/* \$RELEASE_PATH/
  echo \$RELEASE_PATH
")
echo "    Built to: $RELEASE_DIR"

# ── 3. Atomic symlink swap via rename(2) ────────────────────────────────────
# ln -sfn is NOT atomic (unlink + symlink = two syscalls, gap in between).
# The correct approach:
#   1. Create a brand-new symlink at a temp path on the SAME filesystem as
#      NGINX_ROOT (critical — mv rename(2) is only atomic within one fs).
#   2. mv -Tf renames it onto NGINX_ROOT using the rename(2) syscall, which IS
#      atomic on Linux — nginx never sees a missing or intermediate state.
echo "    [3/4] Atomically swapping nginx root symlink (rename syscall)"
ssh "$VPS_USER_HOST" "
  # Temp path must be on the same filesystem as NGINX_ROOT for atomic rename
  TMP_LINK=${NGINX_ROOT}.new
  ln -s $RELEASE_DIR \"\$TMP_LINK\"
  mv -Tf \"\$TMP_LINK\" $NGINX_ROOT
  echo '    $NGINX_ROOT → $RELEASE_DIR (atomic rename)'
"

# ── 4. Verify nginx is serving the new release ──────────────────────────────
echo "    [4/4] Verifying nginx root"
ssh "$VPS_USER_HOST" "
  INDEX=$NGINX_ROOT/index.html
  if [[ -f \"\$INDEX\" ]]; then
    echo \"    index.html in nginx root (\$(stat -c%s \"\$INDEX\") bytes)\"
  else
    echo 'ERROR: index.html not found in nginx root ($NGINX_ROOT)' >&2
    exit 1
  fi
"

# ── 5. Prune old releases ────────────────────────────────────────────────────
ssh "$VPS_USER_HOST" "
  cd $RELEASES_DIR
  RELEASES=\$(ls -1t)
  COUNT=\$(echo \"\$RELEASES\" | wc -l)
  if (( COUNT > $KEEP_RELEASES )); then
    TO_DELETE=\$(echo \"\$RELEASES\" | tail -n +\$(( $KEEP_RELEASES + 1 )))
    echo \"    Pruning \$(echo \"\$TO_DELETE\" | wc -l) old release(s)\"
    echo \"\$TO_DELETE\" | xargs -I{} rm -rf $RELEASES_DIR/{}
  fi
"

echo "==> Done. Frontend is live. Rollback: ln -sfn \$RELEASES_DIR/<prev> $NGINX_ROOT"
