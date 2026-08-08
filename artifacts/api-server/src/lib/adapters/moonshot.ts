/**
 * Moonshot adapter — chain-native real-time indexer for moonshot.money on Solana.
 *
 * Data source: Solana RPC logsSubscribe for the Moonshot bonding-curve program.
 *
 * Program ID: MoonCVVNZFSYkqNXP6bxHLPL6QQXiMbkcrwhefkTnNSo
 *   Source: moonshot.money JS bundle, verified executable on-chain.
 *   Override via MOONSHOT_PROGRAM_ID env var if Moonshot upgrades the program.
 *
 * Why not DEXScreener polling?
 *   DEXScreener's search API returns tokens *named* "moonshot", not tokens launched
 *   on the Moonshot platform. The dexId=moonshot filter never matches any result.
 *
 * No minimum env vars required — uses the shared free public RPC pool by default.
 */

import { eq } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import { logger } from "../logger";
import { emitNewToken } from "../tradeEmitter";
import { SolanaRpcIndexer, type LogEvent } from "./solanaRpcBase";

// Moonshot bonding-curve program on Solana mainnet.
// Source: moonshot.money JS bundle (verified executable 2025-08-08).
// Set MOONSHOT_PROGRAM_ID env var to override if Moonshot upgrades.
const DEFAULT_PROGRAM_ID = "MoonCVVNZFSYkqNXP6bxHLPL6QQXiMbkcrwhefkTnNSo";
const PLATFORM           = "moonshot";
const CHAIN              = "solana";

// ── Moonshot metadata helper ────────────────────────────────────────────────────

interface MoonshotMeta {
  name?:        string;
  symbol?:      string;
  description?: string;
  icon?:        string;
}

/** Try to fetch token metadata from Moonshot's API */
async function fetchMoonshotMeta(mint: string): Promise<MoonshotMeta | null> {
  try {
    const res = await fetch(
      `https://api.moonshot.cc/token/v1/solana/${mint}`,
      { signal: AbortSignal.timeout(8_000), headers: { "User-Agent": "RocketFi/1.0" } }
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      name?: string;
      symbol?: string;
      description?: string;
      icon?: string;
    };
    return { name: body.name, symbol: body.symbol, description: body.description, icon: body.icon };
  } catch {
    return null;
  }
}

// ── Indexer ─────────────────────────────────────────────────────────────────────

class MoonshotIndexer extends SolanaRpcIndexer {
  constructor(programId: string) {
    super({ programId, adapterName: "moonshot" });
  }

  // Default shouldProcess from base: create-only — catches new token launches
  protected override async onEvent(event: LogEvent): Promise<void> {
    const { signature } = event;

    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    const mint    = this.extractNewMint(tx);
    const creator = this.extractSigner(tx);
    if (!mint) {
      this.log.debug({ signature }, "moonshot: could not extract mint — skipping");
      return;
    }

    // Try Moonshot's own metadata API first
    const meta     = await fetchMoonshotMeta(mint);
    const name     = meta?.name    ?? mint.slice(0, 8) + "…";
    const symbol   = meta?.symbol  ?? "???";
    const imageUrl = meta?.icon    ?? null;

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

    this.log.info({ mint, name, symbol }, "moonshot: new token ingested");

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
}

// ── Exported adapter entry point ───────────────────────────────────────────────

export async function startMoonshotAdapter(): Promise<void> {
  const programId = process.env["MOONSHOT_PROGRAM_ID"] ?? DEFAULT_PROGRAM_ID;

  logger.info(
    { adapter: "moonshot", programId },
    "moonshot: starting chain-native indexer — subscribing to program logs"
  );

  const indexer = new MoonshotIndexer(programId);
  indexer.start();
}
