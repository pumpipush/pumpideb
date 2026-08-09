---
name: pump.fun on-chain swap structure
description: Transaction builder details for pump.fun bonding curve buy/sell — discriminators, account ordering, PDA seeds, Vite polyfill setup.
---

# pump.fun bonding curve on-chain swap

## Instruction discriminators (Anchor sha256("global:<name>")[0:8])
- buy:  `[102, 6, 61, 18, 1, 218, 235, 234]`
- sell: `[51, 230, 133, 164, 1, 127, 131, 173]`

## Instruction args (u64 LE encoded)
- buy(amount=tokenAtoms, maxSolCost=lamports)
- sell(amount=tokenAtoms, minSolOutput=lamports)

## Accounts — BUY (order matters):
global, feeRecipient, mint, bondingCurve, associatedBondingCurve, associatedUser, user(signer), systemProgram, tokenProgram, **rent**, eventAuthority, program

## Accounts — SELL (order matters):
global, feeRecipient, mint, bondingCurve, associatedBondingCurve, associatedUser, user(signer), systemProgram, **associatedTokenProgram**, tokenProgram, eventAuthority, program

Key difference: buy has `SYSVAR_RENT_PUBKEY` (creates user ATA if needed); sell has `ASSOCIATED_TOKEN_PROGRAM_ID` (ATA must already exist).

## PDA seeds
- bondingCurve: `["bonding-curve", mint.toBuffer()]`, program = PUMP_FUN_PROGRAM_ID
- ATA: `[owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()]`, program = ASSOCIATED_TOKEN_PROGRAM_ID

## Known fixed addresses
- Program: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- Global state: `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5zznTJ67bBb2GQZ`
- Protocol fee recipient: `CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM`
- Event authority: `Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1`

## Vite + @solana/web3.js setup
`vite-plugin-node-polyfills` is required — add to vite.config.ts:
```ts
nodePolyfills({ globals: { Buffer: true, global: true, process: true }, protocolImports: true })
```
Without this, `Buffer` is undefined in the browser and @solana/web3.js crashes.

## Slippage parameter convention
- buy:  maxSolCost  = solIn  × (10000 + slippageBps) / 10000  (lamports ceiling)
- sell: minSolOutput = solOut × (10000 - slippageBps) / 10000  (lamports floor)

## Platform fee
Appended as a separate `SystemProgram.transfer` instruction (not part of pump.fun program).
0.25% of solIn (buy) or estimated solOut (sell). Reads from `VITE_PUMP_FEE_RECIPIENT` env var; skipped if not set.

**Why:** pump.fun's on-chain feeRecipient is fixed to their protocol wallet; our referral fee must be a separate instruction.
