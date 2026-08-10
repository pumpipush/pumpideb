---
name: Birdeye proxy for DEX token pages
description: OHLCV/price-history/stats/trades proxy to Birdeye when internal trades table is empty; field names, trade dedup, and current-candle synthetic bar
---

## What this covers

For DEX tokens (raydium, orca, meteora, pumpswap, raydium_launchlab), internal `trades` table is empty because streaming adapters are disabled in dev. All live data comes from Birdeye.

## Endpoints that proxy to Birdeye

1. **`GET /ohlcv`** — `fetchBirdeyeOHLCV` + `fetchBirdeyeTokenOverview` in parallel.
   - Convert bar prices USD→SOL (÷solPrice)
   - Append synthetic current candle using `overview.price` so chart last bar matches live price
   - Background-update `token.price_eth` + `token.price_usd` in DB (non-fatal)

2. **`GET /price-history`** — use Birdeye's `history5mPrice`, `history1hPrice`, `history6hPrice`, `history24hPrice` **directly** (NOT computed from % change — that's stale and inaccurate)

3. **`GET /stats`** — `fetchBirdeyeTokenOverview` for vol24h. Use `vBuy24hUSD`/`vSell24hUSD` for accurate buy/sell split. Use `buy24h`/`sell24h` for txn counts.

4. **`GET /trades`** — `fetchBirdeyeTokenTrades` (`/defi/txs/token?tx_type=swap&sort_type=desc`).
   - **Dedup by txHash** — Birdeye returns each leg of multi-hop swaps separately; keep the leg where our token is in `from` or `to`.
   - Compute `isBuy`: `to.address === tokenAddress` → true; `from.address === tokenAddress` → false; else `side === "buy"`
   - `tokenAmount` = `uiAmount × 10^decimals` (atomic)
   - `ethAmount` = other-side value in USD ÷ solPrice × 1e9 (lamports)
   - `priceEth` = `tokenPrice / solPrice`
   - Use synthetic negative IDs to avoid collision with real DB IDs

## Birdeye field name gotchas

- Market cap: field is `marketCap` (NOT `mc`!) — `n("marketCap") ?? n("mc")`
- Volume fields: `v24hUSD`, `vBuy24hUSD`, `vSell24hUSD`
- Txn counts: `buy24h`, `sell24h`
- Historical prices: `history5mPrice`, `history1hPrice`, `history6hPrice`, `history8hPrice`, `history24hPrice`
- Supply: `circulatingSupply` (number, e.g. 3363 for cbBTC)
- Trade item structure: `from`/`to` (each has `address`, `uiAmount`, `price`, `decimals`, `changeAmount`)

## pct_change_24h DB column (migration 0003)

`DOUBLE PRECISION` column on `tokens` table. Populated by `enrich-dex-pct.mjs` (run periodically, e.g. every 6h). `fetch24hPctChanges()` in `tokens.ts` falls back to this column for addresses with no internal trades.

**Why:** The `GET /price-history` endpoint computes % changes on-the-fly from Birdeye; this column is a cache for the explore/bubble chart which can't call Birdeye per-token.

## Price consistency (frontend)

`priceStats.currentPrice` in `AppInterface.tsx` for DEX tokens reads from `serverOhlcv?.bars?.slice(-1)[0]?.close` (last OHLCV bar's close, which has the synthetic current price). This keeps price panel and chart in sync.

## Trade display loading time

Birdeye proxy trades take ~1.5s. The Trades tab shows skeleton rows during this time — expected, not a bug. Trades refresh every 10s (`refetchInterval: 10_000`).

## priceEth filter bug (trades endpoint)

The `CAST(priceEth AS DOUBLE PRECISION) < 1.0` guard is for pump.fun only. For DEX tokens (e.g. cbBTC at ~848 SOL/token), this filter must be skipped. Check `DEX_PLATFORMS.has(platform)` and set `isDex` flag to skip the filter.
