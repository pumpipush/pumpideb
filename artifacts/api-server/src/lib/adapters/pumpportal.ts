/**
 * PumpPortal free sentinel.
 *
 * PumpPortal is deliberately NOT a trade source here. It supplies an independent
 * stream of Pump.fun token launches and Pump.fun -> PumpSwap migrations while
 * PumpAPI remains the primary source for trades and chain RPC remains the final
 * trade fallback.
 */

import { logger as rootLogger } from "../logger.js";
import type { PumpApiEvent } from "./pumpfun.js";

export const PUMPPORTAL_WSS = "wss://pumpportal.fun/api/data";
export const PUMPPORTAL_DATA_STALE_MS = 45_000;

const pumpPortalLog = rootLogger.child({ adapter: "pumpportal_sentinel" });

export interface PumpPortalEvent {
  signature?: string;
  mint?: string;
  txType?: string;
  type?: string;
  pool?: string;
  traderPublicKey?: string;
  initialBuy?: number | string;
  solAmount?: number | string;
  bondingCurveKey?: string;
  vTokensInBondingCurve?: number | string;
  vSolInBondingCurve?: number | string;
  marketCapSol?: number | string;
  price?: number | string;
  name?: string;
  symbol?: string;
  uri?: string;
  timestamp?: number | string;
  poolAddress?: string;
  poolKey?: string;
  poolId?: string;
  ammPool?: string;
  quoteMint?: string;
  tokensInPool?: number | string;
  quoteInPool?: number | string;
  message?: string;
}

export type PumpPortalNormalizedEvent =
  | { kind: "launch"; event: PumpApiEvent }
  | { kind: "migration"; event: PumpApiEvent };

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function possiblePoolAddress(event: PumpPortalEvent): string | undefined {
  for (const candidate of [
    event.poolAddress,
    event.poolKey,
    event.poolId,
    event.ammPool,
  ]) {
    const value = nonEmptyString(candidate);
    if (value) return value;
  }

  // Some PumpPortal payload versions use `pool` for the AMM address. Do not
  // mistake category labels such as "pump" or "pump-amm" for an account.
  const pool = nonEmptyString(event.pool);
  return pool && pool.length >= 32 ? pool : undefined;
}

/**
 * Convert PumpPortal's public wire format into the existing PumpAPI ingestion
 * contract. Keeping one normalized shape means both providers share the same DB
 * upserts, transaction dedup, metadata fetch, SSE broadcast, and migration rules.
 */
export function normalizePumpPortalEvent(
  raw: unknown,
): PumpPortalNormalizedEvent | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = raw as PumpPortalEvent;
  const txType = (
    nonEmptyString(event.txType) ??
    nonEmptyString(event.type) ??
    ""
  ).toLowerCase();
  const signature = nonEmptyString(event.signature);
  const mint = nonEmptyString(event.mint);
  if (!signature || !mint) return null;

  if (txType === "create") {
    return {
      kind: "launch",
      event: {
        action: "create",
        pool: "pump",
        signature,
        mint,
        txSigner: nonEmptyString(event.traderPublicKey),
        initialBuy: finiteNumber(event.initialBuy),
        quoteAmount: finiteNumber(event.solAmount),
        vTokensInBondingCurve: finiteNumber(event.vTokensInBondingCurve),
        vQuoteInBondingCurve: finiteNumber(event.vSolInBondingCurve),
        marketCapQuote: finiteNumber(event.marketCapSol),
        price: finiteNumber(event.price),
        timestamp: finiteNumber(event.timestamp),
        name: nonEmptyString(event.name),
        symbol: nonEmptyString(event.symbol),
        uri: nonEmptyString(event.uri),
      },
    };
  }

  if (txType === "migrate" || txType === "migration") {
    const pool = nonEmptyString(event.pool)?.toLowerCase();
    // PumpPortal can expose migrations for other launchpads. Never relabel an
    // explicitly Raydium-bound migration as a PumpSwap graduation.
    if (pool?.includes("raydium")) return null;

    return {
      kind: "migration",
      event: {
        action: "migrate",
        pool: "pump-amm",
        poolCreatedBy: "pump",
        signature,
        mint,
        poolAddress: possiblePoolAddress(event),
        quoteMint: nonEmptyString(event.quoteMint),
        tokensInPool: finiteNumber(event.tokensInPool),
        quoteInPool: finiteNumber(event.quoteInPool),
        marketCapQuote: finiteNumber(event.marketCapSol),
        price: finiteNumber(event.price),
        timestamp: finiteNumber(event.timestamp),
      },
    };
  }

  return null;
}

export interface PumpPortalHealthSnapshot {
  connected: boolean;
  lastRealEventAt: Date | null;
  lastEventKind: "launch" | "migration" | null;
}

export class PumpPortalAdapter {
  private _ws: WebSocket | null = null;
  private _active = false;
  private _connected = false;
  private _delay = 5_000;
  private readonly _maxDelay = 120_000;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _dataStaleTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastRealEventAt: Date | null = null;
  private _lastEventKind: "launch" | "migration" | null = null;

  private readonly _dataStaleMs: number;
  private readonly _wsFactory: (url: string) => WebSocket;
  private readonly _onLaunch: (event: PumpApiEvent) => Promise<boolean>;
  private readonly _onMigration: (event: PumpApiEvent) => Promise<boolean>;
  private readonly _onRealData?: (
    kind: "launch" | "migration",
    event: PumpApiEvent,
  ) => void;
  private readonly _url: string;

  constructor(opts: {
    onLaunch: (event: PumpApiEvent) => Promise<boolean>;
    onMigration: (event: PumpApiEvent) => Promise<boolean>;
    onRealData?: (
      kind: "launch" | "migration",
      event: PumpApiEvent,
    ) => void;
    dataStaleMs?: number;
    wsFactory?: (url: string) => WebSocket;
    apiKey?: string;
  }) {
    this._onLaunch = opts.onLaunch;
    this._onMigration = opts.onMigration;
    this._onRealData = opts.onRealData;
    this._dataStaleMs = opts.dataStaleMs ?? PUMPPORTAL_DATA_STALE_MS;
    this._wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url));

    const apiKey = opts.apiKey?.trim() || process.env["PUMPPORTAL_API_KEY"]?.trim();
    this._url = apiKey
      ? `${PUMPPORTAL_WSS}?api-key=${encodeURIComponent(apiKey)}`
      : PUMPPORTAL_WSS;
  }

  start(): void {
    if (this._active) return;
    this._active = true;
    pumpPortalLog.info(
      { wss: PUMPPORTAL_WSS, authenticated: this._url !== PUMPPORTAL_WSS },
      "pumpportal: starting free launch/migration sentinel",
    );
    this._connect();
  }

  stop(): void {
    if (!this._active) return;
    this._active = false;
    this._connected = false;
    this._clearDataStaleWatchdog();
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  getHealthSnapshot(): PumpPortalHealthSnapshot {
    return {
      connected: this._connected,
      lastRealEventAt: this._lastRealEventAt,
      lastEventKind: this._lastEventKind,
    };
  }

  private _armDataStaleWatchdog(ws: WebSocket): void {
    this._clearDataStaleWatchdog();
    this._dataStaleTimer = setTimeout(() => {
      this._dataStaleTimer = null;
      pumpPortalLog.warn(
        {
          dataStaleMs: this._dataStaleMs,
          lastRealEventAt: this._lastRealEventAt?.toISOString() ?? null,
        },
        "pumpportal: no real launch/migration events received; forcing reconnect",
      );
      ws.close();
    }, this._dataStaleMs);
  }

  private _clearDataStaleWatchdog(): void {
    if (this._dataStaleTimer !== null) {
      clearTimeout(this._dataStaleTimer);
      this._dataStaleTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    if (!this._active || this._reconnectTimer !== null) return;
    const retryMs = this._delay;
    pumpPortalLog.warn({ retryMs }, "pumpportal: disconnected — reconnecting");
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, retryMs);
    this._delay = Math.min(this._delay * 2, this._maxDelay);
  }

  private _connect(): void {
    if (!this._active) return;
    try {
      const ws = this._wsFactory(this._url);
      this._ws = ws;

      ws.addEventListener("open", () => {
        if (!this._active || this._ws !== ws) return;
        this._connected = true;
        this._delay = 5_000;
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
        ws.send(JSON.stringify({ method: "subscribeMigration" }));
        this._armDataStaleWatchdog(ws);
        pumpPortalLog.info(
          { channels: ["newToken", "migration"] },
          "pumpportal: connected and subscribed",
        );
      });

      ws.addEventListener("message", (rawEvent) => {
        let raw: PumpPortalEvent;
        try {
          raw = JSON.parse(String(rawEvent.data)) as PumpPortalEvent;
        } catch {
          return;
        }

        const normalized = normalizePumpPortalEvent(raw);
        if (!normalized) return; // subscription acknowledgements and unrelated events

        this._lastRealEventAt = new Date();
        this._lastEventKind = normalized.kind;
        this._armDataStaleWatchdog(ws);
        this._onRealData?.(normalized.kind, normalized.event);

        const ingest = normalized.kind === "launch"
          ? this._onLaunch(normalized.event)
          : this._onMigration(normalized.event);

        void ingest.then((accepted) => {
          const fields = {
            source: "pumpportal",
            kind: normalized.kind,
            mint: normalized.event.mint,
            signature: normalized.event.signature,
            lastRealEventAt: this._lastRealEventAt?.toISOString() ?? null,
          };
          if (accepted) {
            pumpPortalLog.info(fields, "pumpportal: event accepted by shared ingestion");
          } else {
            pumpPortalLog.debug(fields, "pumpportal: duplicate event ignored");
          }
        }).catch((err) => {
          pumpPortalLog.error(
            {
              err,
              kind: normalized.kind,
              mint: normalized.event.mint,
              signature: normalized.event.signature,
            },
            "pumpportal: shared ingestion failed",
          );
        });
      });

      ws.addEventListener("error", (err) => {
        pumpPortalLog.warn({ err: String(err) }, "pumpportal: WebSocket error");
      });

      ws.addEventListener("close", () => {
        if (this._ws === ws) this._ws = null;
        this._connected = false;
        this._clearDataStaleWatchdog();
        this._scheduleReconnect();
      });
    } catch (err) {
      this._connected = false;
      pumpPortalLog.error({ err }, "pumpportal: failed to open WebSocket");
      this._scheduleReconnect();
    }
  }
}