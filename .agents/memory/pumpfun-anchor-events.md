---
name: Pump.fun Anchor event log parsing
description: How to eliminate getTransaction RPC calls by parsing Anchor events directly from WebSocket log lines
---

## The Fix
Parse `Program data: <base64>` lines from Solana log subscription events instead of calling getTransaction.

Pump.fun emits Anchor events (`emit!()`) for every create and trade. These appear in the WebSocket `logsSubscribe` notification as `"Program data: <base64>"` lines — no additional RPC call needed.

## Anchor event discriminators (precomputed)
```
TradeEvent  discriminator: bddb7fd34ee661ee (hex)  = sha256("event:TradeEvent")[0:8]
CreateEvent discriminator: 1b72a94ddeeb6376 (hex)  = sha256("event:CreateEvent")[0:8]
```

## TradeEvent layout (borsh, 113 bytes total)
```
offset  size  field
0       8     discriminator
8       32    mint (pubkey, base58)
40      8     sol_amount (u64 LE, lamports)
48      8     token_amount (u64 LE, atomic units)
56      1     is_buy (bool)
57      32    user (pubkey, base58)
89      8     timestamp (i64 LE)
97      8     virtual_sol_reserves (u64 LE, lamports)
105     8     virtual_token_reserves (u64 LE)
```

TradeEvent gives virtualSolReserves and virtualTokenReserves DIRECTLY — no constant-product estimation needed. MC is exact.

## CreateEvent layout (borsh, variable length)
```
offset  size  field
0       8     discriminator
8       var   name (borsh string: u32le len + utf8)
...     var   symbol (borsh string)
...     var   uri (borsh string)
...     32    mint (pubkey)
...     32    bonding_curve (pubkey)
...     32    user (pubkey)
```

## Why: eliminates RPC bottleneck
Free public Solana RPCs (PublicNode, mainnet-beta.solana.com) return 429/−32005 for getTransaction at pump.fun volume (~600 tx/min). This made the indexer effectively dead.

Log parsing: 0 HTTP calls per trade, 600+ trades/minute processed with 100% fill rate.

## Other RPC notes
- Ankr free endpoint now requires API key (returns -32052 / 403) — do NOT include in fallback list
- mainnet-beta returns code 429 (not -32005) on rate limit — must check BOTH codes in retry logic
- All other free endpoints (Triton, Omnia, GetBlock, Alchemy demo) failed in testing

## Price edge case
Protocol fee/allocation events emit TradeEvent with sol_amount=0. Must check BOTH tokenAmount != "0" AND solLamports != "0" before computing priceEth — otherwise writes 0.000...0 over the last valid price.

**How to apply:** Any time pumpfun.ts is modified — log parsing is the primary data path, getTransaction is only a fallback.
