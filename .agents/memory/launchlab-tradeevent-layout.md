---
name: LaunchLab TradeEvent fast-path layout
description: 147-byte Anchor event emitted by LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj on every BuyExactIn/SellExactIn — mint REMOVED from event in mid-2026
---

# LaunchLab TradeEvent — 147-byte layout (updated Aug 2026)

**Discriminator**: `bddb7fd34ee661ee` — same as pump.fun TradeEvent (same Anchor namespace).

## ⚠️ Breaking change (Aug 2026): mint removed from TradeEvent

Raydium changed the TradeEvent so that bytes 8-40 now hold the **pool state account address** (owner=LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj, len=429) rather than the token mint pubkey.

The **token mint is NOT embedded in the event** anymore. It must be resolved from the pool state account.

## Current field offsets

| offset | size | field | notes |
|--------|------|-------|-------|
| 0 | 8 | discriminator | `bddb7fd34ee661ee` |
| 8 | 32 | **poolAddress** | LaunchLab pool/bonding-curve state account — NOT the mint |
| 40 | 32 | reserves (4×u64) | vSol, vTok, realSol, realTok (or similar) |
| 72 | 8 | sol_amount | lamports transferred |
| 80 | 8 | tok_amount | base units transferred |
| 88 | 1 | is_buy | 1=BuyExactIn, 0=SellExactIn |
| 89 | 57 | trader+ts+extras | trader pubkey, timestamp, unknown fields |

## Pool state → token mint

The 429-byte pool state account has the **token mint at offset 205** (32 bytes):
- Verified by finding Low Cortisol mint `HxfH5ai9JTnix4ub1ewTks6HTNM83YDi3yunbvFoYray` at offset 205 in pool `6mgg1AfsywHMXDrqESz84h3hpkrGVXrjnPoYvEthMfCW`

## Fix implemented

`getMintForPool(poolAddress)` in `raydium-launchlab.ts`:
- Calls `getAccountInfo(poolAddress, {encoding:"base64"})`
- Reads 32 bytes at offset 205 → bs58-encodes → token mint
- Caches in `_poolMintCache: Map<string,string>` (one RPC call per pool lifetime)
- `parseTradeEventFromLogs()` now returns `poolAddress` instead of `mint`

## Historical damage

Between the TradeEvent change and the fix, ~443 garbage tokens and ~4036 trades were created with pool account addresses (and non-existent addresses) stored as token mint addresses. These were deleted from the DB when the fix was deployed.

**Why:** `getTransaction` on every trade was adding 500ms–3s latency per event. Fast-path eliminates all RPC calls for the hot trade path. With the new layout, only 1 getAccountInfo call per NEW token (pool) is needed.

**How to apply:** `parseTradeEventFromLogs()` returns `poolAddress`, then `getMintForPool()` resolves the mint. Keep sol at offset 72, tok at offset 80, is_buy at offset 88.
