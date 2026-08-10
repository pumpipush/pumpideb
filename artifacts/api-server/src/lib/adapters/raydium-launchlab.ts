/**
 * raydium-launchlab.ts — Raydium LaunchLab on-chain indexer.
 *
 * Indexes token creations and trades on the Raydium LaunchLab bonding curve.
 *
 * Strategy:
 *   1. logsSubscribe to LAUNCHLAB_PROGRAM
 *   2. Detect instruction type from log lines (createLaunchpad / buyToken / sellToken / migrate)
 *   3. getTransaction for all events — LaunchLab volume is low enough to afford this
 *   4. Extract data via base-class helpers + custom instruction decoder
 *
 * Market cap formula (bonding curve, pre-graduation):
 *   priceEth    = solLamports / tokenAmount / 1000        (SOL per token)
 *   marketCapEth = totalSupply × solLamports / tokenAmount  (in lamports, same convention as pump.fun)
 *
 * Virtual reserves are also tracked for historical accuracy, using a constant-product
 * estimate from the previous DB state — same approach as the pump.fun fallback path.
 *
 * On graduation: marks graduated = true. The token platform stays "raydium_launchlab"
 * (the enrichment / DexScreener layer handles CPMM pool data for graduated tokens).
 */

import { eq, sql } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { emitTrade, emitNewToken } from "../tradeEmitter";
import { logger as rootLogger } from "../logger";
import { fetchSafeUriMeta } from "../safeUriFetch";
import {
  SolanaRpcIndexer,
  detectInstructionType,
  type LogEvent,
  type RpcTx,
} from "./solanaRpcBase";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Raydium LaunchLab on-chain program (mainnet) */
const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const PLATFORM          = "raydium_launchlab";
const CHAIN             = "solana";

// ── Bonding curve constants ───────────────────────────────────────────────────
// LaunchLab tokens: 1 billion with 6 decimals = 1e15 base units (same as pump.fun)
const LL_TOTAL_SUPPLY = 1_000_000_000_000_000n;

// Initial virtual reserves (approximate — corrected on the first trade).
// LaunchLab uses the same constant-product AMM formula as pump.fun.
// 30 SOL initial virtual SOL is consistent with similar bonding-curve protocols.
const LL_INIT_VSOL_SOL       = "30";
const LL_INIT_VSOL_LAMPORTS  = 30_000_000_000n;   // 30 SOL in lamports
const LL_INIT_VTOK           = LL_TOTAL_SUPPLY;    // all tokens start in the curve

// Initial market cap in lamports: totalSupply × vSol / vTok = 30 SOL at genesis
const LL_INIT_MC_LAMPORTS =
  (LL_TOTAL_SUPPLY * LL_INIT_VSOL_LAMPORTS / LL_INIT_VTOK).toString();

// Initial price in SOL/token: vSol_lamports / vTok_baseUnits / 1000
const LL_INIT_PRICE_ETH =
  (Number(LL_INIT_VSOL_LAMPORTS) / Number(LL_INIT_VTOK) / 1000).toFixed(15);

// Skip these when looking for the token mint in balance deltas
const SKIP_MINTS = new Set([
  "So11111111111111111111111111111111111111112",   // WSOL
  "11111111111111111111111111111111",              // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token Program
]);

// ── Borsh / Base58 utilities ──────────────────────────────────────────────────
// Same as pump.fun — inlined to avoid a shared-utility module dependency.

const BS58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bs58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = BS58_ALPHA.indexOf(c);
    if (i < 0) throw new Error(`bad base58 char: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let leading = 0;
  for (const c of s) { if (c !== "1") break; leading++; }
  return new Uint8Array([...new Array<number>(leading).fill(0), ...bytes]);
}

function readBorshStr(buf: Uint8Array, off: number): [string, number] {
  if (off + 4 > buf.length) throw new RangeError("borsh underflow (length)");
  const len = new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, true);
  const end = off + 4 + len;
  if (end > buf.length) throw new RangeError("borsh underflow (string)");
  return [new TextDecoder().decode(buf.subarray(off + 4, end)), end];
}

// ── Indexer ───────────────────────────────────────────────────────────────────

class RaydiumLaunchLabIndexer extends SolanaRpcIndexer {
  constructor() {
    super({
      programId:   LAUNCHLAB_PROGRAM,
      adapterName: "raydium_launchlab",
      // 5-minute watchdog — LaunchLab has ~10× lower volume than pump.fun,
      // so we need a longer window before concluding the connection is dead.
      watchdogMs: 300_000,
    });
  }

  /**
   * Accept any event whose logs suggest a LaunchLab operation:
   *   createLaunchpad → caught by /Create/i
   *   buyToken        → caught by /Buy/i
   *   sellToken       → caught by /Sell/i
   *   migrate*        → explicit check
   * The base-class `detectInstructionType` handles the create/buy/sell detection
   * case-insensitively, so camelCase instruction names work without extra code.
   */
  protected override shouldProcess(logs: string[]): boolean {
    return logs.some((l) =>
      /Instruction:\s*(create|initialize|buy|sell|migrate)/i.test(l)
    );
  }

  protected override async onEvent(event: LogEvent): Promise<void> {
    const { logs } = event;

    // Migration instruction trumps any create/buy/sell in the same tx
    if (logs.some((l) => /Instruction:\s*migrate/i.test(l))) {
      await this.handleGraduation(event);
      return;
    }

    const instrType = detectInstructionType(logs);
    if (instrType === "create")                return this.handleCreate(event);
    if (instrType === "buy" || instrType === "sell") return this.handleTrade(event);
    // "initialize" without "create" = likely config/platform init — no-op
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  private async handleCreate(event: LogEvent): Promise<void> {
    const { signature } = event;

    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    // The newly-minted token appears in postTokenBalances but not preTokenBalances
    const mint = this.extractNewMint(tx);
    if (!mint || SKIP_MINTS.has(mint)) {
      this.log.debug({ signature }, "raydium_launchlab: create — no new mint, skip");
      return;
    }

    const creatorAddress = this.extractSigner(tx);

    // Try to decode name / symbol / uri from the createLaunchpad instruction data.
    // Expected Borsh layout: [8 disc][32 mintA][name str][symbol str][uri str]…
    const params = this._decodeCreateParams(tx);
    const name   = params?.name   ?? mint.slice(0, 8) + "…";
    const symbol = params?.symbol ?? "???";
    const uri    = params?.uri    ?? null;

    // Insert the token row with bonding-curve genesis state.
    // metadataUri is stored so the enrichment loop can fetch image/description
    // from the on-chain URI when Raydium's /mint/ids registry hasn't indexed it yet.
    await db.insert(tokensTable).values({
      address:              mint,
      name,
      symbol,
      description:          null,
      imageUrl:             null,
      creatorAddress,
      totalSupply:          LL_TOTAL_SUPPLY.toString(),
      virtualTokenReserves: LL_INIT_VTOK.toString(),
      virtualEthReserves:   LL_INIT_VSOL_SOL,
      marketCapEth:         LL_INIT_MC_LAMPORTS,
      priceEth:             LL_INIT_PRICE_ETH,
      platform:             PLATFORM,
      chain:                CHAIN,
      metadataUri:          uri ?? null,
    }).onConflictDoNothing();

    this.log.info({ mint, name, symbol, marketCapEth: LL_INIT_MC_LAMPORTS },
      "raydium_launchlab: new token ingested");

    // Broadcast to live feed — wait up to 3 s for the image, then broadcast anyway
    const broadcast = (imageUrl: string | null) => {
      emitNewToken({
        type: "newToken",
        token: {
          address:      mint,
          name,
          symbol,
          imageUrl,
          priceEth:     LL_INIT_PRICE_ETH,
          marketCapEth: LL_INIT_MC_LAMPORTS,
          platform:     PLATFORM,
          chain:        CHAIN,
          createdAt:    new Date().toISOString(),
        },
      });
    };

    if (uri) {
      let done = false;
      const fallback = setTimeout(() => {
        if (!done) { done = true; broadcast(null); }
      }, 3_000);

      fetchSafeUriMeta(uri)
        .then(async (meta) => {
          clearTimeout(fallback);
          if (meta) {
            const dbUpdate: Record<string, string | null> = {};
            if (meta.imageUrl)    dbUpdate["imageUrl"]    = meta.imageUrl;
            if (meta.description) dbUpdate["description"] = meta.description;
            if (meta.twitterUrl)  dbUpdate["twitterUrl"]  = meta.twitterUrl;
            if (meta.telegramUrl) dbUpdate["telegramUrl"] = meta.telegramUrl;
            if (meta.websiteUrl)  dbUpdate["websiteUrl"]  = meta.websiteUrl;
            if (Object.keys(dbUpdate).length > 0) {
              await db.update(tokensTable).set(dbUpdate).where(eq(tokensTable.address, mint));
              this.log.debug({ mint, fields: Object.keys(dbUpdate) }, "raydium_launchlab: metadata fetched from URI");
            }
          }
          const imageUrl = meta?.imageUrl ?? null;
          if (!done) { done = true; broadcast(imageUrl); }
          else if (imageUrl) { broadcast(imageUrl); }
        })
        .catch(() => {
          clearTimeout(fallback);
          if (!done) { done = true; broadcast(null); }
        });
    } else {
      broadcast(null);
    }
  }

  // ── Trade ───────────────────────────────────────────────────────────────────

  private async handleTrade(event: LogEvent): Promise<void> {
    const { signature } = event;

    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    // parseSwap uses per-account token balance deltas to determine:
    //   mint, isBuy, solLamports (absolute), tokenAmount, traderAddress
    const swap = this.parseSwap(tx);
    if (!swap) return;

    const { mint, isBuy, solLamports, tokenAmount, traderAddress } = swap;

    // price_eth = SOL per token (same convention as pump.fun)
    //   lamports / base_units / 1000  →  SOL / token
    const priceEth = tokenAmount !== "0" && solLamports !== "0"
      ? (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15)
      : null;

    // ── Auto-create token if creation event was missed ────────────────────
    // If this mint is unknown (missed the createLaunchpad event due to a network
    // glitch or reconnect), insert a placeholder so the trade has a parent token.
    // The enrichment loop will fill in name / symbol / image within 30 s.
    const existing = await db
      .select({ id: tokensTable.id })
      .from(tokensTable)
      .where(eq(tokensTable.address, mint))
      .limit(1);

    if (existing.length === 0) {
      this.log.warn({ mint }, "raydium_launchlab: trade arrived before creation event — auto-creating placeholder token");
      await db.insert(tokensTable).values({
        address:              mint,
        name:                 mint.slice(0, 8) + "…",
        symbol:               "???",
        description:          null,
        imageUrl:             null,
        creatorAddress:       traderAddress,
        totalSupply:          LL_TOTAL_SUPPLY.toString(),
        virtualTokenReserves: LL_INIT_VTOK.toString(),
        virtualEthReserves:   LL_INIT_VSOL_SOL,
        marketCapEth:         LL_INIT_MC_LAMPORTS,
        priceEth:             LL_INIT_PRICE_ETH,
        platform:             PLATFORM,
        chain:                CHAIN,
      }).onConflictDoNothing();
    }

    // ── Insert trade ───────────────────────────────────────────────────────
    const [trade] = await db.insert(tradesTable).values({
      tokenAddress:  mint,
      tokenName:     null,
      tokenSymbol:   null,
      traderAddress,
      isBuy,
      ethAmount:     solLamports,
      tokenAmount,
      priceEth,
      txHash:        signature,
      platform:      PLATFORM,
      timestamp:     new Date(),
    }).onConflictDoNothing().returning();

    if (!trade) return; // duplicate tx — already processed

    // ── Update bonding curve state + aggregate stats ───────────────────────
    // Market cap from current trade price — no need to track virtual reserves precisely.
    //   MC = totalSupply × (solLamports / tokenAmount)  in lamports
    let updMCStr:   string | undefined;
    let updVSolStr: string | undefined;
    let updVTokStr: string | undefined;

    if (solLamports !== "0" && tokenAmount !== "0") {
      const solLam = BigInt(solLamports);
      const tokAmt = BigInt(tokenAmount);

      // Direct market cap from current trade price
      updMCStr = (LL_TOTAL_SUPPLY * solLam / tokAmt).toString();

      // Constant-product virtual reserve update (same as pump.fun fallback path)
      try {
        const [cur] = await db
          .select({
            virtualEthReserves:   tokensTable.virtualEthReserves,
            virtualTokenReserves: tokensTable.virtualTokenReserves,
          })
          .from(tokensTable)
          .where(eq(tokensTable.address, mint))
          .limit(1);

        const vSolSol    = parseFloat(cur?.virtualEthReserves   ?? LL_INIT_VSOL_SOL);
        const vTokAtom   = BigInt(cur?.virtualTokenReserves ?? LL_INIT_VTOK.toString());
        const oldVSolLam = BigInt(Math.round(vSolSol * 1e9));
        const k          = oldVSolLam * vTokAtom;

        const newVSolLam = isBuy
          ? oldVSolLam + solLam
          : oldVSolLam > solLam ? oldVSolLam - solLam : oldVSolLam;

        if (newVSolLam > 0n) {
          const newVTok = k / newVSolLam;
          updVSolStr = (Number(newVSolLam) / 1e9).toFixed(6).replace(/\.?0+$/, "");
          updVTokStr = newVTok.toString();
        }
      } catch { /* keep existing reserves on error */ }
    }

    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
      ...(priceEth    !== null      ? { priceEth }                         : {}),
      ...(updMCStr    !== undefined ? { marketCapEth: updMCStr }           : {}),
      ...(updVSolStr  !== undefined ? { virtualEthReserves:  updVSolStr }  : {}),
      ...(updVTokStr  !== undefined ? { virtualTokenReserves: updVTokStr } : {}),
    }).where(eq(tokensTable.address, mint));

    this.log.debug({ mint, isBuy, sol: solLamports }, "raydium_launchlab: trade ingested");

    // ── SSE broadcast ─────────────────────────────────────────────────────
    const [tokenRow] = await db
      .select({
        name:                 tokensTable.name,
        symbol:               tokensTable.symbol,
        marketCapEth:         tokensTable.marketCapEth,
        volumeEth:            tokensTable.volumeEth,
        virtualEthReserves:   tokensTable.virtualEthReserves,
        virtualTokenReserves: tokensTable.virtualTokenReserves,
        tradeCount:           tokensTable.tradeCount,
      })
      .from(tokensTable)
      .where(eq(tokensTable.address, mint))
      .limit(1);

    emitTrade({
      type: "trade",
      trade: {
        id:            trade.id,
        tokenAddress:  trade.tokenAddress,
        traderAddress: trade.traderAddress,
        isBuy:         trade.isBuy,
        ethAmount:     trade.ethAmount,
        tokenAmount:   trade.tokenAmount,
        priceEth:      trade.priceEth,
        txHash:        trade.txHash,
        platform:      PLATFORM,
        timestamp:     trade.timestamp.toISOString(),
      },
      token: {
        address:              mint,
        name:                 tokenRow?.name        ?? null,
        symbol:               tokenRow?.symbol      ?? null,
        priceEth,
        marketCapEth:         tokenRow?.marketCapEth ?? null,
        volumeEth:            tokenRow?.volumeEth    ?? solLamports,
        virtualEthReserves:   tokenRow?.virtualEthReserves   ?? LL_INIT_VSOL_SOL,
        virtualTokenReserves: tokenRow?.virtualTokenReserves ?? LL_INIT_VTOK.toString(),
        tradeCount:           Number(tokenRow?.tradeCount ?? 0),
        platform:             PLATFORM,
        chain:                CHAIN,
      },
    });
  }

  // ── Graduation ──────────────────────────────────────────────────────────────

  private async handleGraduation(event: LogEvent): Promise<void> {
    const tx = await this.getTransaction(event.signature);
    if (!tx || tx.meta?.err) return;

    // On graduation, the mint is unchanged — extract from existing token balances.
    const mint = this._extractMintFromBalances(tx);
    if (!mint) {
      this.log.debug({ sig: event.signature }, "raydium_launchlab: graduation — no mint, skip");
      return;
    }

    const graduatedAt = tx.blockTime ? new Date(tx.blockTime * 1000) : new Date();

    await db.update(tokensTable)
      .set({ graduated: true, graduatedAt })
      .where(eq(tokensTable.address, mint));

    this.log.info({ mint }, "raydium_launchlab: token graduated to CPMM pool");
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Try to decode name / symbol / uri from a LaunchLab `createLaunchpad` instruction.
   *
   * Expected Anchor/Borsh layout:
   *   [8 disc] [32 mintA] [name: borsh string] [symbol: borsh string] [uri: borsh string] …
   *
   * We probe multiple offsets (40, 8, 72) to be resilient against IDL param ordering
   * that differs from the TypeScript call-site ordering.
   */
  private _decodeCreateParams(tx: RpcTx): { name: string; symbol: string; uri: string } | null {
    const keys   = tx.transaction?.message?.accountKeys   ?? [];
    const instrs = tx.transaction?.message?.instructions  ?? [];

    // Find the instruction that calls the LaunchLab program
    const progIdx = keys.findIndex(
      (k) => (typeof k === "string" ? k : (k as { pubkey?: string }).pubkey) === LAUNCHLAB_PROGRAM,
    );
    if (progIdx < 0) return null;

    const instr = instrs.find((i) => i.programIdIndex === progIdx);
    if (!instr?.data) return null;

    try {
      const raw = bs58Decode(instr.data);
      if (raw.length < 12) return null; // too short to contain any strings

      // Probe multiple starting offsets in descending likelihood order:
      //   40 = disc(8) + mintA(32)   — most likely: mintA is first IDL param
      //    8 = disc(8)               — fallback: strings come directly after discriminator
      //   72 = disc(8) + two keys(64) — fallback: two pubkeys before strings
      const PROBE_OFFSETS = [40, 8, 72];

      for (const startOff of PROBE_OFFSETS) {
        if (startOff + 8 > raw.length) continue;
        try {
          let off = startOff;
          const [name,   off1] = readBorshStr(raw, off);  off = off1;
          const [symbol, off2] = readBorshStr(raw, off);  off = off2;
          const [uri]          = readBorshStr(raw, off);

          // Sanity-check: name and symbol must be non-empty and not binary garbage.
          // We allow full Unicode (emoji, CJK, etc.) — LaunchLab token names frequently
          // use non-ASCII characters. Only reject control characters, null bytes, and the
          // Unicode replacement character U+FFFD (produced when TextDecoder encounters
          // invalid UTF-8 sequences, indicating a bad Borsh offset decode).
          const n = name.trim();
          const s = symbol.trim();
          if (!n || !s) continue;
          if (n.length > 64 || s.length > 16) continue;
          if (/[\x00-\x08\x0B\x0E-\x1F\x7F\uFFFD]/.test(n) ||
              /[\x00-\x08\x0B\x0E-\x1F\x7F\uFFFD]/.test(s)) continue;

          return { name: n, symbol: s, uri: uri.trim() };
        } catch { continue; }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract the token mint from a transaction's existing token balances.
   * Used for graduation events where the mint does NOT appear as "new" in post-balances.
   */
  private _extractMintFromBalances(tx: RpcTx): string | null {
    const all = [
      ...(tx.meta?.preTokenBalances  ?? []),
      ...(tx.meta?.postTokenBalances ?? []),
    ];
    return all.find((b) => !SKIP_MINTS.has(b.mint))?.mint ?? null;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function startRaydiumLaunchLabAdapter(): Promise<void> {
  const indexer = new RaydiumLaunchLabIndexer();
  indexer.start();
}
