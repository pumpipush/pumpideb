# RocketFi

EVM token launchpad with bonding curve — a security-hardened pump.fun clone for Ethereum chains where users launch meme tokens in one click, trade on bonding curves, and discover tokens on a live dashboard.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/rocketfi run dev` — run the frontend (port from workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run typecheck:libs` — rebuild lib declarations (run after changing lib/db or lib/api-spec)
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, wouter routing, TanStack Query, Recharts, ethers.js
- API: Express 5 (shared `artifacts/api-server`)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (v3.x), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec — use `type: number` not `type: integer` to avoid zod.int() errors)
- Build: esbuild (CJS bundle)

## Where things live

- `contracts-rocketfi/` — Solidity smart contracts (RocketFi.sol, TokenLauncher.sol, RocketToken.sol) with Hardhat
- `artifacts/rocketfi/` — React frontend (landing page `/`, dApp `/app`, dashboard `/dashboard`)
- `artifacts/api-server/src/routes/` — API routes (tokens.ts, trades.ts, stats.ts, health.ts)
- `lib/db/src/schema/` — DB schema (tokens.ts, trades.ts)
- `lib/api-spec/openapi.yaml` — OpenAPI contract (source of truth)
- `lib/api-client-react/src/generated/` — generated React Query hooks

## Architecture decisions

- Smart contracts are in `contracts-rocketfi/` (Hardhat project, separate from the monorepo packages). Frontend interacts with blockchain directly via ethers.js; backend only indexes/caches on-chain events.
- All `type: integer` fields in OpenAPI spec must use `type: number` — Orval 8.x generates `zod.int()` which doesn't exist in Zod v3.
- BigInt reserves stored as `text` in DB (Ethereum uint256 values exceed JS safe integer range).
- `tradeCount` and `holderCount` stored as `numeric` in DB → converted to `Number()` in routes before returning.
- Stats endpoint does SQL aggregations inline (no caching layer) — acceptable for current scale.

## Product

- **Landing page** (`/`): Marketing page with live platform stats, how-it-works, and CTA to launch app.
- **dApp** (`/app`): Connect MetaMask, launch tokens (creates bonding curve), buy/sell on curve with live chart, view your tokens.
- **Dashboard** (`/dashboard`): Discover all tokens, search/sort/filter, view bonding curve + trade history per token, live activity feed.

## User preferences

- Security-first: all 9 original bugs from the GitHub contract were fixed before delivering.
- Rebranded from "PumpFun" to "RocketFi" across all contracts and frontend.

## Gotchas

- After changing `lib/db/src/schema/`, run `pnpm run typecheck:libs` before `pnpm --filter @workspace/api-server run typecheck` or you'll get stale declaration errors.
- OpenAPI spec: never use `type: integer` — always use `type: number`. Otherwise codegen produces `zod.int()` which fails with Zod v3.
- The `listTokenTrades` operationId caused a TS2308 collision — renamed to `tradeHistory` to avoid it.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Smart contract README: `contracts-rocketfi/README.md`
