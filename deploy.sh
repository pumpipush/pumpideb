#!/bin/bash
# ── Pumpi deploy script ────────────────────────────────────────────────────────
# Usage: bash /opt/rocketfi/deploy.sh
# Run from anywhere — always operates on /opt/rocketfi.
set -euo pipefail

cd /opt/rocketfi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║          Pumpi.io  Deploy            ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. Pull latest code ───────────────────────────────────────────────────────
echo "▶ git pull..."
git pull origin main
echo ""

# ── 2. Install/update dependencies ───────────────────────────────────────────
echo "▶ Installing dependencies..."
pnpm install --frozen-lockfile
echo ""

# ── 3. Build & reload API (zero-downtime rolling restart) ─────────────────────
echo "▶ Building API..."
pnpm --filter @workspace/api-server run build
pm2 reload rocketfi-api --update-env
echo "✓ API live"
echo ""

# ── 3. Build frontend ─────────────────────────────────────────────────────────
# Env vars Vite needs at build time — set here so no separate .env file needed.
export VITE_PLATFORM_FEE_RECIPIENT="JBCqngc3TYcz3Rtv5Md3CZyw8X6AxLik7gswCCttRS5E"
export VITE_PUMP_FEE_RECIPIENT="JBCqngc3TYcz3Rtv5Md3CZyw8X6AxLik7gswCCttRS5E"

echo "▶ Building frontend (rocketfi)..."
pnpm --filter @workspace/rocketfi run build

# Point nginx to the new dist/public (atomic symlink swap)
# Must point to dist/public — dist/ alone has no index.html and returns 403
ln -sfn /opt/rocketfi/artifacts/rocketfi/dist/public /opt/rocketfi/current
echo "✓ Frontend live"
echo ""

# ── 4. Build admin dashboard ──────────────────────────────────────────────────
echo "▶ Building admin dashboard..."
pnpm --filter @workspace/admin run build

# Point nginx admin root to the new admin build
ln -sfn /opt/rocketfi/artifacts/admin/dist/public /opt/rocketfi/admin-current
echo "✓ Admin live"
echo ""

echo "══════════════════════════════════════"
echo "  Deploy selesai! 🚀"
echo "  pumpi.io      → rocketfi app"
echo "  admin.pumpi.io → admin dashboard"
echo "══════════════════════════════════════"
echo ""
