---
name: Solana RPC rate limits
description: PublicNode free RPC rate-limits getTransaction at pump.fun's volume; fallback RPC list is configured in solanaRpcBase.ts.
---

## Rule
PublicNode (`https://solana-rpc.publicnode.com`) returns error code **-32005** ("Rate limit exceeded") when pump.fun's ~5-10 create events/second are all hitting `getTransaction`. Solana Foundation (`api.mainnet-beta.solana.com`) returns **429** similarly.

## Current setup
`artifacts/api-server/src/lib/adapters/solanaRpcBase.ts` exports `FALLBACK_HTTP_RPCS`:
```
["https://api.mainnet-beta.solana.com", "https://rpc.ankr.com/solana"]
```
`rpcCall` tries each in order, silently skipping on -32005 or 429. All three being exhausted logs a warn and returns null.

**Why:** No single free RPC handles pump.fun's volume. Round-robin across 3 endpoints improves throughput without a paid key.

## Concurrency settings
- `_rpcMaxConcurrent = 4` — keep low; raising to 8 worsened rate limiting
- `_rpcQueueMax = 32` — small queue so stale events are dropped quickly
- Timeout per call: 8s (reduced from 12s to fail faster and free slots)

## Structural limit
Even with fallbacks, many events are dropped at pump.fun's scale. Task #39 "Prevent missed trades when the free RPC is overloaded" tracks a proper solution (likely a paid RPC or different subscription method).
