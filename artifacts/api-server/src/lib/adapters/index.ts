/**
 * Adapter registry — initialises all platform adapters on server boot.
 *
 * Each adapter is started in an isolated try/catch so a crash in one
 * does not affect the others. Adapters that need missing env vars
 * will log a warning and exit gracefully.
 */

import { logger } from "../logger";
import { startPumpFunAdapter } from "./pumpfun";
import { startMoonshotAdapter } from "./moonshot";
import { startLetsBonkAdapter } from "./letsbonk";
import { startDaosFunAdapter } from "./daos";

interface AdapterEntry {
  name: string;
  start: () => Promise<void>;
}

const ADAPTERS: AdapterEntry[] = [
  { name: "pump_fun", start: startPumpFunAdapter },
  { name: "moonshot", start: startMoonshotAdapter },
  { name: "letsbonk", start: startLetsBonkAdapter },
  { name: "daos_fun", start: startDaosFunAdapter },
];

/** Start all adapters. Each is isolated — a failure in one does not block the others. */
export async function startAdapters(): Promise<void> {
  logger.info({ adapters: ADAPTERS.map((a) => a.name) }, "adapters: starting all platform adapters");

  for (const adapter of ADAPTERS) {
    try {
      // Each adapter manages its own reconnect loop; we don't await them
      void adapter.start().catch((err: unknown) => {
        logger.error(
          { adapter: adapter.name, err },
          `adapters: unhandled error in ${adapter.name} — adapter is offline`
        );
      });
    } catch (err) {
      logger.error(
        { adapter: adapter.name, err },
        `adapters: failed to start ${adapter.name} — continuing without it`
      );
    }
  }
}
