# Deployment

Scripts and config for the production VPS (`pumpi.io`).

## Full Release Checklist

```bash
# Every release:
./deploy/deploy-api.sh      root@155.103.50.121   # PM2 reload (brief < 1 s gap in fork mode)
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

### 2. SSL certificate
Place the Cloudflare Origin Certificate on the VPS:
```bash
sudo mkdir -p /etc/nginx/ssl
sudo cp pumpi.io.crt /etc/nginx/ssl/pumpi.io.crt
sudo cp pumpi.io.key /etc/nginx/ssl/pumpi.io.key
sudo chmod 600 /etc/nginx/ssl/pumpi.io.key
```

### 3. Frontend release directory
```bash
mkdir -p /opt/rocketfi/releases
```

Run `./deploy/deploy-frontend.sh` once — it creates `/opt/rocketfi/current` as the nginx root symlink.

### 4. Deploy the nginx config
```bash
./deploy/deploy-nginx.sh root@155.103.50.121
```

The nginx config uses `root /opt/rocketfi/current` — this resolves through the symlink managed by the deploy script.

### 5. Create the frontend build env file
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

Builds the Node.js API on the VPS and reloads it via PM2:
- In-flight HTTP requests get up to 10 s to finish before the old process exits
- New process starts after the old one exits (fork mode, `instances: 1`) —
  expect a brief gap (< 1 s) with no listener between the two
- Falls back to `pm2 start` if the process isn't running yet
- For true zero-downtime reloads, switch `ecosystem.config.cjs` to cluster
  mode with `instances ≥ 2`

Only worker 0 runs background jobs (stream adapters, enrichment, backfill) —
`NODE_APP_INSTANCE` guards prevent duplicate indexing if cluster mode is enabled.

```bash
./deploy/deploy-api.sh root@155.103.50.121
```

### How PM2 reload works (fork mode)

```
Old process  ←── SIGINT sent by PM2 reload
                  │  finishes in-flight requests (≤ 10 s)
                  └──────────────────────── exits
                                                    ↓
New process  ──────────────────────────────── starts, begins accepting traffic
```

There is a brief gap (typically < 1 s) between the old process exiting and the new one listening.
`kill_timeout: 10000` and `listen_timeout: 8000` are set in `ecosystem.config.cjs`.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `VPS_USER_HOST` | _(required)_ | `user@host` of the VPS |
| `APP_DIR` | `/opt/rocketfi` | Repo root on VPS |
| `PM2_APP_NAME` | `rocketfi-api` | PM2 process name in `ecosystem.config.cjs` |
| `API_PORT` | `8080` | Port the API listens on — must match `PORT` in `.env` and `proxy_pass` in nginx config |

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
ln -s $RELEASE_DIR /opt/rocketfi/current.new   # create temp symlink (no existing file)
mv -Tf /opt/rocketfi/current.new /opt/rocketfi/current   # atomic rename(2) syscall
```

`mv -Tf` invokes `rename(2)` which replaces the target in a single kernel operation —
nginx never sees a missing or partially-written root. Both paths are under `/opt/rocketfi`
(same filesystem) so `rename(2)` is guaranteed to be atomic.

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
| `NGINX_ROOT` | `$APP_DIR/current` | nginx document root — must match `root` in `deploy/nginx/rocketfi` |
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

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `VPS_USER_HOST` | _(required)_ | `user@host` of the VPS |
| `NGINX_SITE` | `rocketfi` | Site name under `sites-available/` |
| `NGINX_DIR` | `/etc/nginx` | Root nginx directory on the VPS |

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
ln -s $RELEASE /opt/rocketfi/current.new
mv -Tf /opt/rocketfi/current.new /opt/rocketfi/current
```

### Check PM2 status
```bash
pm2 list
pm2 logs rocketfi-api --lines 50 --nostream
```
