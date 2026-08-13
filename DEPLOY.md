# VPS Deployment Guide

## Stack

| Component | Runtime | Port |
|-----------|---------|------|
| API server | Node.js 20+ | `PORT` (e.g. 8080) |
| Frontend | Static files via Nginx | 80 / 443 |
| Database | PostgreSQL 15+ | 5432 |

---

## 1. Prerequisites

```bash
# Install Node.js 20 (required — server uses ES2022 features)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# Verify
node --version   # must be v20.x or higher

# Install pnpm
npm install -g pnpm

# Install PostgreSQL
sudo apt-get install -y postgresql postgresql-contrib

# Install Nginx
sudo apt-get install -y nginx
```

---

## 2. Database

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE rocketfi;
CREATE USER rocketfi WITH ENCRYPTED PASSWORD 'your-strong-password';
GRANT ALL PRIVILEGES ON DATABASE rocketfi TO rocketfi;
\q
```

---

## 3. Clone & Install

**Deploy the full repository** — the API server resolves migration SQL files
relative to its bundle location (`dist/index.mjs → ../../../lib/db/migrations`),
so the complete directory structure must be present on disk.

```bash
git clone https://github.com/youruser/rocketfi.git /opt/rocketfi
cd /opt/rocketfi

# Use --frozen-lockfile in production to avoid accidental dependency drift
pnpm install --frozen-lockfile
```

---

## 4. Environment Variables

### API Server

```bash
cp artifacts/api-server/.env.example artifacts/api-server/.env
nano artifacts/api-server/.env
```

Minimum required values:

```env
PORT=8080
DATABASE_URL=postgresql://rocketfi:your-strong-password@localhost:5432/rocketfi
SESSION_SECRET=<output of: openssl rand -base64 48>
ALLOWED_ORIGINS=https://yourdomain.com
NODE_ENV=production
SKIP_DEEP_BACKFILL=1
```

Optional but recommended:
```env
ALCHEMY_API_KEY=          # more reliable Solana RPC for LaunchLab live stream
BIRDEYE_API_KEY=          # USD prices for graduated DEX tokens (1h/6h stats)
SLACK_WEBHOOK_URL=        # alerts when pumpapi.io stream disconnects
```

### Object Storage (Google Cloud Storage) — optional

Without GCS, token image upload during coin creation and profile avatar upload
will return errors. All other features (trading, browsing, wallet auth, portfolio)
work without it.

To enable GCS:
1. Create a GCS bucket and a service account with Storage Object Admin role
2. Download the service account JSON key
3. Set these env vars:

```env
GOOGLE_APPLICATION_CREDENTIALS=/etc/rocketfi/gcs-key.json
GCS_PROJECT_ID=your-gcp-project-id
PUBLIC_OBJECT_SEARCH_PATHS=your-bucket/public,your-bucket/token-images
PRIVATE_OBJECT_DIR=your-bucket/private
```

### Frontend (build-time only)

```bash
cp artifacts/rocketfi/.env.example artifacts/rocketfi/.env.production
nano artifacts/rocketfi/.env.production
```

```env
# Required — your Solana wallet address that receives the 0.25% platform fee.
# Build fails without this to prevent accidentally deploying fee-free.
VITE_PLATFORM_FEE_RECIPIENT=YourSolanaWalletAddress

# Optional
VITE_ALCHEMY_API_KEY=      # browser-side RPC for swap simulation
VITE_GOOGLE_CLIENT_ID=     # enables "Sign in with Google"
```

---

## 5. Build

```bash
# Build the API server (outputs to artifacts/api-server/dist/)
pnpm --filter @workspace/api-server run build

# Build the frontend (reads .env.production; outputs to artifacts/rocketfi/dist/public/)
pnpm --filter @workspace/rocketfi run build
```

---

## 6. Database Migrations

Migrations run **automatically** when the API server starts for the first time.
They are idempotent — already-applied migrations are skipped.

To run manually (e.g. to verify before starting):

```bash
cd /opt/rocketfi
DATABASE_URL=postgresql://rocketfi:password@localhost:5432/rocketfi \
  node -e "
    import('@workspace/db').then(({ runMigrations }) =>
      runMigrations('lib/db/migrations').then(() => { console.log('done'); process.exit(0); })
    )
  "
```

---

## 7. Systemd Service (API Server)

```bash
sudo nano /etc/systemd/system/rocketfi-api.service
```

```ini
[Unit]
Description=RocketFi API Server
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/rocketfi
EnvironmentFile=/opt/rocketfi/artifacts/api-server/.env
ExecStart=/usr/bin/node --enable-source-maps /opt/rocketfi/artifacts/api-server/dist/index.mjs
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rocketfi-api

# Security hardening
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable rocketfi-api
sudo systemctl start rocketfi-api
sudo systemctl status rocketfi-api

# Stream logs
sudo journalctl -u rocketfi-api -f
```

---

## 8. Nginx

```bash
sudo nano /etc/nginx/sites-available/rocketfi
```

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Frontend — static files
    root /opt/rocketfi/artifacts/rocketfi/dist/public;
    index index.html;

    # Proxy /api/* → API server
    location /api/ {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # SSE: disable buffering for /api/*/stream — live feed won't work without this
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 3600s;
    }

    # SPA fallback — all non-API paths serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Aggressive cache for hashed static assets
    location ~* \.(js|css|png|jpg|svg|ico|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/rocketfi /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### SSL (Let's Encrypt)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

---

## 9. Health Check

```bash
curl http://localhost:8080/api/healthz
# → {"status":"ok"}
```

---

## 10. Redeploy

```bash
cd /opt/rocketfi
git pull
pnpm install --frozen-lockfile

# Rebuild
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/rocketfi run build

# Restart API (runs any new migrations on startup)
sudo systemctl restart rocketfi-api

# Reload Nginx to serve new frontend files (no restart needed)
sudo systemctl reload nginx
```

---

## Environment Variables Reference

### API Server (`artifacts/api-server/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | ✅ | Listen port (e.g. 8080) |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `SESSION_SECRET` | ✅ | JWT signing secret — generate with `openssl rand -base64 48` |
| `ALLOWED_ORIGINS` | ✅ | Comma-separated frontend origins (e.g. `https://yourdomain.com`) |
| `NODE_ENV` | ✅ | Must be `production` |
| `SKIP_DEEP_BACKFILL` | ✅ | Set `1` — skips full history scan on fresh deploy |
| `ALCHEMY_API_KEY` | Recommended | Reliable Solana RPC for LaunchLab live stream |
| `BIRDEYE_API_KEY` | Recommended | USD prices & 1h/6h stats for DEX tokens |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional | Path to GCS key JSON (enables image upload) |
| `GCS_PROJECT_ID` | Optional | GCP project ID (required if using GCS) |
| `PUBLIC_OBJECT_SEARCH_PATHS` | Optional | GCS paths for public images |
| `PRIVATE_OBJECT_DIR` | Optional | GCS path for private uploads |
| `RESEND_API_KEY` | Optional | Email OTP login (wallet login works without it) |
| `GOOGLE_CLIENT_ID` | Optional | Server-side Google OAuth validation |
| `PLATFORM_TREASURY_ADDRESS` | Optional | SOL deposit routing wallet |
| `SLACK_WEBHOOK_URL` | Optional | Stream health alerts |
| `LOG_LEVEL` | Optional | Default: `info` |

### Frontend (`artifacts/rocketfi/.env.production`, build-time only)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_PLATFORM_FEE_RECIPIENT` | ✅ | Your Solana wallet — receives 0.25% platform fee |
| `VITE_ALCHEMY_API_KEY` | Optional | Browser-side Solana RPC (fallback: publicnode.com) |
| `VITE_GOOGLE_CLIENT_ID` | Optional | Google sign-in button |

---

## What Works Without Optional Services

| Feature | Without GCS | Without Alchemy | Without Birdeye |
|---------|------------|-----------------|-----------------|
| Browse tokens | ✅ | ✅ | ✅ |
| Buy / Sell | ✅ | ✅ (slower RPC) | ✅ |
| Launch new coin | ✅ but no image | ✅ | ✅ |
| Profile avatar | ❌ upload fails | ✅ | ✅ |
| DEX token 1h/6h price | ✅ | ✅ | ❌ shows — |
| LaunchLab live stream | ✅ (free RPC fallback) | ✅ better reliability | ✅ |
