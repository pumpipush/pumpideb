#!/usr/bin/env bash
# deploy/deploy-nginx.sh
#
# Copies the nginx config to the VPS, enables the site, tests the config,
# and reloads nginx — all in one step.
#
# Usage:
#   ./deploy/deploy-nginx.sh user@your-vps
#
# Requirements:
#   - SSH key-based access to the VPS (no password prompt)
#   - The remote user must have sudo rights (or direct write access to
#     /etc/nginx/sites-available/).
#
# Environment variables (override defaults):
#   VPS_USER_HOST  — e.g. "deploy@203.0.113.42"  (or pass as first argument)
#   NGINX_SITE     — remote site name (default: rocketfi)
#   NGINX_DIR      — remote nginx dir (default: /etc/nginx)

set -euo pipefail

# ── resolve target host ─────────────────────────────────────────────────────
VPS_USER_HOST="${1:-${VPS_USER_HOST:-}}"
if [[ -z "$VPS_USER_HOST" ]]; then
  echo "Error: VPS host not specified." >&2
  echo "Usage: $0 user@your-vps  OR  export VPS_USER_HOST=user@your-vps" >&2
  exit 1
fi

NGINX_SITE="${NGINX_SITE:-rocketfi}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_CONFIG="$SCRIPT_DIR/nginx/$NGINX_SITE"

if [[ ! -f "$LOCAL_CONFIG" ]]; then
  echo "Error: nginx config not found at $LOCAL_CONFIG" >&2
  exit 1
fi

echo "==> Deploying nginx config to $VPS_USER_HOST …"

# ── 1. Copy the config ───────────────────────────────────────────────────────
echo "    [1/4] Copying $LOCAL_CONFIG → $VPS_USER_HOST:$NGINX_DIR/sites-available/$NGINX_SITE"
scp "$LOCAL_CONFIG" "$VPS_USER_HOST:/tmp/$NGINX_SITE.nginx.tmp"
ssh "$VPS_USER_HOST" "sudo mv /tmp/$NGINX_SITE.nginx.tmp $NGINX_DIR/sites-available/$NGINX_SITE"

# ── 2. Enable the site (idempotent) ─────────────────────────────────────────
echo "    [2/4] Enabling site (symlinking into sites-enabled)"
ssh "$VPS_USER_HOST" \
  "sudo ln -sf $NGINX_DIR/sites-available/$NGINX_SITE $NGINX_DIR/sites-enabled/$NGINX_SITE"

# ── 3. Test the config ───────────────────────────────────────────────────────
echo "    [3/4] Testing nginx config"
ssh "$VPS_USER_HOST" "sudo nginx -t"

# ── 4. Reload nginx (zero-downtime) ─────────────────────────────────────────
echo "    [4/4] Reloading nginx"
ssh "$VPS_USER_HOST" "sudo systemctl reload nginx"

echo "==> Done. nginx is serving the updated config."
