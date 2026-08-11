---
name: pump.fun program upgrade (2025)
description: Pump.fun upgraded their on-chain program to a new architecture — same program ID, completely different instruction format. Manual tx building broke.
---

## What changed

Pump.fun upgraded the bytecode at program ID `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` to a new version that is fundamentally different:

- **No Metaplex**: Token-2022 with metadata extension replaces Metaplex `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`
- **Different global state**: `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf` (old: `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5zznTJ67bBb2GQZ`)
- **17 accounts** per create instruction (was 14)
- **New discriminator**: real create txs have discriminator `[51, 230, 133, 164, 1, 127, 131, 173]` (sha256("global:sell")[0:8] under the new Anchor IDL)
- **No borsh strings** in instruction data — name/symbol/uri now live in Token-2022 metadata extension, not the instruction

Old approach (borsh-encoded name+symbol+uri in data) fails with `InstructionDidNotDeserialize` (Anchor error 102).

## Fix: use pumpportal.fun API

`pumpportal.fun/api/trade-local` builds correctly-formatted transactions against whatever pump.fun program version is live. Always returns a `VersionedTransaction` in raw bytes.

```typescript
const res = await fetch("https://pumpportal.fun/api/trade-local", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    publicKey:        walletAddress,
    action:           "create",
    tokenMetadata:    { name, symbol, uri: metadataUri },
    mint:             mintKeypair.publicKey.toBase58(),
    denominatedInSol: "true",
    amount:           0,
    slippage:         10,
    priorityFee:      0.0005,
    pool:             "pump",
  }),
});
const bytes = new Uint8Array(await res.arrayBuffer());
const tx = VersionedTransaction.deserialize(bytes);
tx.sign([mintKeypair]); // mint partial sig before sending to wallet
```

For simulation: use `conn.simulateTransaction(tx, { replaceRecentBlockhash: true, sigVerify: false })`.

## Why

**Why:** pump.fun can upgrade their program (same address, new bytecode) at any time. Manual tx builders break silently on upgrades. Delegating to pumpportal is more resilient.

**How to apply:** Any time pump.fun create transactions fail with `InstructionDidNotDeserialize` or account-mismatch errors — check for a pump.fun program upgrade first, then ensure pumpportal API is still compatible.
