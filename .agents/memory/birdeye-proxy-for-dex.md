---
name: Birdeye proxy for DEX token detail pages
description: How OHLCV, price-history, and stats endpoints fall back to Birdeye for DEX tokens with no internal trade history
---

## The pattern

DEX tokens (raydium, orca, meteora, pumpswap, raydium_launchlab) have no rows in the `trades` table in dev (streaming adapters are disabled). Without this proxy, token detail pages load as empty templates.

The fix lives in `artifacts/api-server/src/routes/trades.ts`:

1. **OHLCV** (`GET /tokens/:address/ohlcv?tf=`): After computing `bars` from the trades table, if `bars.length === 0` AND the token's `platform` is in `DEX_PLATFORMS`, call `fetchBirdeyeOHLCV(address, tf, timeFrom, now)` and convert USD prices → SOL/token by dividing by `getSolPriceUsd()`.

2. **price-history** (`GET /tokens/:address/price-history`): After querying trades for p5m/p1h/p6h/p24h, if all values are null AND platform is a DEX, call `fetchBirdeyeTokenOverview()` and compute historical prices from `currentSol / (1 + pct/100)`.

3. **stats** (`GET /tokens/:address/stats`): If vol24h_sol=0 AND platform is a DEX, use Birdeye `overview.v24hUSD / solPrice` as vol24h.

**Why:** pump.fun uses priceEth in SOL units (e.g. 2.84e-8). Birdeye returns USD. Divide by solPrice to get the same SOL/token unit. Frontend multiplies by SOL price to get USD display.

## pctChange24h for list/bubble views

`fetch24hPctChanges()` in tokens.ts queries the trades table (pump.fun only works). DEX tokens need a fallback to the `tokens.pct_change_24h` DB column.

**How it works now:**
1. SQL query: first/last price_eth from trades within 24h
2. For addresses not in step 1 result: query `tokens.pct_change_24h` column

**Populating pct_change_24h:**
- `formatToken()` now falls back to `t.pctChange24h` (DB column) when no live argument provided
- `enrich-dex-pct.mjs` script: queries Birdeye token_overview for top 300 DEX tokens, stores in DB
- Meteora backfill uses `fetchBirdeyeTokenMeta()` which now includes `priceChange24hPercent`
- Re-run `node artifacts/api-server/dist/scripts/enrich-dex-pct.mjs` periodically to refresh

## DB schema
- `tokens.pct_change_24h DOUBLE PRECISION` — migration 0003
- Set by `enrich-dex-pct.mjs`, also updated during Meteora backfill

## Birdeye timeframes
BIRDEYE_HISTORY_SECS map in trades.ts: 1m→4h, 5m→24h, 15m→3d, 1H→30d, 4H→90d, 1D→1y, 1W→2y. Birdeye tf param names match internal names exactly.
