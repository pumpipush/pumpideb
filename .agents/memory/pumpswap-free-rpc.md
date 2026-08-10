---
name: PumpSwap free-RPC throttling
description: How to run PumpSwap adapter on free RPC without flooding the queue
---

## Rule
PumpSwap's `shouldProcess` filter must match ONLY `CreatePool` (for new pools) and `Buy`/`Sell` (for trades). Never use generic `Create`, `Initialize`, or `Swap` — they match thousands of unrelated Solana instructions and flood the RPC queue instantly.

Trades must be throttled to at most 1 event per ~3000ms (configurable via `_tradeIntervalMs`).

**Why:** PumpSwap generates 100-200+ events/second on logsSubscribe. Free RPC (publicnode) can sustain ~1-2 concurrent `getTransaction` calls. Without filtering + throttling, the 32-slot queue fills in <1 second and every event is dropped.

## HTTP fallbacks
Only keep keyless endpoints:
- `https://solana-rpc.publicnode.com` (primary)
- `https://api.mainnet-beta.solana.com` (fallback)

Remove Ankr (`rpc.ankr.com/solana`) — returns -32052/403 without API key. Triton and Omnia also require keys.

**How to apply:** Any time PumpSwap or similar high-volume Solana DEX adapter is added, audit `shouldProcess` for generic instruction names before enabling.

## Trade data quality on free RPC
At 1 trade/3s = ~20 samples/minute across ALL PumpSwap tokens. Sparse but accurate (real on-chain data). For proper coverage, a paid RPC (Helius free tier: 100 req/s) is needed.
