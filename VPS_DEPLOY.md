# VPS Deployment Guide

## Prerequisites
- Node.js 20+ and pnpm 9+
- PostgreSQL 15+
- nginx
- PM2 (process manager)
- A GCS bucket (for token images/metadata) — or keep using Replit Object Storage

---

## 1. Clone & Install

```bash
git clone <your-repo> /opt/pumpi
cd /opt/pumpi
pnpm install --frozen-lockfile
```

---

## 2. Environment Variables

### API Server (`artifacts/api-server/.env`)

```env
# Required
NODE_ENV=production
PORT=8080
DATABASE_URL=postgresql://user:password@localhost:5432/pumpi

# Required — generate with: openssl rand -hex 64
SESSION_SECRET=<64-char-random-hex>

# Required — restrict frontend cross-origin access (comma-separated)
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com

# GCS Object Storage (VPS mode)
# Point to your service account JSON key file
GOOGLE_APPLICATION_CREDENTIALS=/opt/pumpi/secrets/gcs-service-account.json
GCS_PROJECT_ID=your-gcp-project-id
DEFAULT_OBJECT_STORAGE_BUCKET_ID=your-gcs-bucket-name
PUBLIC_OBJECT_SEARCH_PATHS=token-images,token-meta
PRIVATE_OBJECT_DIR=private

# Solana RPC (required for indexing)
ALCHEMY_API_KEY=your_alchemy_key

# Optional — Birdeye for DEX prices
BIRDEYE_API_KEY=your_birdeye_key

# Optional — Email OTP sign-in (required if using email auth)
RESEND_API_KEY=your_resend_key

# Optional — Google OAuth
GOOGLE_CLIENT_ID=your_google_oauth_client_id

# Optional — enable real-time streaming adapters (PumpSwap, Meteora, Orca)
ENABLE_STREAMING_ADAPTERS=1
```

### Frontend build (set before running `pnpm run build`)

```env
# No PORT needed during build; it uses default 3000 automatically
BASE_PATH=/                              # or /app if running under a subpath
VITE_ALCHEMY_API_KEY=your_alchemy_key   # Solana RPC for wallet transactions

# Platform fee — your wallet address receives 1% on trades + flat fee on launch
VITE_PLATFORM_FEE_RECIPIENT=YourSolanaWalletAddress

# Google OAuth (if using social sign-in)
VITE_GOOGLE_CLIENT_ID=your_google_oauth_client_id
```

---

## 3. Build

```bash
# Build API server
cd /opt/pumpi/artifacts/api-server
pnpm run build

# Build frontend (set env vars first)
cd /opt/pumpi/artifacts/rocketfi
BASE_PATH=/ VITE_ALCHEMY_API_KEY=xxx VITE_PLATFORM_FEE_RECIPIENT=xxx pnpm run build
# Output: artifacts/rocketfi/dist/public/
```

---

## 4. Database

```bash
# Run migrations
cd /opt/pumpi/artifacts/api-server
DATABASE_URL=postgresql://... pnpm run db:push
```

---

## 5. PM2 Process

```bash
# Start API server
pm2 start /opt/pumpi/artifacts/api-server/dist/index.mjs \
  --name pumpi-api \
  --env-file /opt/pumpi/artifacts/api-server/.env \
  --node-args="--enable-source-maps"

pm2 save
pm2 startup
```

---

## 6. nginx Config

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Serve frontend static files
    root /opt/pumpi/artifacts/rocketfi/dist/public;
    index index.html;

    # Frontend — SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API server proxy
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # SSE streams (live feed) — disable buffering
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

---

## 7. SSL

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d yourdomain.com
```

---

## Security Checklist

| Item | Status |
|------|--------|
| SESSION_SECRET set to random 64-char hex | ✅ Will throw on startup if missing |
| CORS restricted to your domain only | ✅ Set ALLOWED_ORIGINS |
| OTP not logged in production | ✅ Throws instead of logging |
| GCS auth via service account (not Replit sidecar) | ✅ Set GOOGLE_APPLICATION_CREDENTIALS |
| VITE_PLATFORM_FEE_RECIPIENT set | ✅ Build fails with clear error if absent (set `ALLOW_MISSING_FEE_RECIPIENT=1` to override) |
| ALCHEMY_API_KEY set | ⚠️ Required for Solana indexing |
| DATABASE_URL points to production DB | ⚠️ Required |
| nginx SSL configured | ⚠️ Required for production |

---

## Known Warnings (non-blocking)

- `raydium_launchlab: could not resolve mint from pool state` — Some LaunchLab pool state accounts are in a format the decoder hasn't seen yet. These trades are skipped gracefully; token data still appears via the backfill path.
- Large JS chunks (1.1 MB / 1.3 MB gzip: 311 KB / 390 KB) — functional but consider code splitting in future.
