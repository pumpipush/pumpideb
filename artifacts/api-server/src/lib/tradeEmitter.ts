/**
 * In-process event bus for broadcasting real-time events to SSE clients.
 *
 * Channels:
 *   trade:<tokenAddress>  — per-token trade events (consumed by per-token SSE)
 *   trade:*               — all trades across all platforms (consumed by global feed)
 *   newToken:*            — new token launches from any adapter (consumed by global feed)
 */
import { EventEmitter } from "events";

export interface TradeEvent {
  type: "trade";
  trade: {
    id: number;
    tokenAddress: string;
    traderAddress: string;
    isBuy: boolean;
    ethAmount: string;
    tokenAmount: string;
    priceEth: string | null;
    txHash: string;
    platform: string;
    timestamp: string;
  };
  token: {
    address: string;
    name?: string | null;
    symbol?: string | null;
    priceEth: string | null;
    marketCapEth: string | null;
    volumeEth: string;
    virtualEthReserves: string;
    virtualTokenReserves: string;
    tradeCount: number;
    platform: string;
    chain: string;
  };
}

export interface NewTokenEvent {
  type: "newToken";
  token: {
    address: string;
    name: string;
    symbol: string;
    imageUrl: string | null;
    priceEth: string | null;
    marketCapEth: string | null;
    platform: string;
    chain: string;
    createdAt: string;
  };
}

class EventBus extends EventEmitter {}

export const tradeEmitter = new EventBus();
tradeEmitter.setMaxListeners(500);

/** Emit a new trade to per-token subscribers AND the global wildcard feed */
export function emitTrade(event: TradeEvent): void {
  tradeEmitter.emit(`trade:${event.trade.tokenAddress}`, event);
  tradeEmitter.emit("trade:*", event);
}

/** Emit a new token launch to the global wildcard feed */
export function emitNewToken(event: NewTokenEvent): void {
  tradeEmitter.emit("newToken:*", event);
}
