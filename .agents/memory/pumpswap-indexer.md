---
name: PumpSwap indexer — lessons learned
description: Why the PumpSwap indexer was stubbed out and what the correct implementation strategy is
---

## Status
Stubbed out in raydium-amm.ts (no-op). Pending proper planning.

## Root cause of previous failures
1. **Per-mint `logsSubscribe { mentions: [mint] }` is unreliable** — PublicNode does not deliver notifications when the mint appears only in Address Lookup Tables (ALTs), not static account keys. Jupiter and aggregators always use ALTs. Confirmed: 22 subscriptions, zero notifications.

2. **Single program subscription floods the RPC queue** — Subscribing to `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` (PumpSwap program) works (notifications arrive), but PumpSwap has hundreds of swaps per second globally. Calling `getTransaction` for every notification overwhelms the free-tier RPC queue (max 32) instantly.

3. **Pool address pre-filter requires pool pubkeys** — The PumpSwap TradeEvent embeds the pool pubkey at bytes 8-39 of its "Program data:" log line (discriminator `67f4521f2cf57777`, base64 prefix `Z/RSHyz1`). Filtering by pool before calling getTransaction is the right approach, but requires knowing the pool addresses for our 22 graduated tokens.

4. **Pool address discovery approaches also fail**:
   - `getSignaturesForAddress` is blocked on PublicNode and Ankr (free tier) — returns -32052
   - PDA derivation needs Ed25519 curve check (not trivial without @solana/web3.js)
   - `@solana/web3.js` is not in the API server dependencies

## Correct implementation strategy (lazy pool discovery)
1. Subscribe to PumpSwap program (single subscription)
2. In `shouldProcess(logs)`: decode pool pubkey from "Program data:" (zero RPC, pure computation)
   - If pool in `poolToMint` → return true (known graduated pool)
   - If pool in `discoveredNonGraduated` → return false (known non-graduated)
   - If pool in `discoveryInFlight` → return false (already discovering)
   - If `discoveryInFlight.size >= 2` → return false (rate-limit discovery)
   - Else: add to `discoveryInFlight`, return true (trigger discovery in onEvent)
3. In `onEvent`: call `getTransaction` once to learn which mint was traded, add to `poolToMint`
4. Non-graduated pools go into `discoveredNonGraduated` (permanent skip set)

**Why:** Converges in 1-2 min after startup (one discovery call per unique pool seen), then O(1) filter with zero RPC. No startup RPC calls needed.

## Ed25519 / PDA notes
- `isOnEd25519Curve` requires BigInt arithmetic mod 2^255-19
- PumpSwap pool seeds: `[b"pool", base_mint_bytes, quote_mint_bytes]` — UNVERIFIED, need to confirm with test transaction
- Pool for `BvPb7Rv9KjpjDoCPavtBVsgoEVz6xQSKkmPBNfbdpump` is `4ki4txqy4ZEiWgT7ECsiRE2BYXMkUoasxu4k1sUcNXTD` (verified from event data offset 8)
