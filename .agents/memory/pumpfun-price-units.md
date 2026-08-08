---
name: pump.fun price_eth unit convention
description: Correct unit for price_eth in trades and tokens tables — SOL per full token, NOT lamports per base_unit.
---

# pump.fun price_eth unit convention

## The rule
`price_eth` must be stored as **SOL per full token** (floating point).

Formula in pumpfun.ts:
```typescript
const priceEth = (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15);
```

The `/1000` factor is mandatory:
- `solLamports / tokenAmount` = `lamports / base_unit` = `(SOL×1e9) / (token×1e6)` = SOL/token × 1000
- Dividing by 1000 gives true SOL/token

**Why:** Without the `/1000`, the displayed price is 1000× too high (e.g. $0.0031 shown instead of $0.0000031), while Market Cap (computed separately from virtual reserves) stays correct — creating an obvious inconsistency.

## Verification
After any change to price computation, run this check:

```sql
SELECT symbol,
       ROUND(CAST(price_eth AS NUMERIC) * 1e9, 2) AS implied_mc_sol,
       ROUND(CAST(market_cap_eth AS NUMERIC) / 1e9, 2) AS actual_mc_sol
FROM tokens
WHERE price_eth IS NOT NULL AND CAST(price_eth AS NUMERIC) > 0
LIMIT 10;
```

`implied_mc_sol` (price × 1B tokens) should approximately equal `actual_mc_sol` (MC in lamports ÷ 1e9). A factor-of-1000 discrepancy means price_eth is stored wrong.

## market_cap_eth unit
`market_cap_eth` is stored in **lamports** (integer string). `formatMCUsd` divides by 1e9 to get SOL, then multiplies by solPrice. Do NOT change this.

## PUMP_INIT_PRICE_ETH
Also divided by 1000:
```typescript
const PUMP_INIT_PRICE_ETH =
  (Number(PUMP_INIT_VSOL_LAMPORTS) / Number(PUMP_INIT_VTOK) / 1000).toFixed(15);
```
= approximately `2.795e-8` SOL/token at launch.

## Backfill history
A one-time SQL backfill divided all existing `price_eth` values by 1000:
```sql
UPDATE trades SET price_eth = (CAST(price_eth AS NUMERIC) / 1000)::TEXT WHERE price_eth IS NOT NULL AND CAST(price_eth AS NUMERIC) > 0;
UPDATE tokens SET price_eth = (CAST(price_eth AS NUMERIC) / 1000)::TEXT WHERE price_eth IS NOT NULL AND CAST(price_eth AS NUMERIC) > 0;
```
This was a one-time fix. All values going forward use the correct formula.
