---
name: DEX token priceEth storage convention
description: priceEth must be stored as SOL/token (NOT lamports) for all platforms; marketCapEth stays in lamports
---

## The rule

`priceEth` = SOL per token (a small decimal, e.g. 1084.3 for cbBTC at $83K, 0.01298 for a $1 stablecoin).
Frontend multiplies: `priceEth × solPrice = USD price`.

`marketCapEth` = lamports. `formatMCUsd()` divides by 1e9 before multiplying by solPrice.

**Why:** pump.fun computes `priceEth = virtualEthReserves / virtualTokenReserves` which naturally gives SOL/token. DEX backfill originally used `usdToLamports(priceUsd, solPrice)` = `priceUsd/solPrice × 1e9` — a million× too large. Frontend showed BSC-USDT ($1) as $992M.

## How to apply

In all DEX adapters and backfill scripts:
```typescript
// priceEth — SOL/token (NOT lamports)
const priceEth = priceUsd && solPrice > 0 ? String(priceUsd / solPrice) : null;
// marketCapEth — lamports (divide by 1e9 to get SOL)
const marketCapEth = mcUsd && solPrice > 0 ? usdToLamports(mcUsd, solPrice) : null;
```

## Safe DB update (if old lamport rows exist)

pump_fun priceEth is always < 1. DEX lamport rows are > 1000. Safe filter:
```sql
UPDATE tokens SET price_eth = (price_eth::numeric / 1e9)::text
WHERE platform IN ('raydium', 'orca', 'meteora', 'pumpswap', 'raydium_launchlab')
  AND price_eth IS NOT NULL AND price_eth::numeric > 1000;
```

## effectiveMcEth bug

DEX tokens have pump.fun default virtual reserves (3e21 SOL, 1e27 token).
The fallback formula produces ~$229B fake market cap. Fix: skip formula for DEX platforms;
use `marketCapUsd / solPrice × 1e9` if available, else return null (show "—").
Frontend check: `const isDexToken = DEX_PLATFORMS_SET.has(token?.platform ?? "")`.
