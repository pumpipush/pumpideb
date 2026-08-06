/**
 * In-process event emitter for broadcasting trade events to SSE clients.
 * Keeps a map of tokenAddress → Set of response writers so each token
 * only notifies its own subscribers.
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
    timestamp: string;
  };
  token: {
    address: string;
    priceEth: string | null;
    marketCapEth: string | null;
    volumeEth: string;
    virtualEthReserves: string;
    virtualTokenReserves: string;
    tradeCount: number;
  };
}

class TradeEmitter extends EventEmitter {}

export const tradeEmitter = new TradeEmitter();
tradeEmitter.setMaxListeners(200);

/** Emit a new trade to all subscribers of a token address */
export function emitTrade(event: TradeEvent): void {
  tradeEmitter.emit(`trade:${event.trade.tokenAddress}`, event);
  tradeEmitter.emit("trade:*", event); // wildcard for global feeds
}
