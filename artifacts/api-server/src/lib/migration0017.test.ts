/**
 * migration0017.test.ts — Integration guard for migration 0017 + 0018/0019 FK schema
 *
 * Migration 0017 added:
 *   ALTER TABLE trades ADD CONSTRAINT fk_trades_token
 *     FOREIGN KEY (token_address) REFERENCES tokens(address)
 *     ON DELETE CASCADE NOT VALID;
 *
 * Migration 0018 registered the cleanup requirement.
 * Migration 0019 created _orphan_cleanup_log for durable status tracking.
 * scripts/cleanup-orphan-trades.ts completes the work offline (batch DELETE +
 *   VALIDATE CONSTRAINT), using lib/orphanCleanup.ts for the shared predicate.
 *
 * This file guards three behaviours that must survive future schema edits:
 *
 *   A. deleteOrphanBatch (lib/orphanCleanup.ts) — the function shared between
 *      the cleanup script and this test — deletes only orphan rows and leaves
 *      valid rows intact. Tested against isolated PostgreSQL temp tables so the
 *      live 10M-row trades table is never touched. The test uses a single
 *      PoolClient so temp tables are visible to both the setup queries and the
 *      production function.
 *
 *   B. The FK constraint rejects INSERT of a trade referencing a non-existent
 *      token address. This test ASSERTS the constraint exists (proving migration
 *      0017 applied) rather than creating it, so it fails if the migration was
 *      never run.
 *
 *   C. ON DELETE CASCADE automatically removes trades when their parent token
 *      is deleted. Also asserts the constraint exists before proceeding.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { db, pool, tokensTable, tradesTable } from "@workspace/db";
import { sql, eq, inArray } from "drizzle-orm";
import { deleteOrphanBatch } from "./orphanCleanup.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** Unique suffix for this test run — avoids fixture collisions */
const TAG = `m17_${Date.now().toString(36)}`;

/** Build a 44-char unique fake Solana-ish address */
const addr = (label: string) =>
  `${label}${TAG}${"X".repeat(44)}`.slice(0, 44);

const TOKEN_VALID   = addr("TkVld");
const TOKEN_CASCADE = addr("TkCsc");
/** Never inserted into tokens — used as FK-rejection fixture */
const GHOST_ADDR    = addr("TkGht");

let txSeq = 0;
const nextTx = () => `m17Tx${TAG}${(++txSeq).toString().padStart(4, "0")}`;

/** Minimal valid token row */
const tokenRow = (address: string) => ({
  address,
  name:           `Mig0017 Test ${address.slice(0, 8)}`,
  symbol:         "M17T",
  creatorAddress: addr("Crtr"),
  platform:       "pump_fun" as const,
  chain:          "solana",
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Assert that fk_trades_token exists — fails with a clear message if migration 0017 was never applied. */
async function assertFkExists(): Promise<void> {
  const row = await db.execute(sql`
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_trades_token'
  `);
  expect(
    row.rows.length,
    "fk_trades_token constraint not found — ensure migration 0017 has been applied",
  ).toBe(1);
}

// ── Fixture setup / teardown ────────────────────────────────────────────────

beforeAll(async () => {
  // Insert tokens needed by tests B and C.
  // NOTE: this setup does NOT create the FK constraint — tests B and C assert
  // it was applied by migration 0017, failing if the migration never ran.
  await db.insert(tokensTable).values([
    tokenRow(TOKEN_VALID),
    tokenRow(TOKEN_CASCADE),
  ]).onConflictDoNothing();
});

afterAll(async () => {
  // Trades first (FK order); CASCADE test may have already removed TOKEN_CASCADE's trade.
  await db.delete(tradesTable).where(
    inArray(tradesTable.tokenAddress, [TOKEN_VALID, TOKEN_CASCADE]),
  );
  // TOKEN_CASCADE may have been deleted by the CASCADE test — no-op if already gone.
  await db.delete(tokensTable).where(
    inArray(tokensTable.address, [TOKEN_VALID, TOKEN_CASCADE]),
  );
});

// ── Test A: deleteOrphanBatch predicate ────────────────────────────────────

describe("migration 0018/0019 — deleteOrphanBatch (lib/orphanCleanup.ts)", () => {
  it("deletes orphan rows and leaves valid rows intact", async () => {
    // Acquire a single PoolClient and use it for ALL operations — temp tables
    // are session-local, so the setup queries and deleteOrphanBatch must share
    // the same connection to see the same tables.
    // ROLLBACK drops ON COMMIT DROP tables and inserted rows atomically.
    const client = await pool.connect();
    const TBL_TOK = `_m17tok${TAG}`.slice(0, 63);
    const TBL_TRD = `_m17trd${TAG}`.slice(0, 63);
    try {
      await client.query("BEGIN");

      await client.query(`
        CREATE TEMP TABLE "${TBL_TOK}" (
          address TEXT PRIMARY KEY
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TEMP TABLE "${TBL_TRD}" (
          id            SERIAL PRIMARY KEY,
          token_address TEXT NOT NULL
        ) ON COMMIT DROP
      `);

      // Seed: TOKEN_VALID exists in _tok; GHOST_ADDR does not.
      await client.query(
        `INSERT INTO "${TBL_TOK}" (address) VALUES ($1)`,
        [TOKEN_VALID],
      );
      await client.query(
        `INSERT INTO "${TBL_TRD}" (token_address) VALUES ($1), ($2)`,
        [TOKEN_VALID, GHOST_ADDR],
      );

      // Call the real production function with the same PoolClient so it sees the temp tables.
      const deleted = await deleteOrphanBatch(client, TBL_TRD, TBL_TOK, 1000);

      // Only the orphan row should have been deleted.
      expect(deleted).toBe(1);

      // The valid row must still be present.
      const surviving = await client.query<{ token_address: string }>(
        `SELECT token_address FROM "${TBL_TRD}"`,
      );
      expect(surviving.rowCount).toBe(1);
      expect(surviving.rows[0].token_address).toBe(TOKEN_VALID);

      await client.query("ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
});

// ── Test B: FK constraint rejects orphan INSERTs ────────────────────────────

describe("migration 0017 — FK constraint (post-migration)", () => {
  it("rejects INSERT of a trade referencing a non-existent token address", async () => {
    // Assert that migration 0017 applied the constraint — this test fails
    // (not skips) if the migration was never run.
    await assertFkExists();

    // GHOST_ADDR is not in tokens — the FK must reject this INSERT.
    await expect(
      db.insert(tradesTable).values({
        tokenAddress:  GHOST_ADDR,
        traderAddress: addr("Trdr"),
        isBuy:         true,
        ethAmount:     "1000000",
        tokenAmount:   "1000000",
        txHash:        nextTx(),
        platform:      "pump_fun",
      }),
    ).rejects.toThrow();
  });
});

// ── Test C: ON DELETE CASCADE ───────────────────────────────────────────────

describe("migration 0017 — ON DELETE CASCADE", () => {
  it("automatically removes trades when their parent token is deleted", async () => {
    // Assert that migration 0017 applied the constraint — this test fails
    // (not skips) if the migration was never run.
    await assertFkExists();

    // TOKEN_CASCADE was inserted in beforeAll.
    await db.insert(tradesTable).values({
      tokenAddress:  TOKEN_CASCADE,
      traderAddress: addr("Trdr"),
      isBuy:         true,
      ethAmount:     "1000000",
      tokenAmount:   "1000000",
      txHash:        nextTx(),
      platform:      "pump_fun",
    });

    const before = await db
      .select({ id: tradesTable.id })
      .from(tradesTable)
      .where(eq(tradesTable.tokenAddress, TOKEN_CASCADE));
    expect(before.length).toBe(1);

    // Delete the parent token — CASCADE must remove the child trade.
    await db.delete(tokensTable).where(eq(tokensTable.address, TOKEN_CASCADE));

    const after = await db
      .select({ id: tradesTable.id })
      .from(tradesTable)
      .where(eq(tradesTable.tokenAddress, TOKEN_CASCADE));
    expect(after.length).toBe(0);
  });
});
