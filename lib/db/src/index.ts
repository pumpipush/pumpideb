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

export * from "./schema";
