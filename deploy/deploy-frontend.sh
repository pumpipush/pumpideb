#!/usr/bin/env bash
# deploy/deploy-frontend.sh
#
# Builds the Vite SPA + Admin Dashboard, then atomically swaps nginx symlinks
# so there is no window where nginx can serve partial or missing assets.
#
# Directory layout on VPS after first deploy:
#   /opt/rocketfi/releases/
#     20260814_185500/        ← previous release (kept for rollback)
#     20260814_190012/        ← current release
#     20260814_190012-admin/  ← admin build for the same deploy
#   /opt/rocketfi/current        →  releases/20260814_190012       ← nginx root (rocketfi SPA)
#   /opt/rocketfi/admin-current  →  releases/20260814_190012-admin ← nginx alias (/admin/)
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
#   NGINX_ROOT      — nginx document root for rocketfi (default: $APP_DIR/current)
#                     must match the `root` directive in deploy/nginx/rocketfi
#   ADMIN_ROOT      — nginx alias root for admin (default: $APP_DIR/admin-current)
#                     must match the `alias` directive for /admin/ in deploy/nginx/rocketfi
#   ENV_FILE        — path to the rocketfi build env file on VPS
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
ADMIN_ROOT="${ADMIN_ROOT:-$APP_DIR/admin-current}"
ENV_FILE="${ENV_FILE:-$APP_DIR/artifacts/rocketfi/.env.build}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"

echo "==> Deploying frontend + admin to $VPS_USER_HOST …"

# ── 1. Pull latest code ─────────────────────────────────────────────────────
echo "    [1/5] Pulling latest code"
ssh "$VPS_USER_HOST" "cd $APP_DIR && git pull origin main && pnpm install --frozen-lockfile 2>&1 | tail -3"

# ── 2. Build rocketfi SPA into a fresh release directory ────────────────────
# Build output goes into a timestamped snapshot — NOT the live nginx root.
# nginx keeps serving the previous release uninterrupted during the build.
echo "    [2/5] Building rocketfi SPA into release snapshot"
RELEASE_DIR=$(ssh "$VPS_USER_HOST" "
  set -euo pipefail
  RELEASE_TS=\$(date +%Y%m%d_%H%M%S)
  RELEASE_PATH=$RELEASES_DIR/\$RELEASE_TS
  mkdir -p \$RELEASE_PATH

  if [[ ! -f '$ENV_FILE' ]]; then
    echo 'ERROR: build env file not found at $ENV_FILE' >&2
    echo 'Create it once: cp $APP_DIR/artifacts/rocketfi/.env.example $APP_DIR/artifacts/rocketfi/.env.build' >&2
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

# ── 3. Build admin dashboard into a parallel snapshot ───────────────────────
# Admin is a separate static SPA served at /admin/.
# It reads BASE_PATH=/admin/ from the artifact config — no .env.build needed.
echo "    [3/5] Building admin dashboard"
ADMIN_RELEASE_DIR=$(ssh "$VPS_USER_HOST" "
  set -euo pipefail
  ADMIN_RELEASE_PATH=${RELEASE_DIR}-admin
  mkdir -p \$ADMIN_RELEASE_PATH

  cd $APP_DIR/artifacts/admin
  pnpm run build

  # Move the built output into the admin snapshot
  mv dist/public/* \$ADMIN_RELEASE_PATH/
  echo \$ADMIN_RELEASE_PATH
")
echo "    Admin built to: $ADMIN_RELEASE_DIR"

# ── 4. Atomic symlink swap via rename(2) ────────────────────────────────────
# ln -sfn is NOT atomic (unlink + symlink = two syscalls, gap in between).
# The correct approach:
#   1. Create a brand-new symlink at a temp path on the SAME filesystem as
#      NGINX_ROOT (critical — mv rename(2) is only atomic within one fs).
#   2. mv -Tf renames it onto NGINX_ROOT using the rename(2) syscall, which IS
#      atomic on Linux — nginx never sees a missing or intermediate state.
echo "    [4/5] Atomically swapping nginx symlinks (rename syscall)"
ssh "$VPS_USER_HOST" "
  # Rocketfi SPA
  TMP_LINK=${NGINX_ROOT}.new
  ln -s $RELEASE_DIR \"\$TMP_LINK\"
  mv -Tf \"\$TMP_LINK\" $NGINX_ROOT
  echo '    $NGINX_ROOT → $RELEASE_DIR'

  # Admin dashboard
  TMP_ADMIN=${ADMIN_ROOT}.new
  ln -s $ADMIN_RELEASE_DIR \"\$TMP_ADMIN\"
  mv -Tf \"\$TMP_ADMIN\" $ADMIN_ROOT
  echo '    $ADMIN_ROOT → $ADMIN_RELEASE_DIR'
"

# ── 5. Verify nginx is serving new releases ──────────────────────────────────
echo "    [5/5] Verifying nginx roots"
ssh "$VPS_USER_HOST" "
  INDEX=$NGINX_ROOT/index.html
  if [[ -f \"\$INDEX\" ]]; then
    echo \"    rocketfi: index.html present (\$(stat -c%s \"\$INDEX\") bytes)\"
  else
    echo 'ERROR: rocketfi index.html not found in nginx root ($NGINX_ROOT)' >&2
    exit 1
  fi

  ADMIN_INDEX=$ADMIN_ROOT/index.html
  if [[ -f \"\$ADMIN_INDEX\" ]]; then
    echo \"    admin: index.html present (\$(stat -c%s \"\$ADMIN_INDEX\") bytes)\"
  else
    echo 'ERROR: admin index.html not found in admin root ($ADMIN_ROOT)' >&2
    exit 1
  fi
"

# ── 6. Prune old releases ────────────────────────────────────────────────────
ssh "$VPS_USER_HOST" "
  cd $RELEASES_DIR
  # Prune both rocketfi and admin snapshots together (they share the timestamp prefix)
  RELEASES=\$(ls -1dt */ 2>/dev/null | grep -v '\-admin/' | sed 's|/||')
  COUNT=\$(echo \"\$RELEASES\" | wc -l)
  if (( COUNT > $KEEP_RELEASES )); then
    TO_DELETE=\$(echo \"\$RELEASES\" | tail -n +\$(( $KEEP_RELEASES + 1 )))
    echo \"    Pruning \$(echo \"\$TO_DELETE\" | wc -l) old release(s)\"
    for r in \$TO_DELETE; do
      rm -rf \"$RELEASES_DIR/\$r\" \"$RELEASES_DIR/\${r}-admin\" 2>/dev/null || true
    done
  fi
"

echo "==> Done. rocketfi + admin are live."
echo "    Rollback rocketfi: ln -sfn \$RELEASES_DIR/<prev>       $NGINX_ROOT && nginx -s reload"
echo "    Rollback admin:    ln -sfn \$RELEASES_DIR/<prev>-admin $ADMIN_ROOT && nginx -s reload"
