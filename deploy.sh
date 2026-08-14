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

# ── 2. Build & reload API (zero-downtime rolling restart) ─────────────────────
echo "▶ Building API..."
pnpm --filter @workspace/api-server run build
pm2 reload rocketfi-api --update-env
echo "✓ API live"
echo ""

# ── 3. Build frontend ─────────────────────────────────────────────────────────
# Env vars Vite needs at build time — set here so no separate .env file needed.
export VITE_PLATFORM_FEE_RECIPIENT="JBCqngc3TYcz3Rtv5Md3CZyw8X6AxLik7gswCCttRS5E"

echo "▶ Building frontend..."
pnpm --filter @workspace/rocketfi run build

# Point nginx to the new dist (atomic symlink swap)
ln -sfn /opt/rocketfi/artifacts/rocketfi/dist /opt/rocketfi/current
echo "✓ Frontend live"
echo ""

echo "══════════════════════════════════════"
echo "  Deploy selesai!"
echo "══════════════════════════════════════"
echo ""
