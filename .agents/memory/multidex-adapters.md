---
name: Multi-DEX adapter pattern
description: Architecture decisions for Raydium, PumpSwap, Meteora, Orca indexers
---

## Pattern

**Raydium**: REST polling every 60s from `api-v3.raydium.io/pools/info/list`. Too many pools for streaming on free RPC.

**PumpSwap / Meteora / Orca**: logsSubscribe streaming via `SolanaRpcIndexer`. Gated behind env var.

**Why:** PumpSwap generates 100+ swaps/sec. Free RPCs (PublicNode, Ankr) saturate the 32-slot event queue in under 1 second, causing non-stop "rpc: queue full" flooding. Even with `shouldProcess` filtering by instruction type (Buy/Sell/Swap), the volume is still too high.

**How to apply:** In production (VPS with Helius), set `ENABLE_STREAMING_ADAPTERS=1`. In Replit dev, leave unset — only pump.fun + Raydium polling run.

## Schema columns added (migration 0002)

- `pool_address TEXT` — DEX pool/pair address
- `quote_mint TEXT` — quote token of the pair (WSOL, USDC, etc.)
- `liquidity_usd DOUBLE PRECISION` — pool liquidity in USD
- `price_usd DOUBLE PRECISION` — latest price in USD
- `market_cap_usd DOUBLE PRECISION` — latest market cap in USD

## Price storage

Non-pump.fun tokens store prices in two ways:
- `price_eth` / `market_cap_eth` = lamports-equivalent (USD / solPrice * 1e9) — for frontend compat
- `price_usd` / `market_cap_usd` = raw USD — for Raydium/Birdeye updates without needing solPrice

SOL price fetched from Birdeye `/defi/price?address=WSOL` endpoint. Falls back to 150 if unavailable.

## Backfill

Run `pnpm --filter @workspace/api-server run backfill:birdeye` ONCE before starting VPS production.
Uses Birdeye tokenlist API (~25K CU for 500 tokens/DEX, well within 2.5M monthly limit).
Exchange IDs: raydium, orca, meteora, pump_amm (note: pump_amm not pumpswap).

## @workspace/db rebuild requirement

After schema changes to `lib/db/src/schema/tokens.ts`, must run:
```
cd lib/db && pnpm exec tsc -p tsconfig.json
```
before `typecheck` in api-server because api-server uses project references pointing at lib/db/dist/.
