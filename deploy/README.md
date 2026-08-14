# Deployment

Configuration files for the production VPS.

## Nginx

`nginx/rocketfi` is the nginx site config for `rocketfi.app`.

### Automated deployment (recommended)

Use `deploy/deploy-nginx.sh` to copy the config, enable the site, test it,
and reload nginx in a single command:

```bash
./deploy/deploy-nginx.sh user@your-vps
```

The script accepts the VPS host as a positional argument **or** via the
`VPS_USER_HOST` environment variable, which makes it easy to wire into CI:

```yaml
# Example GitHub Actions step
- name: Deploy nginx config
  run: ./deploy/deploy-nginx.sh
  env:
    VPS_USER_HOST: ${{ secrets.VPS_USER_HOST }}
```

Prerequisites:
- SSH key-based access to the VPS (no interactive password prompt)
- The remote user must have `sudo` rights for nginx commands

Additional environment variables (all optional):

| Variable | Default | Description |
|---|---|---|
| `VPS_USER_HOST` | _(required if not passed as arg)_ | `user@host` of the VPS |
| `NGINX_SITE` | `rocketfi` | Site name under `sites-available/` |
| `NGINX_DIR` | `/etc/nginx` | Root nginx directory on the VPS |

### Manual steps (reference)

```bash
# 1. Copy the config
scp deploy/nginx/rocketfi user@your-vps:/etc/nginx/sites-available/rocketfi

# 2. Enable the site (if not already symlinked)
ssh user@your-vps "sudo ln -sf /etc/nginx/sites-available/rocketfi /etc/nginx/sites-enabled/rocketfi"

# 3. Test the config
ssh user@your-vps "sudo nginx -t"

# 4. Reload nginx (zero-downtime)
ssh user@your-vps "sudo systemctl reload nginx"
```

### Cache strategy

| Resource | Cache-Control | Why |
|---|---|---|
| `index.html` / SPA routes | `no-cache, no-store, must-revalidate` | Vite hashes JS/CSS filenames on every build; a cached HTML referencing old chunk names → blank page on mobile |
| `*.js`, `*.css`, fonts, images | `public, max-age=31536000, immutable` | Filenames already contain a content hash; safe to cache forever |
| `/api/*` | no caching (proxied) | Dynamic API responses |
