---
name: pump.fun parseSwap token delta
description: Why tokenAmount is 0 for most trades and how the fix works
---

## The cancellation bug

`parseSwap` previously SUMMED all token account deltas per mint. Since every swap
involves two accounts for the same mint (trader +X, bonding curve −X), they cancel
to zero → `tokenAmount = "0"` → `priceEth = null`.

About 90% of historical trades (before 2026-08-08) have `token_amount = '0'` and
`price_eth = NULL` because of this.

## The fix (solanaRpcBase.ts)

Instead of summing, collect per-account deltas and pick the **single largest-magnitude
individual account delta** whose direction matches the SOL-based `isBuy` flag:

```typescript
const isBuy = solDelta < 0;  // negative = fee-payer spends SOL = buy
const matching = perAccount.filter(e => isBuy ? e.delta > 0n : e.delta < 0n);
const best = (matching.length > 0 ? matching : perAccount)
  .reduce((a, b) => abs(a.delta) >= abs(b.delta) ? a : b);
```

**Why:** For a buy, the trader's account gains +X tokens; for a sell, the trader
loses −X. By filtering to the matching direction we get the trader-side delta only.

**How to apply:** Any future change to parseSwap must NOT revert to summing per-mint.

## Other related fixes applied

- `pumpfun.ts handleTrade`: only write `priceEth` to token record when non-null
  (previously each null-price trade erased the last good price from the token row)
- SQL backfill: `UPDATE tokens SET price_eth = (best non-null price from trades)`
  for all tokens where price_eth was null — run once on 2026-08-08 (266 rows updated)
- `vol24h` in AppInterface.tsx: divide `ethAmount` (lamports) by 1e9 before
  multiplying by `solPrice` — was producing trillion-dollar volumes

## Historical data state

- ~90K of 105K trades have `token_amount = '0'` and `price_eth = NULL` (pre-fix legacy)
- Chart candles only exist for tokens where some trades have priceEth
- Going forward (post 2026-08-08) all new trades have correct tokenAmount and priceEth
