/**
 * Compute OHLCV candles from a list of trades.
 * Works for both our local EVM trades and PumpPortal Solana trades.
 */

import { Trade } from "@workspace/api-client-react";
import { PumpTrade } from "./pumpportal";
import type { CandlestickData, Time } from "lightweight-charts";

export type Timeframe = "15m" | "1h" | "6h" | "24h";

const BUCKET_SECONDS: Record<Timeframe, number> = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60,
};

function tsToSeconds(ts: string | number | Date): number {
  if (typeof ts === "number") {
    // If it looks like milliseconds (> year 2000 in ms), convert
    return ts > 1e12 ? Math.floor(ts / 1000) : ts;
  }
  if (ts instanceof Date) return Math.floor(ts.getTime() / 1000);
  const parsed = Date.parse(String(ts));
  if (!isNaN(parsed)) return Math.floor(parsed / 1000);
  return Math.floor(Date.now() / 1000);
}

interface RawTick {
  time: number;   // unix seconds
  price: number;  // token price
  volume: number; // base currency amount (ETH or SOL)
}

function bucketTicks(ticks: RawTick[], bucketSecs: number): CandlestickData[] {
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
      time: time as Time,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    }));
}

/** Convert our local EVM trades → OHLCV candles */
export function tradesFromLocal(trades: Trade[], tf: Timeframe): CandlestickData[] {
  const ticks: RawTick[] = trades
    .map(t => {
      const ethAmt = parseFloat(t.ethAmount);
      const tokAmt = parseFloat(t.tokenAmount);
      return {
        time: tsToSeconds(t.timestamp),
        price: (Number.isFinite(ethAmt) && Number.isFinite(tokAmt) && tokAmt > 0) ? ethAmt / tokAmt : 0,
        volume: Number.isFinite(ethAmt) ? ethAmt : 0,
      };
    })
    .filter(t => t.price > 0 && Number.isFinite(t.price) && t.time > 0);

  return bucketTicks(ticks, BUCKET_SECONDS[tf]);
}

/** Convert PumpPortal live trades → OHLCV candles */
export function tradesFromPump(trades: PumpTrade[], tf: Timeframe): CandlestickData[] {
  const ticks: RawTick[] = trades
    .filter(t =>
      Number.isFinite(t.sol_amount) && t.sol_amount > 0 &&
      Number.isFinite(t.token_amount) && t.token_amount > 0
    )
    .map(t => ({
      time: tsToSeconds(t.timestamp),
      price: t.sol_amount / t.token_amount,
      volume: t.sol_amount,
    }));

  return bucketTicks(ticks, BUCKET_SECONDS[tf]);
}

/**
 * Generate a synthetic bonding-curve price series when no real trades exist.
 * Creates a realistic-looking OHLCV dataset for demo purposes.
 */
export function syntheticCandles(
  basePrice: number,
  count = 48,
  bucketSecs = BUCKET_SECONDS["1h"]
): CandlestickData[] {
  const now = Math.floor(Date.now() / 1000);
  const start = now - count * bucketSecs;
  const candles: CandlestickData[] = [];

  let price = basePrice * 0.3;
  for (let i = 0; i < count; i++) {
    const time = (start + i * bucketSecs) as Time;
    const trend = 1 + (i / count) * 0.8; // upward drift
    const noise = 0.85 + Math.random() * 0.30;
    const open = price;
    const close = open * trend * noise;
    const high = Math.max(open, close) * (1 + Math.random() * 0.08);
    const low = Math.min(open, close) * (1 - Math.random() * 0.08);
    candles.push({ time, open, high, low, close });
    price = close;
  }
  return candles;
}
