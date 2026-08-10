---
name: Generated API client type management
description: How to update Token and other types in the generated API client when the DB schema or API response shape changes
---

# Generated API Client Types

## Rule
The `@workspace/api-client-react` package has `composite: true` in its tsconfig, meaning TypeScript project references use the **compiled `dist/` declarations**, not the `src/` files directly. Running `npx tsc --build` in that package regenerates dist from src.

**Why:** The rocketfi frontend's tsconfig.json lists `lib/api-client-react` as a project reference (with `"path":`). Project references always resolve through compiled declarations.

## How to apply
When adding a new field to the API response (e.g. adding `decimals` to Token):
1. Add to `lib/db/src/schema/tokens.ts` (DB schema)
2. Add to `lib/api-client-react/src/generated/api.schemas.ts` (TypeScript interface)
3. Add to `lib/api-zod/src/generated/api.ts` (Zod validation schema)
4. Run `cd lib/api-client-react && npx tsc --build` to regenerate dist declarations
5. Run `cd artifacts/rocketfi && pnpm tsc --noEmit` to verify no frontend errors
6. Apply DB column directly via executeSql (don't wait for migration)

## Gotchas
- `trades1h` and other fields hand-added to the dist `.d.ts` get OVERWRITTEN when `tsc --build` runs. Always add them to the **src** file, not the dist.
- The `OHLCVResponse` type was typed as `OHLCVBar[]` but the API actually returns `{ bars: OHLCVBar[], maxTradeId: number }`. Fixed by adding `OHLCVResponse` interface and updating the generated client.
- All platforms (pump.fun, PumpSwap, LaunchLab) use 6-decimal SPL tokens. `decimals` column defaults to 6.
