import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PumpApiAdapter, type PumpApiEvent } from "./pumpfun";
import {
  normalizePumpPortalEvent,
  PumpPortalAdapter,
  PUMPPORTAL_DATA_STALE_MS,
  type PumpPortalEvent,
} from "./pumpportal";

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  closed = false;
  sent: string[] = [];

  constructor(public readonly url: string) {
    super();
    Promise.resolve().then(() => this.dispatchEvent(new Event("open")));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify(data),
    }));
  }
}

function createPortalHarness(dataStaleMs = 1_000) {
  const sockets: MockWebSocket[] = [];
  const onLaunch = vi.fn(async () => true);
  const onMigration = vi.fn(async () => true);
  const onRealData = vi.fn();
  const adapter = new PumpPortalAdapter({
    onLaunch,
    onMigration,
    onRealData,
    dataStaleMs,
    wsFactory: (url) => {
      const socket = new MockWebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });

  return { adapter, sockets, onLaunch, onMigration, onRealData };
}

const portalLaunch: PumpPortalEvent = {
  signature: "create-signature-1",
  mint: "CreateMint111111111111111111111111111111111",
  traderPublicKey: "Creator11111111111111111111111111111111111",
  txType: "create",
  initialBuy: 40_300_932.337997,
  solAmount: 1.170745678,
  vTokensInBondingCurve: 1_032_699_067.662003,
  vSolInBondingCurve: 31.170745678,
  marketCapSol: 30.183764713,
  name: "Sentinel",
  symbol: "SENT",
  uri: "ipfs://metadata-cid",
  pool: "pump",
};

const portalMigration: PumpPortalEvent = {
  signature: "migration-signature-1",
  mint: portalLaunch.mint,
  txType: "migrate",
  pool: "pump-amm",
  poolKey: "PumpSwapPool1111111111111111111111111111111",
  marketCapSol: 410.77,
};

describe("normalizePumpPortalEvent", () => {
  it("maps the verified free launch payload to the canonical PumpAPI shape", () => {
    expect(normalizePumpPortalEvent(portalLaunch)).toEqual({
      kind: "launch",
      event: {
        action: "create",
        pool: "pump",
        signature: portalLaunch.signature,
        mint: portalLaunch.mint,
        txSigner: portalLaunch.traderPublicKey,
        initialBuy: portalLaunch.initialBuy,
        quoteAmount: portalLaunch.solAmount,
        vTokensInBondingCurve: portalLaunch.vTokensInBondingCurve,
        vQuoteInBondingCurve: portalLaunch.vSolInBondingCurve,
        marketCapQuote: portalLaunch.marketCapSol,
        price: undefined,
        timestamp: undefined,
        name: portalLaunch.name,
        symbol: portalLaunch.symbol,
        uri: portalLaunch.uri,
      },
    });
  });

  it("maps PumpSwap migrations and preserves an AMM pool address", () => {
    const normalized = normalizePumpPortalEvent(portalMigration);
    expect(normalized).toEqual({
      kind: "migration",
      event: {
        action: "migrate",
        pool: "pump-amm",
        poolCreatedBy: "pump",
        signature: portalMigration.signature,
        mint: portalMigration.mint,
        poolAddress: portalMigration.poolKey,
        quoteMint: undefined,
        tokensInPool: undefined,
        quoteInPool: undefined,
        marketCapQuote: portalMigration.marketCapSol,
        price: undefined,
        timestamp: undefined,
      },
    });
  });

  it("does not relabel an explicitly Raydium-bound migration as PumpSwap", () => {
    expect(normalizePumpPortalEvent({
      ...portalMigration,
      pool: "raydium",
    })).toBeNull();
  });

  it("ignores malformed JSON values and non-string event types", () => {
    expect(normalizePumpPortalEvent(null)).toBeNull();
    expect(normalizePumpPortalEvent(42)).toBeNull();
    expect(normalizePumpPortalEvent([])).toBeNull();
    expect(normalizePumpPortalEvent({
      ...portalLaunch,
      txType: { unexpected: true },
    })).toBeNull();
  });
});

describe("PumpPortalAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses one persistent socket for both free subscriptions", async () => {
    const { adapter, sockets } = createPortalHarness();
    adapter.start();
    await Promise.resolve();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent.map((frame) => JSON.parse(frame))).toEqual([
      { method: "subscribeNewToken" },
      { method: "subscribeMigration" },
    ]);

    adapter.stop();
  });

  it("marks only real launch/migration frames as provider data", async () => {
    const { adapter, sockets, onLaunch, onMigration, onRealData } = createPortalHarness();
    adapter.start();
    await Promise.resolve();

    const socket = sockets[0]!;
    socket.receive({ message: "Successfully subscribed to token creation events." });
    expect(onRealData).not.toHaveBeenCalled();
    expect(adapter.getHealthSnapshot().lastRealEventAt).toBeNull();

    socket.receive(portalLaunch);
    await Promise.resolve();
    expect(onLaunch).toHaveBeenCalledOnce();
    expect(onRealData).toHaveBeenLastCalledWith(
      "launch",
      expect.objectContaining({ signature: portalLaunch.signature }),
    );
    expect(adapter.getHealthSnapshot()).toEqual({
      connected: true,
      lastRealEventAt: expect.any(Date),
      lastEventKind: "launch",
    });

    socket.receive(portalMigration);
    await Promise.resolve();
    expect(onMigration).toHaveBeenCalledOnce();
    expect(adapter.getHealthSnapshot().lastEventKind).toBe("migration");

    adapter.stop();
  });

  it("ignores malformed upstream frames without disconnecting", async () => {
    const { adapter, sockets, onLaunch, onMigration } = createPortalHarness();
    adapter.start();
    await Promise.resolve();

    const socket = sockets[0]!;
    socket.receive(null);
    socket.receive(123);
    socket.receive({ ...portalLaunch, txType: { unexpected: true } });
    await Promise.resolve();

    expect(socket.closed).toBe(false);
    expect(onLaunch).not.toHaveBeenCalled();
    expect(onMigration).not.toHaveBeenCalled();

    adapter.stop();
  });

  it("reconnects when acknowledgements arrive but real data stays stale", async () => {
    const staleMs = 250;
    const { adapter, sockets } = createPortalHarness(staleMs);
    adapter.start();
    await Promise.resolve();

    const first = sockets[0]!;
    first.receive({ message: "Subscribed to 'migration' events." });
    vi.advanceTimersByTime(staleMs + 1);
    expect(first.closed).toBe(true);

    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(sockets).toHaveLength(2);

    adapter.stop();
  });

  it("resets the stale watchdog when a real launch arrives", async () => {
    const staleMs = 300;
    const { adapter, sockets } = createPortalHarness(staleMs);
    adapter.start();
    await Promise.resolve();

    const socket = sockets[0]!;
    vi.advanceTimersByTime(staleMs - 50);
    socket.receive(portalLaunch);
    await Promise.resolve();

    vi.advanceTimersByTime(100);
    expect(socket.closed).toBe(false);
    vi.advanceTimersByTime(staleMs);
    expect(socket.closed).toBe(true);

    adapter.stop();
  });

  it("keeps the production stale window above transient proxy hiccups", () => {
    expect(PUMPPORTAL_DATA_STALE_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe("PumpAPI/PumpPortal shared ingestion", () => {
  function createPumpApiWithHandlerSpies() {
    const adapter = new PumpApiAdapter({
      wsFactory: () => new MockWebSocket("wss://unused") as unknown as WebSocket,
    });
    const internals = adapter as unknown as {
      _handleCreate: (event: PumpApiEvent, source: string) => Promise<void>;
      _handlePumpMigration: (event: PumpApiEvent, source: string) => Promise<void>;
    };
    const create = vi.spyOn(internals, "_handleCreate").mockResolvedValue();
    const migration = vi.spyOn(internals, "_handlePumpMigration").mockResolvedValue();
    return { adapter, create, migration };
  }

  it("claims a launch signature once across both providers", async () => {
    const { adapter, create } = createPumpApiWithHandlerSpies();
    const normalized = normalizePumpPortalEvent(portalLaunch);
    expect(normalized?.kind).toBe("launch");
    const event = normalized!.event;

    const [fromPortal, fromPumpApi] = await Promise.all([
      adapter.ingestLaunchSignal(event, "pumpportal"),
      adapter.ingestLaunchSignal(event, "pumpapi"),
    ]);

    expect([fromPortal, fromPumpApi].filter(Boolean)).toHaveLength(1);
    expect(create).toHaveBeenCalledOnce();
  });

  it("deduplicates a PumpPortal launch after the live PumpAPI socket saw it", async () => {
    let socket: MockWebSocket | null = null;
    const adapter = new PumpApiAdapter({
      watchdogMs: 60_000,
      dataStaleMs: 60_000,
      wsFactory: (url) => {
        socket = new MockWebSocket(url);
        return socket as unknown as WebSocket;
      },
    });
    const internals = adapter as unknown as {
      _handleCreate: (event: PumpApiEvent, source: string) => Promise<void>;
    };
    const create = vi.spyOn(internals, "_handleCreate").mockResolvedValue();

    adapter.start();
    await Promise.resolve();
    const pumpApiFrame = normalizePumpPortalEvent(portalLaunch)!.event;
    socket!.receive(pumpApiFrame);
    await Promise.resolve();
    await Promise.resolve();

    const acceptedFromPortal = await adapter.ingestLaunchSignal(
      pumpApiFrame,
      "pumpportal",
    );
    expect(acceptedFromPortal).toBe(false);
    expect(create).toHaveBeenCalledOnce();

    adapter.stop();
  });

  it("lets PumpPortal recover a launch after primary ingestion fails", async () => {
    let socket: MockWebSocket | null = null;
    const adapter = new PumpApiAdapter({
      watchdogMs: 60_000,
      dataStaleMs: 60_000,
      wsFactory: (url) => {
        socket = new MockWebSocket(url);
        return socket as unknown as WebSocket;
      },
    });
    const internals = adapter as unknown as {
      _handleCreate: (event: PumpApiEvent, source: string) => Promise<void>;
    };
    const create = vi.spyOn(internals, "_handleCreate")
      .mockRejectedValueOnce(new Error("temporary primary failure"))
      .mockResolvedValueOnce();

    adapter.start();
    await Promise.resolve();
    const frame = normalizePumpPortalEvent(portalLaunch)!.event;
    socket!.receive(frame);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const recovered = await adapter.ingestLaunchSignal(frame, "pumpportal");
    expect(recovered).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);

    adapter.stop();
  });

  it("claims a migration signature once across both providers", async () => {
    const { adapter, migration } = createPumpApiWithHandlerSpies();
    const normalized = normalizePumpPortalEvent(portalMigration);
    expect(normalized?.kind).toBe("migration");
    const event = normalized!.event;

    const [fromPortal, fromPumpApi] = await Promise.all([
      adapter.ingestMigrationSignal(event, "pumpportal"),
      adapter.ingestMigrationSignal(event, "pumpapi"),
    ]);

    expect([fromPortal, fromPumpApi].filter(Boolean)).toHaveLength(1);
    expect(migration).toHaveBeenCalledOnce();
  });

  it("preserves launch-before-migration ordering per mint across providers", async () => {
    const adapter = new PumpApiAdapter({
      wsFactory: () => new MockWebSocket("wss://unused") as unknown as WebSocket,
    });
    const order: string[] = [];
    let releaseLaunch!: () => void;
    const launchBlocked = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const internals = adapter as unknown as {
      _handleCreate: (event: PumpApiEvent, source: string) => Promise<void>;
      _handlePumpMigration: (event: PumpApiEvent, source: string) => Promise<void>;
    };
    vi.spyOn(internals, "_handleCreate").mockImplementation(async () => {
      order.push("launch:start");
      await launchBlocked;
      order.push("launch:end");
    });
    vi.spyOn(internals, "_handlePumpMigration").mockImplementation(async () => {
      order.push("migration");
    });

    const launch = normalizePumpPortalEvent(portalLaunch)!.event;
    const migration = normalizePumpPortalEvent(portalMigration)!.event;
    const launchPromise = adapter.ingestLaunchSignal(launch, "pumpportal");
    const migrationPromise = adapter.ingestMigrationSignal(migration, "pumpapi");
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["launch:start"]);
    releaseLaunch();
    await Promise.all([launchPromise, migrationPromise]);
    expect(order).toEqual(["launch:start", "launch:end", "migration"]);
  });

  it("retains migration-before-create and reconciles it after the launch exists", async () => {
    const adapter = new PumpApiAdapter({
      wsFactory: () => new MockWebSocket("wss://unused") as unknown as WebSocket,
    });
    const migration = normalizePumpPortalEvent(portalMigration)!.event;
    const migratedSnapshot = {
      address: migration.mint!,
      name: "Sentinel",
      symbol: "SENT",
      imageUrl: null,
      priceEth: "0.000000410770000",
      marketCapEth: "410770000000",
      volumeEth: "0",
      virtualEthReserves: "0",
      virtualTokenReserves: "0",
      tradeCount: 0,
      platform: "pumpswap",
      chain: "solana",
    };
    const internals = adapter as unknown as {
      _rememberPendingMigration: (
        mint: string,
        event: PumpApiEvent,
        source: string,
      ) => void;
      _reconcilePendingMigration: (mint: string) => Promise<typeof migratedSnapshot | null>;
      _handlePumpMigration: (
        event: PumpApiEvent,
        source: string,
      ) => Promise<typeof migratedSnapshot | null>;
    };
    internals._rememberPendingMigration(migration.mint!, migration, "pumpportal");
    const applyMigration = vi.spyOn(internals, "_handlePumpMigration")
      .mockResolvedValue(migratedSnapshot);

    const reconciled = await internals._reconcilePendingMigration(migration.mint!);
    expect(reconciled).toEqual(migratedSnapshot);
    expect(applyMigration).toHaveBeenCalledWith(migration, "pumpportal");

    // Successful reconciliation removes the pending signal; it cannot replay.
    expect(await internals._reconcilePendingMigration(migration.mint!)).toBeNull();
    expect(applyMigration).toHaveBeenCalledOnce();
  });
});