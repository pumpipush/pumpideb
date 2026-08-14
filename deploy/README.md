# Deployment

Scripts and config for the production VPS (`pumpi.io`).

## Full Release Checklist

```
1. git push origin main          # push code
2. ./deploy/deploy-api.sh        # build + graceful reload API (zero dropped connections)
3. ./deploy/deploy-frontend.sh   # build + write new static files (nginx serves instantly)
4. ./deploy/deploy-nginx.sh      # only when nginx config changed
```

All three scripts accept `user@host` as the first argument (or via `VPS_USER_HOST`).

---

## API Server (`deploy/deploy-api.sh`)

Builds the Node.js API on the VPS and reloads it **gracefully** via PM2:
- In-flight HTTP requests get up to 10 s to finish before the old process exits
- New process starts in parallel — zero dropped connections
- Falls back to `pm2 start` if the process isn't running yet

```bash
./deploy/deploy-api.sh root@155.103.50.121
# or
export VPS_USER_HOST=root@155.103.50.121
./deploy/deploy-api.sh
```

### How graceful reload works

```
Old process  ←── SIGINT sent by PM2 reload
                  │  finishes in-flight requests (≤ 10 s)
                  └──────────────────────── exits

New process  ─────────────── starts in parallel, takes traffic immediately
```

`kill_timeout: 10000` and `listen_timeout: 8000` are set in `ecosystem.config.cjs`.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `VPS_USER_HOST` | _(required if not passed as arg)_ | `user@host` of the VPS |
| `APP_DIR` | `/opt/rocketfi` | Absolute path to the repo on the VPS |
| `PM2_APP_NAME` | `rocketfi-api` | PM2 process name in `ecosystem.config.cjs` |

---

## Frontend (`deploy/deploy-frontend.sh`)

Builds the Vite SPA on the VPS and writes it to the nginx root.  
nginx keeps serving the old build until the new bundle is fully written — no downtime.

```bash
./deploy/deploy-frontend.sh root@155.103.50.121
```

### Build env file

The frontend requires `VITE_*` variables at build time.  
Create this file once on the VPS:

```bash
cat > /opt/rocketfi/artifacts/rocketfi/.env.build << 'EOF'
VITE_ALCHEMY_API_KEY=<your-alchemy-key>
VITE_PLATFORM_FEE_RECIPIENT=<your-solana-wallet>
VITE_PRIVY_APP_ID=<your-privy-app-id>
VITE_GOOGLE_CLIENT_ID=<your-google-client-id>
BASE_PATH=/
EOF
```

The deploy script reads this file automatically via `source .env.build`.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `VPS_USER_HOST` | _(required if not passed as arg)_ | `user@host` of the VPS |
| `APP_DIR` | `/opt/rocketfi` | Absolute path to the repo on the VPS |
| `ENV_FILE` | `$APP_DIR/artifacts/rocketfi/.env.build` | Path to the build env file |

---

## Nginx (`deploy/deploy-nginx.sh`)

Only needed when `deploy/nginx/rocketfi` has changed.  
Copies the config, enables the site, tests it, and **reloads nginx** (zero-downtime).

```bash
./deploy/deploy-nginx.sh root@155.103.50.121
```

### Cache strategy

| Resource | Cache-Control | Why |
|---|---|---|
| `index.html` / SPA routes | `no-cache, no-store, must-revalidate` | Vite hashes JS/CSS filenames on every build; a cached HTML referencing old chunk names → blank page |
| `*.js`, `*.css`, fonts | `public, max-age=31536000, immutable` | Filenames contain a content hash — safe to cache forever |
| `/api/storage/public-objects/*` | `public, max-age=31536000, immutable` + nginx proxy cache 7d | Token images are content-addressed; cached on disk after first fetch |
| `/api/*` | no caching (proxied) | Dynamic API responses |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `VPS_USER_HOST` | _(required if not passed as arg)_ | `user@host` of the VPS |
| `NGINX_SITE` | `rocketfi` | Site name under `sites-available/` |
| `NGINX_DIR` | `/etc/nginx` | Root nginx directory on the VPS |

---

## Manual steps (reference)

### API server

```bash
ssh root@155.103.50.121
cd /opt/rocketfi
git pull origin main
cd artifacts/api-server && pnpm run build
cd /opt/rocketfi
pm2 reload ecosystem.config.cjs --update-env --only rocketfi-api
pm2 save
```

### Frontend

```bash
ssh root@155.103.50.121
cd /opt/rocketfi/artifacts/rocketfi
set -a && source .env.build && set +a
pnpm run build
```

### Check PM2 status

```bash
pm2 list
pm2 logs rocketfi-api --lines 50
```
