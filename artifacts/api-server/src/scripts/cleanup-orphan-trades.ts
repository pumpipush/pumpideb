/**
 * cleanup-orphan-trades.ts
 *
 * One-time operational script to delete orphan trades and validate the FK
 * constraint added (NOT VALID) by migration 0017.
 *
 * Why a script instead of a plain migration:
 *   The trades table has ~10M rows and ~2.8M orphans on production. A single
 *   DELETE in a migration transaction would hold an ACCESS EXCLUSIVE lock for
 *   minutes and time out the server startup. This script batches the work so
 *   the table stays available to readers throughout.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run cleanup:orphan-trades
 *
 * Run during a low-traffic window. Safe to re-run (idempotent).
 */

import { pool } from "@workspace/db";
import { cleanupOrphanTrades } from "../lib/orphanCleanup.js";

console.log("Starting orphan trade cleanup…");
await cleanupOrphanTrades(pool);
await pool.end();
