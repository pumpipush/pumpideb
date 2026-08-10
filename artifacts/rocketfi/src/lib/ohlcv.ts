/**
 * Compute OHLCV candles from a list of trades.
 * Works for both our local EVM trades and PumpPortal Solana trades.
 */

import { Trade } from "@workspace/api-client-react";
import { PumpTrade } from "./pumpportal";
import type { CandlestickData, Time } from "lightweight-charts";

/** Timeframes supported by the old chart */
export type Timeframe = "15m" | "1h" | "6h" | "24h";

/** Extended timeframes for the new ChartCanvas toolbar */
export type ChartTimeframe = "1m" | "5m" | "15m" | "1H" | "4H" | "1D" | "1W";

export interface OHLCVBar {
  time:   number; // unix seconds
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

const BUCKET_SECONDS_LEGACY: Record<Timeframe, number> = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60,
};

export const BUCKET_SECONDS: Record<ChartTimeframe, number> = {
  "1m":  1 * 60,
  "5m":  5 * 60,
  "15m": 15 * 60,
  "1H":  60 * 60,
  "4H":  4 * 60 * 60,
  "1D":  24 * 60 * 60,
  "1W":  7 * 24 * 60 * 60,
};

function tsToSeconds(ts: string | number | Date): number | null {
  if (typeof ts === "number") {
    if (!isFinite(ts) || ts <= 0) return null;
    return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
  }
  if (ts instanceof Date) {
    const ms = ts.getTime();
    return isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
  }
  const parsed = Date.parse(String(ts));
  if (!isNaN(parsed) && parsed > 0) return Math.floor(parsed / 1000);
  return null; // invalid — caller must filter out
}

interface RawTick {
  time: number;   // unix seconds
  price: number;  // token price
  volume: number; // base currency amount (ETH or SOL)
}

function bucketTicks(ticks: RawTick[], bucketSecs: number): OHLCVBar[] {
  if (!ticks.length) return [];

  const sorted = [...ticks].sort((a, b) => a.time - b.time);
  const candles = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();

  for (const tick of sorted) {
    const bucket = Math.floor(tick.time / bucketSecs) * bucketSecs;
    const existing = candles.get(bucket);
    if (!existing) {
      candles.set(bucket, { o: tick.price, h: tick.price, l: tick.price, c: tick.price, v: tick.volume });
    } else {
      existing.h = Math.max(existing.h, tick.price);
      existing.l = Math.min(existing.l, tick.price);
      existing.c = tick.price;
      existing.v += tick.volume;
    }
  }

  return Array.from(candles.entries())
    .sort(([a], [b]) => a - b)
    .map(([time, c]) => ({
      time,
      open:   c.o,
      high:   c.h,
      low:    c.l,
      close:  c.c,
      volume: c.v,
    }));
}

/** Convert OHLCVBar[] → CandlestickData[] for lightweight-charts */
export function toBarsLC(bars: OHLCVBar[]): CandlestickData[] {
  return bars.map(b => ({
    time:  b.time as Time,
    open:  b.open,
    high:  b.high,
    low:   b.low,
    close: b.close,
  }));
}

/**
 * Compute SOL-per-token price from a local trade record.
 * Prefer the pre-computed priceEth column (SOL/token, already ÷1000).
 * Fall back to ethAmount (lamports) / tokenAmount (atomic units) / 1000.
 */
function tradePrice(t: Trade): number {
  const pe = parseFloat(t.priceEth ?? "");
  if (Number.isFinite(pe) && pe > 0) return pe;
  const ethAmt = parseFloat(t.ethAmount);
  const tokAmt = parseFloat(t.tokenAmount);
  // ethAmount is in lamports, tokenAmount in atomic units (1e6/token)
  // lamports/atomic ÷ 1000 = SOL/token  (1e9 lam/SOL ÷ 1e6 atomic/token = 1e3)
  return (Number.isFinite(ethAmt) && Number.isFinite(tokAmt) && tokAmt > 0)
    ? ethAmt / tokAmt / 1000
    : 0;
}

/** Convert our local EVM trades → OHLCVBar[] (new ChartTimeframe) */
export function tradesFromLocalBars(trades: Trade[], tf: ChartTimeframe): OHLCVBar[] {
  const ticks: RawTick[] = trades
    .flatMap(t => {
      const ts = tsToSeconds(t.timestamp);
      if (ts === null) return []; // drop trades with unparseable timestamps
      const ethAmt = parseFloat(t.ethAmount);
      const price  = tradePrice(t);
      if (price <= 0 || !Number.isFinite(price)) return [];
      return [{ time: ts, price, volume: Number.isFinite(ethAmt) ? ethAmt : 0 }];
    });

  return bucketTicks(ticks, BUCKET_SECONDS[tf]);
}

/** Convert our local EVM trades → OHLCV candles (legacy Timeframe, backward-compat) */
export function tradesFromLocal(trades: Trade[], tf: Timeframe): CandlestickData[] {
  const ticks: RawTick[] = trades
    .flatMap(t => {
      const ts = tsToSeconds(t.timestamp);
      if (ts === null) return [];
      const ethAmt = parseFloat(t.ethAmount);
      const price  = tradePrice(t);
      if (price <= 0 || !Number.isFinite(price)) return [];
      return [{ time: ts, price, volume: Number.isFinite(ethAmt) ? ethAmt : 0 }];
    });

  return toBarsLC(bucketTicks(ticks, BUCKET_SECONDS_LEGACY[tf]));
}

/** Convert PumpPortal live trades → OHLCVBar[] (new ChartTimeframe) */
export function tradesFromPumpBars(trades: PumpTrade[], tf: ChartTimeframe): OHLCVBar[] {
  const ticks: RawTick[] = trades
    .filter(t =>
      Number.isFinite(t.sol_amount) && t.sol_amount > 0 &&
      Number.isFinite(t.token_amount) && t.token_amount > 0
    )
    .flatMap(t => {
      const ts = tsToSeconds(t.timestamp);
      if (ts === null) return [];
      return [{ time: ts, price: t.sol_amount / t.token_amount, volume: t.sol_amount }];
    });

  return bucketTicks(ticks, BUCKET_SECONDS[tf]);
}

/** Convert PumpPortal live trades → OHLCV candles (legacy) */
export function tradesFromPump(trades: PumpTrade[], tf: Timeframe): CandlestickData[] {
  const ticks: RawTick[] = trades
    .filter(t =>
      Number.isFinite(t.sol_amount) && t.sol_amount > 0 &&
      Number.isFinite(t.token_amount) && t.token_amount > 0
    )
    .flatMap(t => {
      const ts = tsToSeconds(t.timestamp);
      if (ts === null) return [];
      return [{ time: ts, price: t.sol_amount / t.token_amount, volume: t.sol_amount }];
    });

  return toBarsLC(bucketTicks(ticks, BUCKET_SECONDS_LEGACY[tf]));
}

/**
 * Generate a synthetic bonding-curve price series when no real trades exist.
 * Returns OHLCVBar[] with volume.
 */
export function syntheticBars(
  basePrice: number,
  count = 48,
  bucketSecs = BUCKET_SECONDS["1H"]
): OHLCVBar[] {
  const now = Math.floor(Date.now() / 1000);
  const start = now - count * bucketSecs;
  const bars: OHLCVBar[] = [];

  let price = basePrice * 0.3;
  for (let i = 0; i < count; i++) {
    const time = start + i * bucketSecs;
    const trend = 1 + (i / count) * 0.8;
    const noise = 0.85 + Math.random() * 0.30;
    const open = price;
    const close = open * trend * noise;
    const high = Math.max(open, close) * (1 + Math.random() * 0.08);
    const low  = Math.min(open, close) * (1 - Math.random() * 0.08);
    bars.push({ time, open, high, low, close, volume: Math.random() * basePrice * 1000 });
    price = close;
  }
  return bars;
}

/**
 * Generate synthetic candles (legacy CandlestickData, backward-compat).
 */
export function syntheticCandles(
  basePrice: number,
  count = 48,
  bucketSecs = BUCKET_SECONDS_LEGACY["1h"]
): CandlestickData[] {
  return toBarsLC(syntheticBars(basePrice, count, bucketSecs));
}
