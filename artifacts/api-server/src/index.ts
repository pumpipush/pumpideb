import { fileURLToPath } from "url";
import path from "path";
import app from "./app";
import { logger } from "./lib/logger";
import { startAdapters } from "./lib/adapters/index";
import { startEnrichmentLoop } from "./lib/enrichment";
import { startJupiterTokenSync } from "./lib/jupiter-tokens";
import { startLaunchLabBackfill } from "./lib/launchlabBackfill";
import { runMigrations } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start(): Promise<void> {
  // Resolve the migrations folder relative to this file's bundled location.
  // At runtime the bundle is at  artifacts/api-server/dist/index.mjs;
  // going up three directories from `dist/` reaches the workspace root.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = path.dirname(__filename);
  const migrationsFolder = path.resolve(__dirname, "../../../lib/db/migrations");

  // Apply any pending DB migrations before accepting traffic.
  // The runner is idempotent — it tracks applied files in __drizzle_migrations
  // and skips ones already applied.
  logger.info({ migrationsFolder }, "db: running migrations");
  await runMigrations(migrationsFolder);
  logger.info("db: migrations complete");

  await new Promise<void>((resolve, reject) => {
    app.listen(port, (err?: Error) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        reject(err);
        return;
      }

      logger.info({ port }, "Server listening");

      // Start all platform data adapters (Pump.fun, Moonshot, LetsBONK)
      // Each adapter is isolated — a crash in one will not affect the server
      void startAdapters();

      // Start background enrichment loop — retries metadata for tokens that
      // got placeholder names/symbols because the upstream API wasn't ready yet
      startEnrichmentLoop();

      // Download and cache Jupiter strict token list (enables "All Solana Tokens" search)
      startJupiterTokenSync();

      // Backfill historical LaunchLab tokens from on-chain creation transactions.
      // Runs 10 s after startup (to let adapters connect first), then every 10 min.
      startLaunchLabBackfill();

      resolve();
    });
  });
}

start().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
