/**
 * pumpApiReplayBackfill.ts — Historical backfill via replay.pumpapi.io
 *
 * pumpapi.io stores all stream events as hourly compressed archives:
 *   https://replay.pumpapi.io/YEAR/MONTH/DAY/HOUR.jsonl.zst
 *
 * Format: zstd-compressed newline-delimited JSON — same schema as the live stream.
 * Available from: 2026-04-18T00:00:00Z
 * Size: ~400 MB compressed / ~2 GB decompressed per hour.
 *
 * This module covers:
 *  1. Gaps left by stream reconnections (server restarts, pumpapi.io outages).
 *  2. Garbled token names: create events update name/symbol via ON CONFLICT DO UPDATE.
 *  3. LaunchLab + PumpSwap + Pump.fun — all from one source, replacing the
 *     failing RPC-based LaunchLab backfill (drpc.org HTTP 500).
 *
 * Strategy:
 *   - On startup (after 45 s): catch up from watermark or last DEFAULT_LOOKBACK_H hours.
 *   - Every 65 min: process the just-completed hour.
 *   - Watermark persisted in a JSON file; survives restarts.
 *   - All inserts use ON CONFLICT DO NOTHING (trades) or DO UPDATE (creates) —
 *     re-processing an hour is always safe.
 */

import path              from "node:path";
import fs                from "node:fs";
import { fileURLToPath } from "node:url";
import { Decompress }    from "fzstd";
import { db }            from "@workspace/db";
import { tokensTable, tradesTable } from "@workspace/db";
import { eq, sql }       from "drizzle-orm";
import { logger as rootLogger } from "./logger.js";

const log = rootLogger.child({ module: "replay-backfill" });

// ── Config ─────────────────────────────────────────────────────────────────────

const REPLAY_BASE           = "https://replay.pumpapi.io";
const REPLAY_AVAILABLE_FROM = new Date("2026-04-18T00:00:00Z");
/** Hours to look back when no watermark exists (covers routine maintenance). */
const DEFAULT_LOOKBACK_H    = 24;
/** Interval between hourly top-up runs (65 min ensures the archive is published). */
const HOURLY_INTERVAL_MS    = 65 * 60_000;
/** Per-hour download + process timeout (ms). */
const HOUR_TIMEOUT_MS       = 4 * 60_000;

const __filename     = fileURLToPath(import.meta.url);
const __dirname      = path.dirname(__filename);
const WATERMARK_FILE = path.resolve(__dirname, "../../.replay-backfill-watermark.json");

// ── Platform constants ─────────────────────────────────────────────────────────

const CHAIN = "solana";

// Pump.fun bonding curve
const PUMP_PLATFORM     = "pump_fun";
const PUMP_TOTAL_SUPPLY = 1_000_000_000_000_000n;
const PUMP_INIT_VSOL_L  = 30_000_000_000n;         // 30 SOL in lamports
const PUMP_INIT_VTOK    = 1_073_000_191_045_000n;   // base units
const PUMP_INIT_MC      = (PUMP_TOTAL_SUPPLY * PUMP_INIT_VSOL_L / PUMP_INIT_VTOK).toString();
const PUMP_INIT_PRICE   = (Number(PUMP_INIT_VSOL_L) / Number(PUMP_INIT_VTOK) / 1000).toFixed(15);
const PUMP_INIT_VSOL_S  = "30";
const PUMP_INIT_VTOK_S  = PUMP_INIT_VTOK.toString();

// PumpSwap (graduated pump AMM) — must match the string used everywhere else in the codebase
const PSWAP_PLATFORM    = "pumpswap";

// Raydium LaunchLab
const LL_PLATFORM       = "raydium_launchlab";
const LL_TOTAL_SUPPLY   = 1_000_000_000_000_000n;
const LL_INIT_VSOL_L    = 30_000_000_000n;
const LL_INIT_MC        = (LL_TOTAL_SUPPLY * LL_INIT_VSOL_L / LL_TOTAL_SUPPLY).toString(); // 30 SOL
const LL_INIT_PRICE     = (Number(LL_INIT_VSOL_L) / Number(LL_TOTAL_SUPPLY) / 1000).toFixed(15);
const LL_INIT_VSOL_S    = "30";
const LL_INIT_VTOK_S    = LL_TOTAL_SUPPLY.toString();

// ── Watermark ──────────────────────────────────────────────────────────────────

function readWatermark(): Date | null {
  try {
    if (!fs.existsSync(WATERMARK_FILE)) return null;
    const { lastProcessedHourUtc } = JSON.parse(fs.readFileSync(WATERMARK_FILE, "utf-8")) as { lastProcessedHourUtc: string };
    const d = new Date(lastProcessedHourUtc);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function writeWatermark(hourDt: Date): void {
  try {
    fs.writeFileSync(WATERMARK_FILE, JSON.stringify({ lastProcessedHourUtc: hourDt.toISOString() }));
  } catch (err) {
    log.warn({ err }, "replay-backfill: failed to write watermark");
  }
}

// ── Unit helpers ───────────────────────────────────────────────────────────────

const solToLamports = (sol: number | undefined): string =>
  sol != null && isFinite(sol) && sol > 0
    ? BigInt(Math.round(sol * 1e9)).toString()
    : "0";

const tokToBase = (display: number | undefined): string =>
  display != null && isFinite(display) && display > 0
    ? BigInt(Math.round(display * 1e6)).toString()
    : "0";

const parseTs = (ts: number | undefined): Date =>
  ts ? (ts >= 1e12 ? new Date(ts) : new Date(ts * 1000)) : new Date();

// ── Event shape ────────────────────────────────────────────────────────────────

interface ReplayEvent {
  action?:    string;
  pool?:      string;
  signature?: string;
  mint?:      string;
  txSigner?:  string;
  name?:      string;
  symbol?:    string;
  uri?:       string;
  tokenAmount?:            number;
  quoteAmount?:            number;
  initialBuy?:             number;
  vTokensInBondingCurve?:  number;
  vQuoteInBondingCurve?:   number;
  price?:                  number;
  marketCapQuote?:         number;
  timestamp?:              number;
  breakdown?: Array<{ trader?: string; tokenAmount?: number; quoteAmount?: number }>;
}

// ── Shared DB helpers ──────────────────────────────────────────────────────────

async function upsertCreate(
  mint: string, name: string, symbol: string, creator: string,
  totalSupply: string, vSolStr: string, vTokStr: string,
  mcStr: string, priceStr: string, platform: string, ts: Date,
): Promise<void> {
  await db.insert(tokensTable).values({
    address: mint, name, symbol,
    description: null, imageUrl: null,
    creatorAddress:       creator,
    totalSupply,
    virtualTokenReserves: vTokStr,
    virtualEthReserves:   vSolStr,
    marketCapEth:         mcStr,
    priceEth:             priceStr,
    platform, chain: CHAIN, createdAt: ts,
  }).onConflictDoUpdate({
    target: tokensTable.address,
    // Metadata from create is authoritative — overwrite any stub left by a
    // trade that beat the create event in the stream race.
    set: { name, symbol, creatorAddress: creator },
  });
}

/**
 * Insert one trade.  Returns true if the row was newly inserted (not duplicate).
 * Side-effects: upserts a minimal token stub for FK safety, then on new insert
 * increments trade_count + volume and optionally updates price/reserves/market-cap.
 */
async function insertTrade(
  mint: string, trader: string, isBuy: boolean,
  solLam: string, tokBase: string, priceEth: string | null,
  txHash: string, platform: string, ts: Date,
  updVSol?: string, updVTok?: string, updMC?: string,
): Promise<boolean> {
  // FK guard — onConflictDoNothing leaves real rows untouched
  await db.insert(tokensTable).values({
    address: mint, name: mint.slice(0, 8), symbol: "???",
    creatorAddress: "unknown", platform, chain: CHAIN,
  }).onConflictDoNothing();

  const [trade] = await db.insert(tradesTable).values({
    tokenAddress: mint, tokenName: null, tokenSymbol: null,
    traderAddress: trader, isBuy,
    ethAmount: solLam, tokenAmount: tokBase, priceEth,
    txHash, platform, timestamp: ts,
  }).onConflictDoNothing().returning();

  if (!trade) return false;

  await db.update(tokensTable).set({
    tradeCount: sql`${tokensTable.tradeCount} + 1`,
    volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLam} AS TEXT)`,
    ...(priceEth != null  ? { priceEth }                          : {}),
    ...(updVSol            ? { virtualEthReserves:   updVSol }    : {}),
    ...(updVTok            ? { virtualTokenReserves: updVTok }    : {}),
    ...(updMC              ? { marketCapEth: updMC }              : {}),
  }).where(eq(tokensTable.address, mint));

  return true;
}

// ── Pool-specific handlers ─────────────────────────────────────────────────────

async function onPumpCreate(ev: ReplayEvent): Promise<void> {
  const mint = ev.mint!, creator = ev.txSigner ?? "unknown";
  const vSol  = ev.vQuoteInBondingCurve  != null ? String(ev.vQuoteInBondingCurve)               : PUMP_INIT_VSOL_S;
  const vTok  = ev.vTokensInBondingCurve != null ? tokToBase(ev.vTokensInBondingCurve)            : PUMP_INIT_VTOK_S;
  const mc    = ev.marketCapQuote        != null ? BigInt(Math.round(ev.marketCapQuote * 1e9)).toString() : PUMP_INIT_MC;
  const price = ev.price != null && isFinite(ev.price) && ev.price > 0 ? ev.price.toFixed(15)    : PUMP_INIT_PRICE;
  const ts    = parseTs(ev.timestamp);

  await upsertCreate(mint, ev.name!.trim(), ev.symbol!.trim(), creator,
    PUMP_TOTAL_SUPPLY.toString(), vSol, vTok, mc, price, PUMP_PLATFORM, ts);

  if (ev.initialBuy && ev.initialBuy > 0 && ev.quoteAmount && ev.quoteAmount > 0) {
    await insertTrade(mint, ev.breakdown?.[0]?.trader ?? creator, true,
      solToLamports(ev.quoteAmount), tokToBase(ev.initialBuy), price,
      ev.signature!, PUMP_PLATFORM, ts);
  }
}

async function onPumpTrade(ev: ReplayEvent, isBuy: boolean): Promise<void> {
  const mint   = ev.mint!;
  const trader = ev.breakdown?.[0]?.trader ?? ev.txSigner ?? "unknown";
  const ts     = parseTs(ev.timestamp);
  const solLam = solToLamports(ev.quoteAmount);
  const tokB   = tokToBase(ev.tokenAmount);

  const vSolLam  = ev.vQuoteInBondingCurve  != null ? BigInt(Math.round(ev.vQuoteInBondingCurve  * 1e9)) : null;
  const vTokBase = ev.vTokensInBondingCurve != null ? BigInt(Math.round(ev.vTokensInBondingCurve * 1e6)) : null;

  let updVSol: string | undefined, updVTok: string | undefined, updMC: string | undefined;
  let price: string | null = null;

  if (vSolLam && vTokBase && vSolLam > 0n && vTokBase > 0n) {
    updVSol = (Number(vSolLam) / 1e9).toFixed(6).replace(/\.?0+$/, "");
    updVTok = vTokBase.toString();
    updMC   = (PUMP_TOTAL_SUPPLY * vSolLam / vTokBase).toString();
    price   = (Number(vSolLam) / Number(vTokBase) / 1000).toFixed(15);
  } else if (ev.price != null && isFinite(ev.price) && ev.price > 0) {
    price = ev.price.toFixed(15);
  }

  await insertTrade(mint, trader, isBuy, solLam, tokB, price,
    ev.signature!, PUMP_PLATFORM, ts, updVSol, updVTok, updMC);
}

async function onPumpAmmTrade(ev: ReplayEvent, isBuy: boolean): Promise<void> {
  const price = ev.price != null && isFinite(ev.price) && ev.price > 0 ? ev.price.toFixed(15) : null;
  await insertTrade(
    ev.mint!, ev.breakdown?.[0]?.trader ?? ev.txSigner ?? "unknown", isBuy,
    solToLamports(ev.quoteAmount), tokToBase(ev.tokenAmount), price,
    ev.signature!, PSWAP_PLATFORM, parseTs(ev.timestamp),
  );
}

async function onLabCreate(ev: ReplayEvent): Promise<void> {
  const mint = ev.mint!, creator = ev.txSigner ?? "unknown";
  const vSol  = ev.vQuoteInBondingCurve  != null ? String(ev.vQuoteInBondingCurve)               : LL_INIT_VSOL_S;
  const vTok  = ev.vTokensInBondingCurve != null ? tokToBase(ev.vTokensInBondingCurve)            : LL_INIT_VTOK_S;
  const mc    = ev.marketCapQuote        != null ? BigInt(Math.round(ev.marketCapQuote * 1e9)).toString() : LL_INIT_MC;
  const price = ev.price != null && isFinite(ev.price) && ev.price > 0 ? ev.price.toFixed(15)    : LL_INIT_PRICE;
  const ts    = parseTs(ev.timestamp);

  await upsertCreate(mint, ev.name!.trim(), ev.symbol!.trim(), creator,
    LL_TOTAL_SUPPLY.toString(), vSol, vTok, mc, price, LL_PLATFORM, ts);

  if (ev.initialBuy && ev.initialBuy > 0 && ev.quoteAmount && ev.quoteAmount > 0) {
    await insertTrade(mint, ev.breakdown?.[0]?.trader ?? creator, true,
      solToLamports(ev.quoteAmount), tokToBase(ev.initialBuy), price,
      ev.signature!, LL_PLATFORM, ts);
  }
}

async function onLabTrade(ev: ReplayEvent, isBuy: boolean): Promise<void> {
  const mint   = ev.mint!;
  const trader = ev.breakdown?.[0]?.trader ?? ev.txSigner ?? "unknown";
  const ts     = parseTs(ev.timestamp);
  const solLam = solToLamports(ev.quoteAmount);
  const tokB   = tokToBase(ev.tokenAmount);

  const vSolLam  = ev.vQuoteInBondingCurve  != null ? BigInt(Math.round(ev.vQuoteInBondingCurve  * 1e9)) : null;
  const vTokBase = ev.vTokensInBondingCurve != null ? BigInt(Math.round(ev.vTokensInBondingCurve * 1e6)) : null;

  let updVSol: string | undefined, updVTok: string | undefined, updMC: string | undefined;
  let price: string | null = null;

  if (vSolLam && vTokBase && vSolLam > 0n && vTokBase > 0n) {
    updVSol = (Number(vSolLam) / 1e9).toFixed(6).replace(/\.?0+$/, "");
    updVTok = vTokBase.toString();
    updMC   = (LL_TOTAL_SUPPLY * vSolLam / vTokBase).toString();
    price   = (Number(vSolLam) / Number(vTokBase) / 1000).toFixed(15);
  } else if (ev.marketCapQuote != null) {
    updMC = BigInt(Math.round(ev.marketCapQuote * 1e9)).toString();
    if (ev.price != null && isFinite(ev.price) && ev.price > 0) price = ev.price.toFixed(15);
  }

  await insertTrade(mint, trader, isBuy, solLam, tokB, price,
    ev.signature!, LL_PLATFORM, ts, updVSol, updVTok, updMC);
}

// ── Streaming download + zstd decompress + line split ─────────────────────────

async function* streamLines(url: string, signal: AbortSignal): AsyncGenerator<string> {
  const res = await fetch(url, { signal });
  if (res.status === 404) {
    log.debug({ url }, "replay-backfill: archive not yet available (404)");
    return;
  }
  if (!res.ok) throw new Error(`replay HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error("no response body");

  // fzstd Decompress: callback-based streaming — each push() calls back with
  // decompressed Uint8Array chunks as they become available.
  const pending: Uint8Array[] = [];
  const decomp = new Decompress((chunk) => pending.push(chunk));

  const reader  = res.body.getReader();
  const textDec = new TextDecoder();
  let   textBuf = "";

  // Drain pending decompressed chunks into lines
  const flushLines = function*(): Generator<string> {
    while (pending.length) {
      textBuf += textDec.decode(pending.shift()!, { stream: true });
      const parts = textBuf.split("\n");
      textBuf = parts.pop() ?? "";
      for (const l of parts) { if (l.trim()) yield l; }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) { decomp.push(value, done); yield* flushLines(); }
      if (done) break;
    }
    // Flush any trailing incomplete line
    if (textBuf.trim()) yield textBuf;
  } finally {
    reader.releaseLock();
  }
}

// ── Process one hour archive ───────────────────────────────────────────────────

async function processHour(hourDt: Date): Promise<void> {
  const y   = hourDt.getUTCFullYear();
  const mo  = String(hourDt.getUTCMonth() + 1).padStart(2, "0");
  const d   = String(hourDt.getUTCDate()).padStart(2, "0");
  const h   = String(hourDt.getUTCHours()).padStart(2, "0");
  const url = `${REPLAY_BASE}/${y}/${mo}/${d}/${h}.jsonl.zst`;

  log.info({ url }, "replay-backfill: processing hour");

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), HOUR_TIMEOUT_MS);

  let total = 0, actionable = 0;

  try {
    for await (const line of streamLines(url, ctrl.signal)) {
      total++;
      let ev: ReplayEvent;
      try { ev = JSON.parse(line); } catch { continue; }

      const pool   = ev.pool ?? "";
      const action = (ev.action ?? "").toLowerCase();
      if (!ev.mint || !ev.signature) continue;
      if (pool !== "pump" && pool !== "pump-amm" && pool !== "raydium-launchpad") continue;

      actionable++;

      try {
        if (pool === "pump") {
          if (action === "create" && ev.name?.trim() && ev.symbol?.trim()) await onPumpCreate(ev);
          else if (action === "buy" || action === "sell") await onPumpTrade(ev, action === "buy");
        } else if (pool === "pump-amm") {
          if (action === "buy" || action === "sell") await onPumpAmmTrade(ev, action === "buy");
        } else if (pool === "raydium-launchpad") {
          if (action === "create" && ev.name?.trim() && ev.symbol?.trim()) await onLabCreate(ev);
          else if (action === "buy" || action === "sell") await onLabTrade(ev, action === "buy");
        }
      } catch (err) {
        log.warn({ err, pool, action, mint: ev.mint }, "replay-backfill: event error (skipped)");
      }
    }
  } finally {
    clearTimeout(timer);
  }

  log.info({ url, total, actionable }, "replay-backfill: hour done");
}

// ── Catch-up logic ─────────────────────────────────────────────────────────────

async function runCatchUp(): Promise<void> {
  const now = new Date();

  // The most recently COMPLETED hour (current UTC hour − 1)
  const latestDone = new Date(now);
  latestDone.setUTCMinutes(0, 0, 0);
  latestDone.setUTCHours(latestDone.getUTCHours() - 1);

  const wm       = readWatermark();
  const fallback = new Date(latestDone.getTime() - DEFAULT_LOOKBACK_H * 3_600_000);
  const startRaw = wm ? new Date(wm.getTime() + 3_600_000) : fallback;
  const start    = new Date(Math.max(startRaw.getTime(), REPLAY_AVAILABLE_FROM.getTime(), fallback.getTime()));

  if (start > latestDone) {
    log.info({ wm: wm?.toISOString(), upTo: latestDone.toISOString() },
      "replay-backfill: already up-to-date");
    return;
  }

  const hours: Date[] = [];
  for (let t = new Date(start); t <= latestDone; t = new Date(t.getTime() + 3_600_000)) {
    hours.push(new Date(t));
  }

  log.info({ from: start.toISOString(), to: latestDone.toISOString(), count: hours.length },
    "replay-backfill: starting catch-up");

  for (const h of hours) {
    try {
      await processHour(h);
      writeWatermark(h);
    } catch (err) {
      log.error({ err, hour: h.toISOString() }, "replay-backfill: hour failed — pausing catch-up");
      break; // try again next scheduled run
    }
  }

  log.info("replay-backfill: catch-up run complete");
}

// ── Public entry point ─────────────────────────────────────────────────────────

let _running = false;

/**
 * Start the replay backfill system.
 *
 * Call once from server startup after adapters have connected.
 * - Runs an initial catch-up 45 s after startup (covers restarts / outages).
 * - Then runs every 65 min to pull the just-completed hour's archive.
 */
export function startReplayBackfill(): void {
  const run = async () => {
    if (_running) return;
    _running = true;
    try { await runCatchUp(); }
    catch (err) { log.error({ err }, "replay-backfill: run error"); }
    finally { _running = false; }
  };

  // First run: 45 s after startup
  setTimeout(() => { void run(); }, 45_000);

  // Recurring: every 65 min
  setInterval(() => { void run(); }, HOURLY_INTERVAL_MS);
}
