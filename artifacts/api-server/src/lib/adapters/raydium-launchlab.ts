/**
 * Raydium LaunchLab adapter — chain-native real-time indexer.
 *
 * Data source: wss://solana-rpc.publicnode.com (PublicNode free RPC)
 *
 * Optional env var:
 *   RAYDIUM_LAUNCHLAB_PROGRAM_ID — Raydium LaunchLab program address.
 *   How to find it: Go to raydium.io/launchlab, inspect a token launch transaction
 *   on Solscan, and note the main program invoked (not system/token programs).
 *   Falls back to: LanMV9sAd7wArD4vJFi88ioTMQ8viaCSPY9v9oMHDT
 *
 * Token creation events are indexed. Trade indexing is out of scope for this adapter.
 */

import { db, tokensTable } from "@workspace/db";
import { logger } from "../logger";
import { emitNewToken } from "../tradeEmitter";
import { SolanaRpcIndexer, type LogEvent, type RpcTx } from "./solanaRpcBase";

// Default program ID — override via env var if Raydium migrates the program
const DEFAULT_PROGRAM_ID = "LanMV9sAd7wArD4vJFi88ioTMQ8viaCSPY9v9oMHDT";
const PLATFORM           = "raydium_launchlab";
const CHAIN              = "solana";

// ── Raydium metadata helper ────────────────────────────────────────────────────

interface RaydiumTokenMeta {
  name?:        string;
  symbol?:      string;
  description?: string;
  image?:       string;
}

/** Try to fetch Raydium token metadata from their API */
async function fetchRaydiumMeta(mint: string): Promise<RaydiumTokenMeta | null> {
  try {
    const res = await fetch(
      `https://api-v3.raydium.io/mint/ids?mints=${mint}`,
      { signal: AbortSignal.timeout(8_000), headers: { "User-Agent": "RocketFi/1.0" } }
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: Array<{ name?: string; symbol?: string; logoURI?: string }>;
    };
    const item = body.data?.[0];
    if (!item) return null;
    return { name: item.name, symbol: item.symbol, image: item.logoURI };
  } catch {
    return null;
  }
}

// ── Indexer ────────────────────────────────────────────────────────────────────

class RaydiumLaunchLabIndexer extends SolanaRpcIndexer {
  constructor(programId: string) {
    super({ programId, adapterName: "raydium_launchlab" });
  }

  // Default shouldProcess from base: create-only
  protected override async onEvent(event: LogEvent): Promise<void> {
    const { signature } = event;

    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    // Prefer the postTokenBalances diff for mint extraction (more reliable across programs)
    const mint    = this.extractNewMint(tx) ?? this.tryAccountKey1(tx);
    const creator = this.extractSigner(tx);

    if (!mint) {
      this.log.debug({ signature }, "raydium_launchlab: could not extract mint — skipping");
      return;
    }

    // Try to get metadata from Raydium API
    const meta     = await fetchRaydiumMeta(mint);
    const name     = meta?.name  ?? mint.slice(0, 8) + "…";
    const symbol   = meta?.symbol ?? "???";
    const imageUrl = meta?.image  ?? null;

    await db.insert(tokensTable).values({
      address:              mint,
      name,
      symbol,
      description:          meta?.description ?? null,
      imageUrl,
      creatorAddress:       creator,
      totalSupply:          "1000000000",
      virtualTokenReserves: "1000000000",
      virtualEthReserves:   "0",
      priceEth:             null,
      marketCapEth:         null,
      platform:             PLATFORM,
      chain:                CHAIN,
    }).onConflictDoNothing();

    this.log.info({ mint, name, symbol }, "raydium_launchlab: new token ingested");

    emitNewToken({
      type: "newToken",
      token: {
        address:      mint,
        name,
        symbol,
        imageUrl,
        priceEth:     null,
        marketCapEth: null,
        platform:     PLATFORM,
        chain:        CHAIN,
        createdAt:    tx.blockTime
          ? new Date(tx.blockTime * 1000).toISOString()
          : new Date().toISOString(),
      },
    });
  }

  /** accountKeys[1] fallback — only used when postTokenBalances diff is empty */
  private tryAccountKey1(tx: RpcTx): string | null {
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const k1   = keys[1];
    if (!k1) return null;
    return typeof k1 === "string" ? k1 : (k1.pubkey ?? null);
  }
}

// ── Exported entry point ───────────────────────────────────────────────────────

export async function startRaydiumLaunchLabAdapter(): Promise<void> {
  const programId = process.env["RAYDIUM_LAUNCHLAB_PROGRAM_ID"] ?? DEFAULT_PROGRAM_ID;

  if (!process.env["RAYDIUM_LAUNCHLAB_PROGRAM_ID"]) {
    logger.info(
      { adapter: "raydium_launchlab", programId },
      "raydium_launchlab: RAYDIUM_LAUNCHLAB_PROGRAM_ID not set — using default. " +
      "Verify by checking a raydium.io/launchlab tx on Solscan and set the env var if different."
    );
  }

  const indexer = new RaydiumLaunchLabIndexer(programId);
  indexer.start();
}
