#!/usr/bin/env bash
# setup-nginx-image-cache.sh
# Adds nginx proxy cache for token images served via /api/storage/public-objects/
# Run once on the VPS as root: bash /opt/rocketfi/scripts/setup-nginx-image-cache.sh

set -euo pipefail

NGINX_CONF="/etc/nginx/nginx.conf"
SITE_CONF="/etc/nginx/sites-available/rocketfi"
CACHE_DIR="/var/cache/nginx/pumpi"

echo "==> Creating nginx cache directory: $CACHE_DIR"
mkdir -p "$CACHE_DIR"
chown www-data:www-data "$CACHE_DIR" 2>/dev/null || chown nginx:nginx "$CACHE_DIR" 2>/dev/null || true

# ── 1. Add proxy_cache_path to nginx.conf (idempotent) ──────────────────────
CACHE_PATH_DIRECTIVE="    proxy_cache_path $CACHE_DIR levels=1:2 keys_zone=pumpi_images:10m max_size=2g inactive=7d use_temp_path=off;"

if grep -q "pumpi_images" "$NGINX_CONF"; then
  echo "==> proxy_cache_path already present in $NGINX_CONF — skipping"
else
  echo "==> Inserting proxy_cache_path into $NGINX_CONF"
  # Insert after the opening of the http { block
  sed -i '/^http {/a '"$CACHE_PATH_DIRECTIVE" "$NGINX_CONF"
  echo "    Done."
fi

# ── 2. Rewrite site config to add cached storage location ───────────────────
echo "==> Backing up $SITE_CONF → ${SITE_CONF}.bak"
cp "$SITE_CONF" "${SITE_CONF}.bak"

# Check if already patched
if grep -q "pumpi_images" "$SITE_CONF"; then
  echo "==> nginx site config already has cache config — skipping"
else
  echo "==> Patching $SITE_CONF"

  # Insert a dedicated cached location block BEFORE the general /api/ block.
  # Uses perl for multi-line insertion — more reliable than sed on Ubuntu.
  perl -i -0pe '
s|([ \t]*location /api/ \{)|    # ── Token image proxy cache ──────────────────────────────────────────────
    # Images are content-addressed (immutable). Cache at nginx for 7 days so
    # every visitor after the first gets an instant response from disk.
    location /api/storage/public-objects/ {
        proxy_pass             http://127.0.0.1:8080;
        proxy_http_version     1.1;
        proxy_set_header       Host \$host;
        proxy_set_header       X-Real-IP \$remote_addr;
        proxy_set_header       X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header       X-Forwarded-Proto \$scheme;

        # Cache config
        proxy_cache            pumpi_images;
        proxy_cache_valid      200 7d;
        proxy_cache_valid      404 1m;
        proxy_cache_use_stale  error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_lock       on;
        add_header             X-Cache-Status \$upstream_cache_status;

        # Allow manual cache bypass: curl -H "X-Purge-Cache: 1" <url>
        proxy_cache_bypass     \$http_x_purge_cache;
        proxy_no_cache         \$http_x_purge_cache;
    }

    $1|' "$SITE_CONF"

  echo "    Done."
fi

# ── 3. Also fix HTML no-cache while we are here (prevents mobile blank page) ─
if grep -q 'no-cache.*index' "$SITE_CONF" || grep -q 'add_header Cache-Control.*no-cache' "$SITE_CONF"; then
  echo "==> HTML no-cache header already present — skipping"
else
  echo "==> Adding Cache-Control: no-cache for index.html"
  perl -i -0pe '
s|([ \t]*location / \{[^}]*try_files[^}]*\})|    location / {
        try_files \$uri \$uri/ /index.html;
        # Do NOT cache index.html — it references hashed JS chunks.
        # Stale HTML causes blank screen after a new deploy.
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma        "no-cache" always;
        add_header Expires       "0" always;
    }|' "$SITE_CONF"
  echo "    Done."
fi

# ── 4. Test & reload ─────────────────────────────────────────────────────────
echo "==> Testing nginx configuration"
nginx -t

echo "==> Reloading nginx"
systemctl reload nginx

echo ""
echo "✅  Done. Token images are now cached at nginx for 7 days."
echo "    Check cache status via: curl -sI https://pumpi.io/api/storage/public-objects/<path> | grep X-Cache"
echo "    HIT  = served from nginx disk cache"
echo "    MISS = first request, fetched from object storage"
