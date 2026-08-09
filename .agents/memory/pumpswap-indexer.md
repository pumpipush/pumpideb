---
name: PumpSwap indexer integration
description: PumpSwap AMM detection added inside raydium-amm.ts, not as a separate file.
---

# PumpSwap indexer

## Rule
PumpSwap swap detection is embedded in `raydium-amm.ts` — NOT a separate adapter file.

**Why:** Both Raydium AMM v4 and PumpSwap share the same per-mint subscription infrastructure
(`logsSubscribe {mentions: [mint]}`). Sharing one subscriber avoids duplicate WebSocket
connections per graduated mint. The `detectDexPlatform(logs)` function routes to the correct
platform by matching instruction names in the log lines.

## How to apply
- To change PumpSwap detection: edit `detectDexPlatform()` in `raydium-amm.ts`.
- PumpSwap program: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- PumpSwap instruction names in logs: `Instruction: Buy` / `Instruction: Sell`
- Must also check that the PumpSwap program ID appears in logs (same instruction names as bonding curve).
- Trade platform value stored in DB: `"pumpswap"` (trades table, text column — no enum constraint).

## Detection logic
```
detectDexPlatform(logs):
  SwapBaseIn/SwapBaseOut → "raydium_amm"
  "Swap" (CPMM)         → "raydium_amm"
  PumpSwap program ID in logs + Buy/Sell → "pumpswap"
  else → null (skip)
```

## Subscription flow
1. pump.fun bonding curve fills → `handleGraduation` → `registerGraduatedMint(mint)`
2. `registerGraduatedMint` adds mint to `RaydiumMultiSubscriber` (one logsSubscribe per mint)
3. Any trade notification for that mint goes through `detectDexPlatform` to route AMM type
4. `handleSwap(signature, mint, platform)` inserts trade and emits SSE with correct platform name
