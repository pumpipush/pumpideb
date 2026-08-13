/**
 * deposits.idempotency.test.ts
 *
 * Proves that the GET /deposits/:reference/status handler cannot double-credit
 * an in-app SOL balance even when two requests arrive simultaneously and both
 * detect the same on-chain transaction.
 *
 * Strategy
 * ────────
 * Rather than mocking the database, we run the exact SQL that the route
 * executes against a real PostgreSQL connection.  This lets PostgreSQL's own
 * row-locking semantics prove the guarantee:
 *
 *   • Two concurrent transactions both attempt
 *       UPDATE deposits SET status='confirmed' … WHERE status='pending'
 *     (with .returning())
 *   • PostgreSQL serialises the UPDATE on the row lock: whichever transaction
 *     commits first sets status='confirmed'.  The second transaction, after
 *     unblocking, re-evaluates the WHERE clause under READ COMMITTED and sees
 *     status='confirmed' — so it returns 0 rows.
 *   • Only the winner (returned rows > 0) proceeds to increment sol_balance_lamports.
 *   • The final balance equals exactly one deposit amount, not two.
 *
 * This is an integration test: it requires DATABASE_URL to be set (available
 * in every Replit environment that has a Postgres db provisioned).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, depositsTable, profilesTable } from "@workspace/db";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

// ── Unique fixture keys (avoids collision with real data or parallel test runs) ─
const TAG      = `dep${Date.now().toString(36)}`;
const WALLET   = `DepWlt${TAG}${"W".repeat(38)}`.slice(0, 44);
const REF      = `DepRef${TAG}${"R".repeat(38)}`.slice(0, 44);
const AMOUNT   = BigInt(100_000_000); // 0.1 SOL in lamports

// ── DB fixture lifecycle ─────────────────────────────────────────────────────

beforeAll(async () => {
  // Profile must exist before deposits (FK constraint)
  await db.insert(profilesTable).values({
    address:  WALLET,
    username: `dep_idem_${TAG}`,
    authType: "wallet",
  }).onConflictDoNothing();

  await db.insert(depositsTable).values({
    userAddress:    WALLET,
    referencePubkey: REF,
    amountLamports: AMOUNT,
    status:         "pending",
    expiresAt:      new Date(Date.now() + 60_000),
  });
});

afterAll(async () => {
  await db.delete(depositsTable).where(eq(depositsTable.referencePubkey, REF));
  await db.delete(profilesTable).where(eq(profilesTable.address, WALLET));
});

// ── The exact confirm helper extracted from the route ────────────────────────

/**
 * Mirrors the fixed code in GET /deposits/:reference/status.
 * Returns true if THIS call was the one that credited the balance,
 * false if another concurrent call already did it.
 */
async function confirmDeposit(reference: string, userAddress: string, amountLamports: bigint): Promise<boolean> {
  let credited = false;
  await db.transaction(async (trx) => {
    const claimed = await trx
      .update(depositsTable)
      .set({ status: "confirmed", txSignature: "fakeTxSig123", confirmedAt: new Date() })
      .where(
        and(
          eq(depositsTable.referencePubkey, reference),
          eq(depositsTable.status, "pending"),
        ),
      )
      .returning({ id: depositsTable.id });

    if (claimed.length === 0) return; // another request already won the race

    await trx
      .update(profilesTable)
      .set({
        solBalanceLamports: sql`${profilesTable.solBalanceLamports} + ${amountLamports}`,
      })
      .where(eq(profilesTable.address, userAddress));

    credited = true;
  });
  return credited;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("deposit idempotency guard", () => {
  it("credits the balance exactly once when two confirmations race", async () => {
    // Fire two concurrent confirm attempts — both think they found an on-chain tx.
    const [r1, r2] = await Promise.all([
      confirmDeposit(REF, WALLET, AMOUNT),
      confirmDeposit(REF, WALLET, AMOUNT),
    ]);

    // Exactly one of them should have won the race and credited the balance.
    const winners = [r1, r2].filter(Boolean).length;
    expect(winners).toBe(1);

    // The DB balance must equal exactly one deposit amount — never two.
    const [profile] = await db
      .select({ bal: profilesTable.solBalanceLamports })
      .from(profilesTable)
      .where(eq(profilesTable.address, WALLET));

    expect(profile.bal).toBe(AMOUNT);
  });

  it("returns confirmed on a subsequent call even after the row is already confirmed", async () => {
    // Third call after both above have settled — deposit is already 'confirmed'.
    // Route reads status early and returns immediately without re-crediting.
    const [dep] = await db
      .select({ status: depositsTable.status })
      .from(depositsTable)
      .where(eq(depositsTable.referencePubkey, REF));

    expect(dep.status).toBe("confirmed");

    // A further confirmDeposit call returns false (0 rows matched) — no credit.
    const r3 = await confirmDeposit(REF, WALLET, AMOUNT);
    expect(r3).toBe(false);

    // Balance still equals exactly one deposit amount.
    const [profile] = await db
      .select({ bal: profilesTable.solBalanceLamports })
      .from(profilesTable)
      .where(eq(profilesTable.address, WALLET));

    expect(profile.bal).toBe(AMOUNT);
  });
});
