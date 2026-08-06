---
name: AppInterface patterns and gotchas
description: Key decisions and bug patterns found in AppInterface.tsx and related files
---

## Token selection sync
- `selectedTokenId` must always be synced to `tokenParam` via useEffect — both set when param exists AND clear to null when absent. Original bug: only set when tokenParam && activeTab !== "trade", never cleared.

## BigInt safety
- All `BigInt()` calls on API values must use `safeBI()` helper: `(v) => BigInt(v && /^\d+$/.test(v) ? v : "0")`
- Reserve arithmetic must floor at BigInt(1) not 0 to avoid negative reserves crashing downstream.

## React state over DOM imperative
- Never use `document.getElementById` for tab switching inside React components. Use `useState` + conditional className. Original sub-tab (Transactions/Holders) used imperative DOM — replaced with `activeSubTab` state.

## Dead hook removed
- `usePumpPortalTrades(null)` was a permanently-disabled dead hook. When re-enabling for real-time: pass the actual token mint address and merge pumpTrades into OHLCV candles via tradesFromPump().

**Why:** These were root causes of runtime crashes on the trade page.
