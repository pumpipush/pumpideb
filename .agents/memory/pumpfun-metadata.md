---
name: pump.fun metadata sources
description: How to get pump.fun token name/symbol/image — REST API is blocked from Replit servers; on-chain decode is the correct approach.
---

## Rule
Never rely on `https://frontend-api.pump.fun/coins/{mint}` from a hosted (Replit) server. It returns **HTTP 530** (Cloudflare block). Use on-chain instruction data decoding instead.

## How to apply
In `pumpfun.ts` `handleCreate`, decode the CREATE instruction data directly from the `getTransaction` response:

1. Find the pump.fun program index in `transaction.message.accountKeys`
2. Find the instruction with that `programIdIndex` in `transaction.message.instructions`
3. Base58-decode `instruction.data`
4. Skip 8 bytes (Anchor discriminator)
5. Read 3 borsh strings (u32le length + utf8 bytes): `name`, `symbol`, `uri`
6. Fire-and-forget: fetch `uri` JSON → `json.image` for the image URL

**Why:** The pump.fun REST API is behind Cloudflare which blocks datacenter IPs. All metadata is also available on-chain in the CREATE instruction so no external call is needed.

## For enrichment of existing tokens
The enrichment loop (`artifacts/api-server/src/lib/enrichment.ts`) tries pump.fun API first then falls back to Raydium's `/mint/ids` endpoint. Raydium covers pump.fun tokens that have active trading (a few minutes after launch).

## Key constants (pump.fun bonding curve)
- Initial virtualSolReserves: 30,000,000,000 lamports (30 SOL)
- Initial virtualTokenReserves: 1,073,000,191,045 tokens
- These are fixed protocol constants — not in instruction data — can be used to compute initial market cap without any API call (task #43 tracks this).
