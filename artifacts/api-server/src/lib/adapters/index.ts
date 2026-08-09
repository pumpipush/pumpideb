/**
 * Adapter registry — initialises all platform adapters on server boot.
 *
 * Each adapter is started in an isolated try/catch so a crash in one
 * does not affect the others.
 *
 * Startup order matters for raydium_amm — it must start before pump_fun
 * so the graduated-mint cache is populated before pump_fun calls
 * registerGraduatedMint().
 */

import { logger } from "../logger.js";
import { startPumpFunAdapter }        from "./pumpfun.js";
import { startRaydiumAmmAdapter }     from "./raydium-amm.js";
import { startPumpSwapAdapter }       from "./pumpswap.js";
import { startMeteoraAdapter }        from "./meteora.js";
import { startOrcaAdapter }           from "./orca.js";

interface AdapterEntry {
  name:  string;
  start: () => Promise<void>;
}

/** Always-on adapters — safe on free RPCs. */
const ADAPTERS: AdapterEntry[] = [
  // Raydium must start before pump_fun (graduation cache dependency)
  { name: "raydium",  start: startRaydiumAmmAdapter },
  { name: "pump_fun", start: startPumpFunAdapter    },
];

/**
 * High-volume streaming adapters (PumpSwap, Meteora, Orca) require a paid/fast RPC.
 * On free RPCs they saturate the event queue immediately.
 * Set ENABLE_STREAMING_ADAPTERS=1 in production env to activate them.
 */
const STREAMING_ENABLED =
  process.env.ENABLE_STREAMING_ADAPTERS === "1" ||
  process.env.NODE_ENV === "production";

const STREAMING_ADAPTERS: AdapterEntry[] = [
  { name: "pumpswap", start: startPumpSwapAdapter },
  { name: "meteora",  start: startMeteoraAdapter  },
  { name: "orca",     start: startOrcaAdapter     },
];

/** Start all adapters. Each is isolated — a failure in one does not block the others. */
export async function startAdapters(): Promise<void> {
  const active = [
    ...ADAPTERS,
    ...(STREAMING_ENABLED ? STREAMING_ADAPTERS : []),
  ];

  logger.info(
    {
      adapters: active.map((a) => a.name),
      streamingEnabled: STREAMING_ENABLED,
    },
    "adapters: starting all platform adapters"
  );

  if (!STREAMING_ENABLED) {
    logger.info(
      "adapters: streaming adapters (pumpswap/meteora/orca) disabled — " +
      "set ENABLE_STREAMING_ADAPTERS=1 to activate (requires paid RPC)"
    );
  }

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
