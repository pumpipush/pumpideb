import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

/**
 * Apply all pending Drizzle migrations from the given folder.
 * Call this once at server startup — before accepting requests.
 *
 * The caller must supply `migrationsFolder` as an absolute path because the
 * bundler (esbuild) inlines this module; `import.meta.url` inside a bundled
 * file resolves to the bundle, not the original source directory.
 */
export async function runMigrations(migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}

/**
 * Create GIN trigram indexes on tokens.name and tokens.symbol.
 *
 * MUST be called AFTER runMigrations() (so the pg_trgm extension from migration
 * 0018 is already installed).  These statements use CREATE INDEX CONCURRENTLY
 * which is not allowed inside a transaction — that is why they live here instead
 * of inside the migration SQL file (Drizzle wraps each migration in a transaction).
 *
 * Recovery from partial failures:
 * A cancelled CREATE INDEX CONCURRENTLY leaves an *invalid* index (indisvalid=false).
 * IF NOT EXISTS matches by name and skips re-creation, so the planner would silently
 * get no benefit.  We detect invalid indexes and drop them first so the next startup
 * always finishes with a valid, usable index.
 *
 * Concurrent-build guard:
 * We skip creation (but don't error) if another process is already building the
 * same index (indisvalid=false AND pg_stat_progress_create_index shows activity).
 * The next startup will either finish the build or clean it up.
 */
export async function createTrgmIndexes(): Promise<void> {
  const indexes: Array<{ name: string; column: string; definition: string }> = [
    {
      name: "idx_tokens_name_trgm",
      column: "name",
      definition: "ON tokens USING GIN (name gin_trgm_ops)",
    },
    {
      name: "idx_tokens_symbol_trgm",
      column: "symbol",
      definition: "ON tokens USING GIN (symbol gin_trgm_ops)",
    },
  ];

  for (const idx of indexes) {
    // Check current index state: absent / valid / invalid
    const { rows } = await pool.query<{ indisvalid: boolean; inprogress: boolean }>(
      `SELECT
         pi.indisvalid,
         EXISTS (
           SELECT 1 FROM pg_stat_progress_create_index pci
           WHERE  pci.index_relid = c.oid
         ) AS inprogress
       FROM   pg_class c
       JOIN   pg_index pi ON pi.indexrelid = c.oid
       WHERE  c.relname = $1
         AND  c.relkind = 'i'`,
      [idx.name],
    );

    if (rows.length === 0) {
      // Index does not exist — create it.
      await pool.query(`CREATE INDEX CONCURRENTLY ${idx.name} ${idx.definition}`);
    } else if (rows[0].indisvalid) {
      // Index exists and is valid — nothing to do.
    } else if (rows[0].inprogress) {
      // Another process is currently building this index — leave it alone.
      // The next startup will finish or clean up.
    } else {
      // Invalid index, not currently being built — drop and rebuild.
      await pool.query(`DROP INDEX CONCURRENTLY ${idx.name}`);
      await pool.query(`CREATE INDEX CONCURRENTLY ${idx.name} ${idx.definition}`);
    }
  }
}

export * from "./schema";
