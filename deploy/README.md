# Deployment

Scripts and config for the production VPS (`pumpi.io`).

## Full Release Checklist

```bash
# Every release:
./deploy/deploy-api.sh      root@155.103.50.121   # rolling reload, zero dropped connections
./deploy/deploy-frontend.sh root@155.103.50.121   # atomic symlink swap, no partial-asset window

# Only when nginx config changed:
./deploy/deploy-nginx.sh    root@155.103.50.121
```

All three scripts accept `user@host` as the first argument or via `VPS_USER_HOST`.

---

## One-time VPS Setup (first deploy only)

### 1. Nginx proxy cache directory
```bash
sudo mkdir -p /var/cache/nginx/pumpi
sudo chown www-data:www-data /var/cache/nginx/pumpi
```

Add to the `http {}` block in `/etc/nginx/nginx.conf`:
```nginx
proxy_cache_path /var/cache/nginx/pumpi levels=1:2
    keys_zone=pumpi_images:10m max_size=2g inactive=7d use_temp_path=off;
```

### 2. Frontend release directory
```bash
mkdir -p /opt/rocketfi/releases
```

Run `./deploy/deploy-frontend.sh` once — it creates `/opt/rocketfi/current` (the nginx root symlink).

### 3. Deploy the nginx config
```bash
./deploy/deploy-nginx.sh root@155.103.50.121
```

This sets `root /opt/rocketfi/current` (the symlink) in nginx.

### 4. Create the frontend build env file
```bash
cat > /opt/rocketfi/artifacts/rocketfi/.env.build << 'EOF'
VITE_ALCHEMY_API_KEY=<your-alchemy-key>
VITE_PLATFORM_FEE_RECIPIENT=<your-solana-wallet>
VITE_PRIVY_APP_ID=<your-privy-app-id>
VITE_GOOGLE_CLIENT_ID=<your-google-client-id>
BASE_PATH=/
EOF
```

---

## API Server (`deploy/deploy-api.sh`)

Builds the Node.js API on the VPS and does a **rolling reload** across 2 PM2 cluster workers:

```
Worker A: handles traffic → stops (drains ≤10 s) → restarts with new code
Worker B: handles all traffic during A's restart → then restarts the same way
```

At least one worker is always serving requests. Zero dropped connections.

Only worker 0 runs background jobs (stream adapters, enrichment, backfill) —
`NODE_APP_INSTANCE` guards prevent duplicate indexing across workers.

```bash
./deploy/deploy-api.sh root@155.103.50.121
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `VPS_USER_HOST` | _(required)_ | `user@host` |
| `APP_DIR` | `/opt/rocketfi` | Repo root on VPS |
| `PM2_APP_NAME` | `rocketfi-api` | Name in `ecosystem.config.cjs` |

---

## Frontend (`deploy/deploy-frontend.sh`)

Builds into a **timestamped release directory**, then atomically swaps the nginx root symlink.
nginx keeps serving the old release while the build runs — no downtime, no partial assets.

```
/opt/rocketfi/releases/
  20260814_185500/   ← previous release (kept for rollback)
  20260814_190012/   ← new release
/opt/rocketfi/current  →  releases/20260814_190012   (nginx root)
```

### Why the swap is truly atomic

`ln -sfn` is **not** atomic — it unlinks then recreates (two syscalls, gap in between).
The script instead uses:

```bash
ln -s $RELEASE_DIR $APP_DIR/current.new   # create temp symlink (no existing file)
mv -Tf $APP_DIR/current.new $APP_DIR/current   # atomic rename(2) syscall
```

`mv -T` invokes `rename(2)` which replaces the target in a single kernel operation —
nginx never sees a missing or partially-written root.

**Rollback** to a previous release in one command:
```bash
ln -sfn /opt/rocketfi/releases/<prev-timestamp> /opt/rocketfi/current
```

```bash
./deploy/deploy-frontend.sh root@155.103.50.121
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `VPS_USER_HOST` | _(required)_ | `user@host` |
| `APP_DIR` | `/opt/rocketfi` | Repo root on VPS |
| `RELEASES_DIR` | `$APP_DIR/releases` | Release snapshot directory |
| `ENV_FILE` | `$APP_DIR/artifacts/rocketfi/.env.build` | VITE_* build env file |
| `KEEP_RELEASES` | `3` | Old releases to retain for rollback |

---

## Nginx (`deploy/deploy-nginx.sh`)

Only run when `deploy/nginx/rocketfi` has changed. Copies config, enables site, tests, reloads.

```bash
./deploy/deploy-nginx.sh root@155.103.50.121
```

### Cache strategy

| Resource | Cache-Control | Notes |
|---|---|---|
| `index.html` / SPA routes | `no-cache, no-store, must-revalidate` | Stale HTML + new hashed JS chunks = blank page |
| `*.js`, `*.css`, fonts | `public, max-age=31536000, immutable` | Content-hashed filenames — safe forever |
| `/api/storage/public-objects/*` | `public, max-age=31536000, immutable` + nginx disk cache 7d | Token images are immutable; cached after first fetch |
| `/api/*` | no caching (proxied) | Dynamic API responses |

---

## Manual steps (reference)

### API server
```bash
ssh root@155.103.50.121
cd /opt/rocketfi && git pull origin main
cd artifacts/api-server && pnpm run build
cd /opt/rocketfi
pm2 reload ecosystem.config.cjs --update-env --only rocketfi-api
pm2 logs rocketfi-api --lines 20 --nostream
```

### Frontend
```bash
ssh root@155.103.50.121
cd /opt/rocketfi && git pull origin main
RELEASE=/opt/rocketfi/releases/$(date +%Y%m%d_%H%M%S)
mkdir -p $RELEASE
set -a && source /opt/rocketfi/artifacts/rocketfi/.env.build && set +a
cd /opt/rocketfi/artifacts/rocketfi && pnpm run build
mv dist/public/* $RELEASE/
ln -sfn $RELEASE /opt/rocketfi/current
```

### Check PM2 status
```bash
pm2 list
pm2 logs rocketfi-api --lines 50 --nostream
```
