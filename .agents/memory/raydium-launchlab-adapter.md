---
name: Raydium LaunchLab adapter
description: Protocol facts, instruction detection strategy, and bonding curve constants for the raydium_launchlab indexer adapter.
---

## Program
- Program ID: `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` (mainnet)
- Platform string in DB: `raydium_launchlab`
- File: `artifacts/api-server/src/lib/adapters/raydium-launchlab.ts`

## Instruction log names (Anchor camelCase)
- Token creation:  `Instruction: createLaunchpad`
- Buy on curve:    `Instruction: buyToken`
- Sell on curve:   `Instruction: sellToken`
- Graduation:      `Instruction: migrate*` (any migrate prefix)

All of these are caught by the existing `detectInstructionType` regexes (`/Create/i`, `/Buy/i`, `/Sell/i`) in `solanaRpcBase.ts`. Graduation is caught by a custom `shouldProcess` override.

## Bonding curve constants (approximate — same AMM as pump.fun)
- Total supply: 1 billion tokens, 6 decimals → `1_000_000_000_000_000n` base units
- Initial virtual SOL reserves: **30 SOL** (approximation; gets corrected on first trade)
- Initial virtual token reserves: = total supply
- Initial market cap: 30 SOL in lamports (`30_000_000_000`)
- Price formula: `priceEth = solLamports / tokenAmount / 1000` (SOL per token, same as pump.fun)
- Market cap formula: `totalSupply × solLamports / tokenAmount` (in lamports)

**Why approximate initial reserves?** The true values come from the LaunchLab config API at runtime, but they're only needed to seed the virtual reserve columns. The constant-product update on the first trade corrects them.

## createLaunchpad instruction data decode
Multi-offset probe: tries byte offsets 40, 8, 72 (in that order) to find Borsh-encoded `name/symbol/uri` strings after the 8-byte Anchor discriminator. Offset 40 = disc(8) + mintA pubkey(32) is most likely. Falls back gracefully if none succeed (uses mint prefix as name placeholder).

## Watchdog
- `watchdogMs = 300_000` (5 minutes) — LaunchLab volume is ~10× lower than pump.fun so the longer window prevents spurious reconnects.

## Graduation handling
On graduation, the mint is NOT "new" in post-token-balances, so `extractNewMint` doesn't work. Instead `_extractMintFromBalances` reads the first non-SOL mint from pre-OR-post token balances.
