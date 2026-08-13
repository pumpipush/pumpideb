/**
 * Adapter registry — initialises all platform adapters on server boot.
 *
 * Each adapter is started in an isolated try/catch so a crash in one
 * does not affect the others.
 *
 * pump.fun + PumpSwap are managed together by PumpStreamManager:
 *   - Primary source: wss://stream.pumpapi.io/ (no API key, zero Alchemy CUs)
 *   - Fallback: chain-native logsSubscribe (PublicNode → Alchemy) when primary is down
 *
 * Startup order matters for raydium_amm — it must start before pump_fun
 * so the graduated-mint cache is populated before pump_fun calls
 * registerGraduatedMint().
 */

import { logger } from "../logger.js";
import { startPumpStreamManager } from "./pumpApiManager.js";

interface AdapterEntry {
  name:  string;
  start: () => Promise<void>;
}

/** Active adapters — all always-on. */
const ADAPTERS: AdapterEntry[] = [
  { name: "pump_stream_manager", start: startPumpStreamManager },
];

/** Start all adapters. Each is isolated — a failure in one does not block the others. */
export async function startAdapters(): Promise<void> {
  const active = ADAPTERS;

  logger.info(
    { adapters: active.map((a) => a.name) },
    "adapters: starting all platform adapters"
  );

  for (const adapter of active) {
    try {
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
