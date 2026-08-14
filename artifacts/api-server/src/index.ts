// BigInt serialization support — JSON.stringify does not support BigInt natively.
// This patch makes BigInt values serialize as strings (e.g. "1000000" instead of
// crashing with "Do not know how to serialize a BigInt").
// Must run before any res.json() call, so it lives at the very top of the entry point.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

import { fileURLToPath } from "url";
import path from "path";
import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { startAdapters } from "./lib/adapters/index";
import { startEnrichmentLoop } from "./lib/enrichment";
import { startJupiterTokenSync } from "./lib/jupiter-tokens";
import { startLaunchLabBackfill } from "./lib/launchlabBackfill";
import { runMigrations, pool } from "@workspace/db";

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

// Warn clearly if NODE_ENV is not production — several security defaults
// (CORS, JWT secret fallback, OTP code logging) depend on this being set.
if (process.env["NODE_ENV"] !== "production") {
  logger.warn(
    { NODE_ENV: process.env["NODE_ENV"] ?? "(unset)" },
    "NODE_ENV is not 'production' — CORS and JWT defaults are permissive; set NODE_ENV=production for VPS deployment",
  );
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

  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.listen(port, (err?: Error) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        reject(err);
        return;
      }

      logger.info({ port }, "Server listening");

      // In PM2 cluster mode, NODE_APP_INSTANCE identifies each worker.
      // Only worker 0 (or a non-clustered single process) runs background jobs
      // so adapters, enrichment, and backfill never run twice in parallel.
      const isPrimaryWorker =
        !process.env["NODE_APP_INSTANCE"] ||
        process.env["NODE_APP_INSTANCE"] === "0";

      if (isPrimaryWorker) {
        // Start all platform data adapters (Pump.fun, PumpSwap, LaunchLab)
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
      }

      resolve();
    });
  });

  // ── Graceful shutdown (SIGTERM / SIGINT) ─────────────────────────────────────
  // On VPS: process manager (systemd/PM2) sends SIGTERM; Ctrl+C sends SIGINT.
  // Stop accepting new connections, wait for in-flight requests, then close DB.
  const shutdown = (signal: string) => {
    logger.info({ signal }, "Received shutdown signal — draining server");
    server.close(() => {
      logger.info("HTTP server closed — ending DB pool");
      pool.end().then(() => {
        logger.info("DB pool closed — process exit");
        process.exit(0);
      }).catch((err) => {
        logger.error({ err }, "Error closing DB pool");
        process.exit(1);
      });
    });

    // Force-kill if graceful drain takes too long
    setTimeout(() => {
      logger.error("Graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT",  () => shutdown("SIGINT"));
}

start().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
