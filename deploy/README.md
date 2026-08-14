# Deployment

Configuration files for the production VPS.

## Nginx

`nginx/rocketfi` is the nginx site config for `rocketfi.app`.

### Apply to the VPS

```bash
# 1. Copy the config
scp deploy/nginx/rocketfi user@your-vps:/etc/nginx/sites-available/rocketfi

# 2. Enable the site (if not already symlinked)
ssh user@your-vps "ln -sf /etc/nginx/sites-available/rocketfi /etc/nginx/sites-enabled/rocketfi"

# 3. Test the config
ssh user@your-vps "nginx -t"

# 4. Reload nginx (zero-downtime)
ssh user@your-vps "systemctl reload nginx"
```

### Cache strategy

| Resource | Cache-Control | Why |
|---|---|---|
| `index.html` / SPA routes | `no-cache, no-store, must-revalidate` | Vite hashes JS/CSS filenames on every build; a cached HTML referencing old chunk names → blank page on mobile |
| `*.js`, `*.css`, fonts, images | `public, max-age=31536000, immutable` | Filenames already contain a content hash; safe to cache forever |
| `/api/*` | no caching (proxied) | Dynamic API responses |
