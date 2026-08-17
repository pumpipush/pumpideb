/**
 * orphanCleanup.ts
 *
 * Shared logic for deleting orphan trades (token_address with no matching
 * tokens.address) and validating the FK constraint added in migration 0017.
 *
 * Exported so both the operational script (scripts/cleanup-orphan-trades.ts)
 * and the integration test (lib/migration0017.test.ts) use the same query,
 * ensuring the test actually guards production behaviour.
 *
 * Table names are parameters so the test can substitute isolated temp tables.
 */

export const BATCH_SIZE_DEFAULT = 10_000;

/**
 * Minimal queryable interface — satisfied by pg.Pool, pg.PoolClient, and
 * pg.Client. Keeping it structural means the test can pass a PoolClient that
 * owns the temp-table session without importing pg types directly.
 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>;
}

/**
 * Delete one batch of orphan trades from `tradesTable` whose `token_address`
 * has no matching `address` in `tokensTable`.
 *
 * Returns the number of rows deleted in this batch.
 *
 * @param db          Queryable — pg.Pool, pg.PoolClient, or pg.Client
 * @param tradesTable Name of the trades table (use temp table names in tests)
 * @param tokensTable Name of the tokens table (use temp table names in tests)
 * @param batchSize   Maximum rows per DELETE — set low in tests for speed
 */
export async function deleteOrphanBatch(
  db: Queryable,
  tradesTable: string,
  tokensTable: string,
  batchSize: number,
): Promise<number> {
  const result = await db.query(`
    DELETE FROM "${tradesTable}"
    WHERE id IN (
      SELECT t.id FROM "${tradesTable}" t
      WHERE NOT EXISTS (
        SELECT 1 FROM "${tokensTable}"
        WHERE "${tokensTable}".address = t.token_address
      )
      LIMIT $1
    )
  `, [batchSize]);
  return result.rowCount ?? 0;
}

/**
 * Delete ALL orphan trades in batches, update the cleanup log, then validate
 * the FK constraint. Intended for the operational cleanup script only.
 *
 * @param db          pg.Pool (or compatible Queryable) for the live schema
 * @param batchSize   Rows per DELETE batch (default 10 000)
 */
export async function cleanupOrphanTrades(
  db: Queryable,
  batchSize = BATCH_SIZE_DEFAULT,
): Promise<void> {
  // Record start in the durable log (migration 0019 creates this table).
  let logId: number | undefined;
  try {
    const logResult = await db.query(`
      INSERT INTO _orphan_cleanup_log (notes)
      VALUES ('cleanup:orphan-trades script started')
      RETURNING id
    `);
    logId = (logResult.rows[0] as { id: number }).id;
  } catch {
    // Table may not exist on older deployments — continue without logging.
  }

  let totalDeleted = 0;
  let batch = 0;

  while (true) {
    const deleted = await deleteOrphanBatch(db, "trades", "tokens", batchSize);
    totalDeleted += deleted;
    batch++;

    if (deleted > 0) {
      console.log(`  Batch ${batch}: deleted ${deleted} orphan rows (total ${totalDeleted})`);
    }

    if (deleted < batchSize) break;
  }

  console.log(`Orphan cleanup complete. Total deleted: ${totalDeleted}`);

  console.log("Validating FK constraint fk_trades_token…");
  await db.query("ALTER TABLE trades VALIDATE CONSTRAINT fk_trades_token");
  console.log("FK constraint validated successfully.");

  // Record completion in the durable log.
  if (logId !== undefined) {
    await db.query(`
      UPDATE _orphan_cleanup_log
      SET completed_at  = NOW(),
          deleted_count = $1,
          validated     = TRUE,
          notes         = 'cleanup:orphan-trades script completed successfully'
      WHERE id = $2
    `, [totalDeleted, logId]);

    // Mark any older PENDING records as superseded.
    await db.query(`
      UPDATE _orphan_cleanup_log
      SET notes = 'SUPERSEDED — cleanup completed; see latest row'
      WHERE validated = FALSE AND id != $1
    `, [logId]);
  }
}
