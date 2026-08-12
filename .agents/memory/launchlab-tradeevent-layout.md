---
name: LaunchLab TradeEvent fast-path layout
description: 147-byte Anchor event emitted by LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj on every BuyExactIn/SellExactIn
---

# LaunchLab TradeEvent — 147-byte layout

**Discriminator**: `bddb7fd34ee661ee` — same as pump.fun TradeEvent (same Anchor namespace). Different payload.

## Confirmed field offsets (verified by comparing BuyExactIn vs SellExactIn txs):

| offset | size | field | notes |
|--------|------|-------|-------|
| 0 | 8 | discriminator | `bddb7fd34ee661ee` |
| 8 | 32 | mint | token mint address |
| 40 | 32 | reserves (4×u64) | vSol, vTok, realSol, realTok (or similar) — interpretation uncertain |
| 72 | 8 | sol_amount | lamports transferred — **confirmed: 0.138787 SOL for sell test** |
| 80 | 8 | tok_amount | base units — **confirmed reasonable values** |
| 88 | 1 | is_buy | 1=BuyExactIn, 0=SellExactIn — **confirmed by diff across 2 txs** |
| 89 | 57 | trader+ts+extras | trader pubkey, timestamp, unknown fields |

## Key facts

- **shouldProcess must NOT match `CreateTokenAccount`** — Jupiter routes via LaunchLab and logs `CreateTokenAccount` from JUP6 outer program before `BuyExactIn` from LL inner. Old `/create|buy|sell/i` regex matched both and called getTransaction for every Jupiter-routed buy.
- **Correct shouldProcess**: exact match on `createLaunchpad`, `BuyExactIn`, `SellExactIn`, `SellExactOut`, `migrate`
- **creates**: no Anchor event emitted for `createLaunchpad` in any tx seen. Must use getTransaction. Only ~100/day so acceptable.
- **is_buy cross-check**: always validate byte 88 against instruction log (`BuyExactIn` / `SellExactIn`) for robustness.
- Trader address not available from log fast-path — must call getTransaction in background for DB persistence.

**Why:** `getTransaction` on every trade was adding 500ms–3s latency per event and consuming RPC credits causing rate-limit failures in backfill. Fast-path eliminates all RPC calls for the hot trade path.

**How to apply:** `parseTradeEventFromLogs()` in `raydium-launchlab.ts` encodes this layout. When editing, keep sol at offset 72, tok at offset 80, is_buy at offset 88, and guard against zero-amount events.
