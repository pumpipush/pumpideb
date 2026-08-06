/**
 * Onchain indexer for RocketFi + TokenLauncher contracts.
 *
 * Polls the configured EVM RPC for events and syncs them into the database:
 *   - TokenLaunched → upsert token record
 *   - CreatePool    → upsert token record (fallback if no TokenLauncher)
 *   - Trade         → insert trade + update reserves / price / volume
 *   - Complete      → mark token graduated
 *
 * Configuration (env vars):
 *   RPC_URL                    — JSON-RPC endpoint (e.g. https://mainnet.base.org)
 *   ROCKETFI_CONTRACT          — Deployed RocketFi.sol address
 *   TOKEN_LAUNCHER_CONTRACT    — Deployed TokenLauncher.sol address (optional)
 *   INDEXER_START_BLOCK        — Block to start from on first run (default: latest−10 000)
 *   INDEXER_POLL_INTERVAL_MS   — Poll cadence in ms (default: 12 000)
 *   INDEXER_CHUNK_SIZE         — Max blocks per getLogs call (default: 2 000)
 */

import { ethers } from "ethers";
import { eq, sql } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { logger } from "./logger";
import { ROCKETFI_ABI, TOKEN_LAUNCHER_ABI } from "./abis";

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC_URL                = process.env["RPC_URL"]                 ?? "";
const ROCKETFI_ADDR          = (process.env["ROCKETFI_CONTRACT"]      ?? "").toLowerCase();
const LAUNCHER_ADDR          = (process.env["TOKEN_LAUNCHER_CONTRACT"] ?? "").toLowerCase();
const START_BLOCK            = Number(process.env["INDEXER_START_BLOCK"]       ?? "0");
const POLL_MS                = Number(process.env["INDEXER_POLL_INTERVAL_MS"]  ?? "12000");
const CHUNK_SIZE             = Number(process.env["INDEXER_CHUNK_SIZE"]        ?? "2000");

// ─── Module state ─────────────────────────────────────────────────────────────

interface IndexerStatus {
  active:          boolean;
  rpcUrl:          string;
  rocketFiAddr:    string;
  launcherAddr:    string;
  lastIndexedBlock: number | null;
  latestBlock:     number | null;
  eventsProcessed: number;
  tokensIndexed:   number;
  tradesIndexed:   number;
  errors:          number;
  startedAt:       string | null;
  lastError:       string | null;
}

const status: IndexerStatus = {
  active:           false,
  rpcUrl:           RPC_URL,
  rocketFiAddr:     ROCKETFI_ADDR,
  launcherAddr:     LAUNCHER_ADDR,
  lastIndexedBlock: null,
  latestBlock:      null,
  eventsProcessed:  0,
  tokensIndexed:    0,
  tradesIndexed:    0,
  errors:           0,
  startedAt:        null,
  lastError:        null,
};

export function getIndexerStatus(): Readonly<IndexerStatus> {
  return status;
}

// ─── Interface fragments for decoding ─────────────────────────────────────────

const rocketFiIface   = new ethers.Interface(ROCKETFI_ABI as unknown as string[]);
const launcherIface   = new ethers.Interface(TOKEN_LAUNCHER_ABI as unknown as string[]);

// Pre-compute topic0 hashes so we can filter logs
const TOPIC_TRADE          = rocketFiIface.getEvent("Trade")!.topicHash;
const TOPIC_CREATE_POOL    = rocketFiIface.getEvent("CreatePool")!.topicHash;
const TOPIC_COMPLETE       = rocketFiIface.getEvent("Complete")!.topicHash;
const TOPIC_TOKEN_LAUNCHED = launcherIface.getEvent("TokenLaunched")!.topicHash;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a bigint wei value as a plain ETH float string (human-readable). */
function weiToEth(wei: bigint): string {
  return ethers.formatEther(wei);
}

/**
 * Calculate ETH price per token from AMM reserves.
 * Both virtualEthReserves and virtualTokenReserves are uint256 with 18-decimal
 * precision — the ratio is already in ETH/token.
 */
function calcPriceEth(virtualEthReserves: bigint, virtualTokenReserves: bigint): string {
  if (virtualTokenReserves === 0n) return "0";
  // Use high-precision integer arithmetic: multiply numerator by 1e18 before dividing.
  const SCALE = 10n ** 18n;
  const scaled = (virtualEthReserves * SCALE) / virtualTokenReserves;
  return (Number(scaled) / 1e18).toString();
}

/**
 * Calculate market cap in ETH from bonding curve reserves.
 * Formula mirrors the contract:  mcap = virtualEthReserves * totalSupply / virtualTokenReserves
 * Result divided by 1e18 to get ETH (human-readable).
 */
function calcMarketCapEth(virtualEthReserves: bigint, virtualTokenReserves: bigint, totalSupply: bigint): string {
  if (virtualTokenReserves === 0n) return "0";
  const mcapWei = (virtualEthReserves * totalSupply) / virtualTokenReserves;
  return ethers.formatEther(mcapWei);
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/** Upsert a token row discovered on-chain without clobbering existing metadata. */
async function upsertToken(params: {
  address:               string;
  name:                  string;
  symbol:                string;
  creatorAddress:        string;
  virtualTokenReserves?: bigint;
  virtualEthReserves?:   bigint;
  realTokenReserves?:    bigint;
  totalSupply?:          bigint;
  graduated?:            boolean;
  priceEth?:             string;
  marketCapEth?:         string;
}) {
  const addr = params.address.toLowerCase();

  // Check if token already exists
  const [existing] = await db
    .select({ address: tokensTable.address })
    .from(tokensTable)
    .where(eq(tokensTable.address, addr));

  if (existing) {
    // Token exists — only update on-chain state fields, not UI metadata
    const updates: Record<string, unknown> = {};
    if (params.virtualTokenReserves !== undefined)
      updates.virtualTokenReserves = params.virtualTokenReserves.toString();
    if (params.virtualEthReserves !== undefined)
      updates.virtualEthReserves = params.virtualEthReserves.toString();
    if (params.realTokenReserves !== undefined)
      updates.realTokenReserves = params.realTokenReserves.toString();
    if (params.priceEth !== undefined)       updates.priceEth     = params.priceEth;
    if (params.marketCapEth !== undefined)   updates.marketCapEth = params.marketCapEth;
    if (params.graduated !== undefined)      updates.graduated    = params.graduated;

    if (Object.keys(updates).length > 0) {
      await db.update(tokensTable).set(updates).where(eq(tokensTable.address, addr));
    }
  } else {
    // New token — insert with defaults for fields we don't have on-chain
    const vtr = (params.virtualTokenReserves ?? 10n ** 27n).toString();
    const ver = (params.virtualEthReserves   ?? 3n * 10n ** 21n).toString();
    const rtr = (params.realTokenReserves    ?? 10n ** 27n).toString();
    const ts  = (params.totalSupply          ?? 10n ** 27n).toString();

    await db.insert(tokensTable).values({
      address:               addr,
      name:                  params.name,
      symbol:                params.symbol,
      creatorAddress:        params.creatorAddress.toLowerCase(),
      virtualTokenReserves:  vtr,
      virtualEthReserves:    ver,
      realTokenReserves:     rtr,
      totalSupply:           ts,
      graduated:             params.graduated ?? false,
      priceEth:              params.priceEth     ?? null,
      marketCapEth:          params.marketCapEth ?? null,
    }).onConflictDoNothing();

    status.tokensIndexed++;
    logger.info({ addr, name: params.name, symbol: params.symbol }, "Indexer: new token");
  }
}

/** Insert a trade from a chain Trade event (idempotent via txHash uniqueness). */
async function upsertTrade(params: {
  tokenAddress:  string;
  traderAddress: string;
  isBuy:         boolean;
  ethAmount:     bigint;
  tokenAmount:   bigint;
  priceEth:      string;
  txHash:        string;
  timestamp:     number; // unix seconds
}) {
  const addr = params.tokenAddress.toLowerCase();

  // Look up denormalized name/symbol
  const [token] = await db
    .select({ name: tokensTable.name, symbol: tokensTable.symbol })
    .from(tokensTable)
    .where(eq(tokensTable.address, addr));

  try {
    await db.insert(tradesTable).values({
      tokenAddress:  addr,
      tokenName:     token?.name   ?? null,
      tokenSymbol:   token?.symbol ?? null,
      traderAddress: params.traderAddress.toLowerCase(),
      isBuy:         params.isBuy,
      ethAmount:     weiToEth(params.ethAmount),
      tokenAmount:   ethers.formatUnits(params.tokenAmount, 18),
      priceEth:      params.priceEth,
      txHash:        params.txHash,
      timestamp:     new Date(params.timestamp * 1000),
    });

    // Update token aggregates atomically
    await db.update(tokensTable)
      .set({
        volumeEth:  sql`(COALESCE(${tokensTable.volumeEth}::numeric, 0) + ${Number(weiToEth(params.ethAmount))})::text`,
        tradeCount: sql`${tokensTable.tradeCount} + 1`,
        priceEth:   params.priceEth,
      })
      .where(eq(tokensTable.address, addr));

    status.tradesIndexed++;
    logger.info(
      { addr, isBuy: params.isBuy, ethAmount: weiToEth(params.ethAmount) },
      "Indexer: trade recorded"
    );
  } catch (err: unknown) {
    // Unique constraint on txHash — trade already indexed, skip silently
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("unique") && !msg.includes("duplicate")) {
      throw err;
    }
  }
}

// ─── Event processors ─────────────────────────────────────────────────────────

async function processTokenLaunched(log: ethers.Log) {
  const decoded = launcherIface.parseLog(log);
  if (!decoded) return;

  const [tokenAddress, creator, name, symbol] = decoded.args as unknown as [string, string, string, string];
  await upsertToken({ address: tokenAddress, name, symbol, creatorAddress: creator });
  status.eventsProcessed++;
}

async function processCreatePool(log: ethers.Log, provider: ethers.JsonRpcProvider) {
  const decoded = rocketFiIface.parseLog(log);
  if (!decoded) return;

  const [mint, user] = decoded.args as unknown as [string, string];

  // Try to fetch on-chain state for reserve initialisation
  try {
    const contract = new ethers.Contract(ROCKETFI_ADDR, ROCKETFI_ABI as unknown as string[], provider);
    const curve = await contract.getBondingCurve(mint) as {
      virtualTokenReserves: bigint;
      virtualEthReserves:   bigint;
      realTokenReserves:    bigint;
      tokenTotalSupply:     bigint;
      complete:             boolean;
    };

    const priceEth     = calcPriceEth(curve.virtualEthReserves, curve.virtualTokenReserves);
    const marketCapEth = calcMarketCapEth(
      curve.virtualEthReserves, curve.virtualTokenReserves, curve.tokenTotalSupply
    );

    await upsertToken({
      address:              mint,
      name:                 `Token ${mint.slice(0, 6)}`,
      symbol:               "???",
      creatorAddress:       user,
      virtualTokenReserves: curve.virtualTokenReserves,
      virtualEthReserves:   curve.virtualEthReserves,
      realTokenReserves:    curve.realTokenReserves,
      totalSupply:          curve.tokenTotalSupply,
      graduated:            curve.complete,
      priceEth,
      marketCapEth,
    });
  } catch {
    // Contract call failed — insert minimal record and let UI data fill it in
    await upsertToken({
      address:       mint,
      name:          `Token ${mint.slice(0, 6)}`,
      symbol:        "???",
      creatorAddress: user,
    });
  }

  status.eventsProcessed++;
}

async function processTrade(log: ethers.Log) {
  const decoded = rocketFiIface.parseLog(log);
  if (!decoded) return;

  const [
    mint, ethAmount, tokenAmount, isBuy, user, timestamp,
    virtualEthReserves, virtualTokenReserves,
  ] = decoded.args as unknown as [string, bigint, bigint, boolean, string, bigint, bigint, bigint];

  const priceEth = calcPriceEth(virtualEthReserves, virtualTokenReserves);

  // Ensure the token exists (it might have been created without TokenLauncher)
  const [existing] = await db
    .select({ address: tokensTable.address, totalSupply: tokensTable.totalSupply })
    .from(tokensTable)
    .where(eq(tokensTable.address, mint.toLowerCase()));

  if (existing) {
    // Update reserves and market cap
    const ts  = BigInt(existing.totalSupply ?? "1000000000000000000000000000");
    const mcp = calcMarketCapEth(virtualEthReserves, virtualTokenReserves, ts);

    await db.update(tokensTable)
      .set({
        virtualEthReserves:   virtualEthReserves.toString(),
        virtualTokenReserves: virtualTokenReserves.toString(),
        marketCapEth:         mcp,
      })
      .where(eq(tokensTable.address, mint.toLowerCase()));
  }

  await upsertTrade({
    tokenAddress:  mint,
    traderAddress: user,
    isBuy,
    ethAmount,
    tokenAmount,
    priceEth,
    txHash:    log.transactionHash,
    timestamp: Number(timestamp),
  });

  status.eventsProcessed++;
}

async function processComplete(log: ethers.Log) {
  const decoded = rocketFiIface.parseLog(log);
  if (!decoded) return;

  const [, mint] = decoded.args as unknown as [string, string, bigint];

  await db.update(tokensTable)
    .set({ graduated: true })
    .where(eq(tokensTable.address, mint.toLowerCase()));

  logger.info({ mint }, "Indexer: token graduated");
  status.eventsProcessed++;
}

// ─── Polling loop ─────────────────────────────────────────────────────────────

async function poll(provider: ethers.JsonRpcProvider) {
  try {
    const latestBlock = await provider.getBlockNumber();
    status.latestBlock = latestBlock;

    // First run: initialise from env var or (latest - 10 000)
    if (status.lastIndexedBlock === null) {
      status.lastIndexedBlock = START_BLOCK > 0
        ? START_BLOCK - 1
        : Math.max(0, latestBlock - 10_000);
      logger.info({ from: status.lastIndexedBlock + 1 }, "Indexer: starting from block");
    }

    if (status.lastIndexedBlock >= latestBlock) return; // nothing new

    // Collect addresses to filter (exclude empty strings)
    const addresses = [ROCKETFI_ADDR, LAUNCHER_ADDR].filter(Boolean);
    if (addresses.length === 0) return;

    // Process in chunks to avoid RPC range limits
    let from = status.lastIndexedBlock + 1;
    while (from <= latestBlock) {
      const to = Math.min(from + CHUNK_SIZE - 1, latestBlock);

      const logs = await provider.getLogs({
        fromBlock: from,
        toBlock:   to,
        address:   addresses,
      });

      // Sort by block + logIndex for correct state ordering
      logs.sort((a, b) =>
        a.blockNumber !== b.blockNumber
          ? a.blockNumber - b.blockNumber
          : a.index - b.index
      );

      for (const log of logs) {
        const addr  = log.address.toLowerCase();
        const topic = log.topics[0];

        try {
          if (addr === LAUNCHER_ADDR && topic === TOPIC_TOKEN_LAUNCHED) {
            await processTokenLaunched(log);
          } else if (addr === ROCKETFI_ADDR && topic === TOPIC_CREATE_POOL) {
            await processCreatePool(log, provider);
          } else if (addr === ROCKETFI_ADDR && topic === TOPIC_TRADE) {
            await processTrade(log);
          } else if (addr === ROCKETFI_ADDR && topic === TOPIC_COMPLETE) {
            await processComplete(log);
          }
        } catch (err: unknown) {
          status.errors++;
          status.lastError = err instanceof Error ? err.message : String(err);
          logger.error({ err, txHash: log.transactionHash }, "Indexer: failed to process log");
        }
      }

      status.lastIndexedBlock = to;
      from = to + 1;
    }
  } catch (err: unknown) {
    status.errors++;
    status.lastError = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "Indexer: poll error");
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setTimeout> | null = null;

/** Start the indexer. Safe to call multiple times — only starts once. */
export function startIndexer() {
  if (status.active) return;

  if (!RPC_URL) {
    logger.warn("Indexer: RPC_URL not set — onchain indexing disabled");
    return;
  }
  if (!ROCKETFI_ADDR) {
    logger.warn("Indexer: ROCKETFI_CONTRACT not set — onchain indexing disabled");
    return;
  }

  logger.info(
    { rpcUrl: RPC_URL, rocketFi: ROCKETFI_ADDR, launcher: LAUNCHER_ADDR || "(none)" },
    "Indexer: starting"
  );

  status.active    = true;
  status.startedAt = new Date().toISOString();

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const run = async () => {
    await poll(provider);
    if (status.active) {
      pollTimer = setTimeout(run, POLL_MS);
    }
  };

  // Kick off immediately, then repeat
  void run();
}

/** Gracefully stop the indexer. */
export function stopIndexer() {
  status.active = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  logger.info("Indexer: stopped");
}

/** Trigger an immediate sync (useful for manual testing). Returns number of new events. */
export async function syncNow(): Promise<{ eventsProcessed: number }> {
  if (!RPC_URL || !ROCKETFI_ADDR) {
    throw new Error("Indexer not configured — set RPC_URL and ROCKETFI_CONTRACT");
  }
  const before = status.eventsProcessed;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  await poll(provider);
  return { eventsProcessed: status.eventsProcessed - before };
}
