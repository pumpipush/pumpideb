/**
 * Regression coverage for the pump.fun → PumpSwap handoff in the primary
 * PumpAPI stream. A completed bonding curve must switch both its token row and
 * subsequent trades to PumpSwap, even when the explicit migration event is lost.
 */

import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../tradeEmitter", () => ({ emitTrade: vi.fn(), emitNewToken: vi.fn(), emitSnapshot: vi.fn() }));
vi.mock("../tradeEmitter.js", () => ({ emitTrade: vi.fn(), emitNewToken: vi.fn(), emitSnapshot: vi.fn() }));

import { and, eq, inArray } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { emitSnapshot } from "../tradeEmitter.js";
import { PumpApiAdapter } from "./pumpfun.js";

const TAG = `pump_migrate_${Date.now().toString(36)}`;
const MINTS: string[] = [];

function mint(label: string): string {
  const suffix = `${label}${TAG}`;
  return `${suffix.slice(0, Math.max(1, 44 - suffix.length))}${suffix}`.slice(0, 44);
}

function signature(label: string): string {
  return `${label}-${TAG}`;
}

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = MockWebSocket.OPEN;

  constructor(public readonly url: string) {
    super();
    Promise.resolve().then(() => this.dispatchEvent(new Event("open")));
  }

  send(): void {}

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

async function waitForToken(
  address: string,
  matches: (token: typeof tokensTable.$inferSelect) => boolean,
): Promise<typeof tokensTable.$inferSelect> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const [token] = await db.select().from(tokensTable).where(eq(tokensTable.address, address));
    if (token && matches(token)) return token;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${address} to reach expected transition state`);
}

async function insertPumpFunToken(address: string): Promise<void> {
  MINTS.push(address);
  await db.insert(tokensTable).values({
    address,
    name:           `Token ${address.slice(-6)}`,
    symbol:         `P${address.slice(-4)}`,
    creatorAddress: "pump-migration-test",
    platform:       "pump_fun",
    chain:          "solana",
    imageUrl:       "https://example.test/token.png",
  });
}

async function insertNativePumpSwapToken(address: string): Promise<void> {
  MINTS.push(address);
  await db.insert(tokensTable).values({
    address,
    name:           `Native ${address.slice(-6)}`,
    symbol:         `N${address.slice(-4)}`,
    creatorAddress: "native-pumpswap-test",
    platform:       "pumpswap",
    chain:          "solana",
    graduated:      true,
    graduatedAt:    new Date("2025-06-15T15:00:00.000Z"),
    poolAddress:    "NativePumpSwapPool",
    quoteMint:      "NativeQuoteMint",
  });
}

afterAll(async () => {
  if (!MINTS.length) return;
  await db.delete(tradesTable).where(inArray(tradesTable.tokenAddress, MINTS));
  await db.delete(tokensTable).where(inArray(tokensTable.address, MINTS));
});

describe("PumpApiAdapter PumpSwap migration handoff", () => {
  it("promotes a pump-created pump-amm migration event from the primary stream", async () => {
    const address = mint("direct");
    await insertPumpFunToken(address);

    let ws: MockWebSocket | null = null;
    const adapter = new PumpApiAdapter({
      wsFactory: (url) => {
        ws = new MockWebSocket(url);
        return ws as unknown as WebSocket;
      },
    });

    adapter.start();
    await Promise.resolve();

    const migratedAt = 1_750_000_000;
    ws!.receive({
      action:        "migrate",
      pool:          "pump-amm",
      poolCreatedBy: "pump",
      signature:     signature("migrate"),
      mint:          address,
      timestamp:     migratedAt,
      poolAddress:   "PumpSwapPoolDirect",
      quoteMint:     "So11111111111111111111111111111111111111112",
    });

    const token = await waitForToken(address, token =>
      token.graduated &&
      token.platform === "pumpswap" &&
      token.poolAddress === "PumpSwapPoolDirect",
    );
    adapter.stop();

    expect(token.graduatedAt?.toISOString()).toBe(new Date(migratedAt * 1_000).toISOString());
    expect(token.quoteMint).toBe("So11111111111111111111111111111111111111112");
    expect(emitSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      type: "snapshot",
      token: expect.objectContaining({ address, platform: "pumpswap" }),
    }));
  });

  it("ignores a pump-amm migration that was not created by pump.fun", async () => {
    const address = mint("foreign");
    await insertPumpFunToken(address);

    let ws: MockWebSocket | null = null;
    const adapter = new PumpApiAdapter({
      wsFactory: (url) => {
        ws = new MockWebSocket(url);
        return ws as unknown as WebSocket;
      },
    });
    adapter.start();
    await Promise.resolve();

    ws!.receive({
      action: "migrate", pool: "pump-amm", poolCreatedBy: "another-launchpad",
      signature: signature("foreign-migrate"), mint: address,
      timestamp: 1_750_000_010, poolAddress: "ForeignPool",
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    adapter.stop();

    const [token] = await db.select().from(tokensTable).where(eq(tokensTable.address, address));
    expect(token.platform).toBe("pump_fun");
    expect(token.graduated).toBe(false);
    expect(token.poolAddress).not.toBe("ForeignPool");
  });

  it("does not overwrite lifecycle data for a native PumpSwap token", async () => {
    const address = mint("native");
    await insertNativePumpSwapToken(address);

    const adapter = new PumpApiAdapter();
    await (adapter as any)._handlePumpMigration({
      action: "migrate", pool: "pump-amm", poolCreatedBy: "pump",
      signature: signature("native-migrate"), mint: address,
      timestamp: 1_750_000_020, poolAddress: "UnexpectedReplacement",
      quoteMint: "UnexpectedQuote",
    });

    const [token] = await db.select().from(tokensTable).where(eq(tokensTable.address, address));
    expect(token.platform).toBe("pumpswap");
    expect(token.graduatedAt?.toISOString()).toBe("2025-06-15T15:00:00.000Z");
    expect(token.poolAddress).toBe("NativePumpSwapPool");
    expect(token.quoteMint).toBe("NativeQuoteMint");
  });

  it("repairs an old pump.fun record when its first PumpSwap trade arrives", async () => {
    const address = mint("repair");
    await insertPumpFunToken(address);

    const adapter = new PumpApiAdapter();
    const tradeAt = 1_750_000_030;
    await (adapter as any)._handlePumpAmmTrade({
      action:        "buy",
      pool:          "pump-amm",
      signature:     signature("repair-trade"),
      mint:          address,
      timestamp:     tradeAt,
      poolAddress:   "PumpSwapPoolRepair",
      quoteMint:     "So11111111111111111111111111111111111111112",
      tokenAmount:   10_000,
      quoteAmount:   0.5,
      price:         0.00005,
      marketCapQuote: 50_000,
      txSigner:      "repair-trader",
    }, true);

    const [token] = await db.select().from(tokensTable).where(eq(tokensTable.address, address));
    const [trade] = await db.select().from(tradesTable).where(and(
      eq(tradesTable.tokenAddress, address),
      eq(tradesTable.txHash, signature("repair-trade")),
    ));

    expect(token.platform).toBe("pumpswap");
    expect(token.graduated).toBe(true);
    expect(token.graduatedAt?.toISOString()).toBe(new Date(tradeAt * 1_000).toISOString());
    expect(token.poolAddress).toBe("PumpSwapPoolRepair");
    expect(trade?.platform).toBe("pumpswap");
    expect(trade?.priceEth).toBe("0.000050000000000");
  });

  it("continues PumpSwap price, volume, and trade-history ingestion after migration", async () => {
    const address = mint("continued");
    await insertPumpFunToken(address);

    const adapter = new PumpApiAdapter();
    const migratedAt = 1_750_000_060;
    await (adapter as any)._handlePumpMigration({
      action:        "migrate",
      pool:          "pump-amm",
      poolCreatedBy: "pump",
      signature:     signature("continued-migrate"),
      mint:          address,
      timestamp:     migratedAt,
      poolAddress:   "PumpSwapPoolContinued",
    });

    await (adapter as any)._handlePumpAmmTrade({
      action: "buy", pool: "pump-amm", signature: signature("continued-buy"),
      mint: address, timestamp: migratedAt + 1, tokenAmount: 10_000,
      quoteAmount: 0.5, price: 0.00005, txSigner: "continued-buyer",
    }, true);
    await (adapter as any)._handlePumpAmmTrade({
      action: "sell", pool: "pump-amm", signature: signature("continued-sell"),
      mint: address, timestamp: migratedAt + 2, tokenAmount: 5_000,
      quoteAmount: 0.75, price: 0.00015, txSigner: "continued-seller",
    }, false);

    const [token] = await db.select().from(tokensTable).where(eq(tokensTable.address, address));
    const trades = await db.select().from(tradesTable)
      .where(eq(tradesTable.tokenAddress, address))
      .orderBy(tradesTable.timestamp);

    expect(token.platform).toBe("pumpswap");
    expect(token.graduated).toBe(true);
    expect(Number(token.tradeCount)).toBe(2);
    expect(token.volumeEth).toBe("1250000000");
    expect(token.priceEth).toBe("0.000150000000000");
    expect(trades).toHaveLength(2);
    expect(trades.map(trade => trade.platform)).toEqual(["pumpswap", "pumpswap"]);
    expect(trades.map(trade => trade.isBuy)).toEqual([true, false]);
  });

  it("keeps a delayed final pump.fun trade from overwriting the PumpSwap state", async () => {
    const address = mint("ordered");
    await insertPumpFunToken(address);

    let ws: MockWebSocket | null = null;
    const adapter = new PumpApiAdapter({
      wsFactory: (url) => {
        ws = new MockWebSocket(url);
        return ws as unknown as WebSocket;
      },
    });
    const originalHandleTrade = (adapter as any)._handleTrade.bind(adapter);
    let releaseTrade!: () => void;
    const pendingTrade = new Promise<void>(resolve => { releaseTrade = resolve; });
    let enteredTrade!: () => void;
    const tradeStarted = new Promise<void>(resolve => { enteredTrade = resolve; });
    (adapter as any)._handleTrade = async (...args: any[]) => {
      enteredTrade();
      await pendingTrade;
      await originalHandleTrade(...args);
    };

    adapter.start();
    await Promise.resolve();
    const baseTimestamp = 1_750_000_100;
    ws!.receive({
      action: "buy", pool: "pump", signature: signature("ordered-pump"),
      mint: address, timestamp: baseTimestamp, tokenAmount: 1_000,
      quoteAmount: 0.5, price: 0.0005,
      vQuoteInBondingCurve: 50, vTokensInBondingCurve: 100_000,
      txSigner: "pump-trader",
    });
    await tradeStarted;

    ws!.receive({
      action: "migrate", pool: "pump-amm", poolCreatedBy: "pump",
      signature: signature("ordered-migrate"), mint: address,
      timestamp: baseTimestamp + 1, poolAddress: "OrderedPumpSwapPool",
    });
    ws!.receive({
      action: "buy", pool: "pump-amm", signature: signature("ordered-amm"),
      mint: address, timestamp: baseTimestamp + 2, tokenAmount: 5_000,
      quoteAmount: 0.75, price: 0.00015, txSigner: "amm-trader",
    });

    await new Promise(resolve => setTimeout(resolve, 25));
    const [beforeRelease] = await db.select().from(tokensTable).where(eq(tokensTable.address, address));
    expect(beforeRelease.platform).toBe("pump_fun");

    releaseTrade();
    const token = await waitForToken(address, row =>
      row.platform === "pumpswap" && row.priceEth === "0.000150000000000",
    );
    adapter.stop();

    const trades = await db.select().from(tradesTable)
      .where(eq(tradesTable.tokenAddress, address))
      .orderBy(tradesTable.timestamp);
    expect(token.volumeEth).toBe("1250000000");
    expect(trades.map(trade => trade.platform)).toEqual(["pump_fun", "pumpswap"]);
  });
});