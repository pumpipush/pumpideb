---
name: Graduated token price guards
description: Two separate jobs that must not write bonding-curve-based prices/reserves for graduated pump.fun tokens
---

# Graduated token price guards

## The rule
Never apply pump.fun constant-product AMM math (vSol × vTok = k) to a token with `tokens.graduated = true`. After graduation the bonding curve is dead; replaying trades with it produces nonsense prices and market caps.

**Why:** Bonding curve reserves freeze at migration. The post-graduation price lives in the Raydium/PumpSwap AMM. Any attempt to "fix" graduated token data with the old formula makes values worse.

## How to apply

### 1. `backfillBondingCurves()` — `artifacts/api-server/src/lib/enrichment.ts`
WHERE clause must include `eq(tokensTable.graduated, false)` alongside the platform and virtualEthReserves filters. Without it, the startup backfill overwrites a graduated token's correct market cap with a wrong bonding-curve estimate.

### 2. `healZeroAmountTrades()` — `artifacts/api-server/src/lib/adapters/pumpfun.ts`
The SELECT that finds tokens to heal already JOINs tokensTable and filters `eq(tokensTable.graduated, false)`. Preserve this join and filter in any future refactor.

### 3. `healTokenTrades()` price ceiling — same file
Before writing a derived `priceEth`, check `derivedPriceEth > 0.01` (HEAL_PRICE_CEILING). If above ceiling, log a warning and skip the DB write (but still advance virtual reserves). This prevents AMM-replay divergence from corrupting chart data even for non-graduated tokens.

### 4. OHLCV / price-history SQL — `artifacts/api-server/src/routes/trades.ts`
Every query over `trades.price_eth` includes `AND CAST(price_eth AS DOUBLE PRECISION) < 1.0`. This is the second line of defence — ensures bad prices already in the DB cannot appear in charts.
