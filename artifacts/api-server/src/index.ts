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
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync } from "fs";
import app from "./app";
import { logger } from "./lib/logger";
import { startAdapters } from "./lib/adapters/index";
import { startEnrichmentLoop } from "./lib/enrichment";
import { startJupiterTokenSync } from "./lib/jupiter-tokens";
import { startLaunchLabBackfill } from "./lib/launchlabBackfill";
import { runMigrations, createTrgmIndexes, pool } from "@workspace/db";

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

// ── Cross-process background-worker lock ───────────────────────────────────────
//
// In PM2 cluster mode with 2 workers, a rolling reload briefly runs two
// generations of worker-0 simultaneously (the new one starts before the old one
// exits).  Both have NODE_APP_INSTANCE=0, so a simple instance-ID check would
// start adapters twice.
//
// We use a PID lock file with O_EXCL (exclusive create — atomic on POSIX) so
// only ONE process at a time ever holds the "background jobs" role:
//   • O_EXCL guarantees exactly one process creates the file.
//   • When the retiring worker exits its shutdown handler, it unlinks the file.
//   • The new worker's retry loop then acquires the lock and starts jobs.
//   • If the lock file is stale (holder PID gone), we remove and retry.
//
// The retry interval (2 s) is well within the rolling-reload window (kill_timeout
// is 10 s), so jobs start on the new primary in ≤ 2 s after the old one exits.

const WORKER_LOCK_FILE = "/tmp/rocketfi-worker.lock";
let _backgroundStarted = false;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Atomically try to claim the background-worker lock.
 * Returns true only if this process is now the exclusive lock holder.
 */
function tryAcquireLock(): boolean {
  try {
    // 'wx' = O_WRONLY | O_CREAT | O_EXCL — fails immediately if file exists
    const fd = openSync(WORKER_LOCK_FILE, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;

    // Lock file exists — verify the holder is still alive
    try {
      const raw = readFileSync(WORKER_LOCK_FILE, "utf8").trim();
      const pid = parseInt(raw, 10);
      if (Number.isNaN(pid)) {
        // Corrupt file — remove and retry
        try { unlinkSync(WORKER_LOCK_FILE); } catch { /* ignore */ }
        return tryAcquireLock();
      }
      process.kill(pid, 0); // throws ESRCH if process doesn't exist
      return false;         // holder is alive; we do not own the lock
    } catch (killErr: unknown) {
      // Holder process is gone — remove stale lock and retry once
      try { unlinkSync(WORKER_LOCK_FILE); } catch { /* ignore */ }
      return tryAcquireLock();
    }
  }
}

/**
 * Release the background-worker lock if this process holds it.
 * Called from the graceful-shutdown handler so the new generation can
 * pick up the lock within its retry interval (≤ 2 s).
 */
function releaseLock(): void {
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  try {
    if (!existsSync(WORKER_LOCK_FILE)) return;
    const pid = parseInt(readFileSync(WORKER_LOCK_FILE, "utf8").trim(), 10);
    if (pid === process.pid) unlinkSync(WORKER_LOCK_FILE);
  } catch { /* ignore — best-effort release */ }
}

/**
 * Try to become the background-job primary.  If another process (the retiring
 * reload predecessor) already holds the lock, schedule a retry so we pick it
 * up as soon as the old worker exits and releases.
 */
function tryBecomeWorkerPrimary(): void {
  if (_backgroundStarted) return;

  if (tryAcquireLock()) {
    _backgroundStarted = true;
    logger.info({ pid: process.pid }, "worker-primary lock acquired — starting background jobs");

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
  } else {
    // Predecessor still holds the lock — retry after kill_timeout gives it time to exit
    _retryTimer = setTimeout(tryBecomeWorkerPrimary, 2_000);
    _retryTimer.unref(); // don't block process exit during shutdown
    logger.debug("worker-primary lock held by predecessor — will retry in 2 s");
  }
}

// ── Server startup ─────────────────────────────────────────────────────────────

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

  // Build GIN trigram indexes on tokens.name / tokens.symbol AFTER migrations
  // so the pg_trgm extension (added in migration 0018) is guaranteed to exist.
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction, which is why these
  // are issued here via plain pool queries rather than inside the migration SQL.
  logger.info("db: creating trgm indexes (CONCURRENTLY — safe to run mid-traffic)");
  await createTrgmIndexes();
  logger.info("db: trgm indexes ready");

  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.listen(port, (err?: Error) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        reject(err);
        return;
      }

      logger.info({ port }, "Server listening");

      // ── Google OAuth domain reminder ──────────────────────────────────────
      // The Google sign-in button only works when the app's origin is listed
      // under Authorized JavaScript origins in Google Cloud Console
      // (APIs & Services → Credentials → OAuth 2.0 Web Client).
      // Log the current domain so it's easy to copy-paste into the Console.
      if (process.env["GOOGLE_CLIENT_ID"]) {
        const devDomain = process.env["REPLIT_DEV_DOMAIN"];
        const prodDomains = (process.env["REPLIT_DOMAINS"] ?? "")
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);
        const allDomains = [
          ...(devDomain ? [`https://${devDomain}`] : []),
          ...prodDomains
            .filter((d) => !devDomain || d !== devDomain)
            .map((d) => `https://${d}`),
        ];
        if (allDomains.length > 0) {
          logger.info(
            { origins: allDomains },
            "google-oauth: ensure these origins are listed under Authorized JavaScript origins in Google Cloud Console → OAuth 2.0 Credentials → Web Client",
          );
        }
      }

      // Try to become the background-job primary via cross-process lock.
      // Safe across PM2 rolling-reload generations — see lock comment above.
      tryBecomeWorkerPrimary();

      resolve();
    });
  });

  // ── Graceful shutdown (SIGTERM / SIGINT) ─────────────────────────────────────
  // On VPS: PM2 sends SIGINT during reload (configurable); Ctrl+C sends SIGINT.
  //
  // Shutdown sequence:
  //   1. Release the worker-primary lock so the incoming generation can acquire it.
  //   2. Stop accepting new connections (server.close).
  //   3. Existing requests (including SSE streams) drain until they finish or
  //      kill_timeout (10 s) is reached, whichever comes first.
  //   4. Close the DB pool and exit cleanly.
  //
  // SSE streams: browser EventSource reconnects automatically after the stream
  // closes.  The reconnect delay is typically < 1 s; there is no data loss
  // because the new worker resumes from the same live sources.
  const shutdown = (signal: string) => {
    logger.info({ signal }, "Received shutdown signal — draining server");

    // Release lock first so the new worker can acquire it and start jobs
    // while this worker is still draining existing connections.
    releaseLock();

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

    // Force-kill if graceful drain takes too long.
    // PM2's kill_timeout (10 s in ecosystem.config.cjs) will also hard-kill
    // if this timer hasn't fired; whichever fires first wins.
    setTimeout(() => {
      logger.error("Graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 9_000).unref();
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT",  () => shutdown("SIGINT"));
}

// Prevent disk-full or transient DB errors in background enrichment jobs
// from crashing the server process. These jobs use `void fn()` so unhandled
// rejections would otherwise bubble up and kill Node.js.
process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled promise rejection — ignoring to keep server alive");
});

start().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
