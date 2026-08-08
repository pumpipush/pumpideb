/**
 * Pump.fun adapter — chain-native real-time indexer.
 *
 * Data source: wss://solana-rpc.publicnode.com (PublicNode free RPC)
 * Program:     6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *
 * Indexes:
 *   - Token creation (CreateV2): extracts mint, fetches pump.fun API for metadata
 *   - Swaps (Buy / Sell): persists trade to DB, updates token stats, emits SSE
 *
 * No env vars required — uses PublicNode free RPC.
 */

import { eq, sql } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { emitTrade, emitNewToken } from "../tradeEmitter";
import {
  SolanaRpcIndexer,
  detectInstructionType,
  type LogEvent,
  type RpcTx,
} from "./solanaRpcBase";

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PLATFORM     = "pump_fun";
const CHAIN        = "solana";

// ── Pump.fun bonding curve constants (fixed by the protocol) ──────────────────
// virtualSolReserves is stored in SOL units (the UI uses it to compute progress:
//   realSol = virtualSol - 30,  graduation at +85 real SOL → 100%).
// virtualTokenReserves is stored in raw atomic units (token × 10^6 decimals).
// marketCapEth (a slight misnomer — it's lamports) = totalSupply × vSol_lamports / vTok.
const PUMP_INIT_VSOL_SOL      = "30";                      // 30 virtual SOL at launch
const PUMP_INIT_VSOL_LAMPORTS = 30_000_000_000n;           // same in lamports (BigInt)
const PUMP_INIT_VTOK          = 1_073_000_191_045_000n;    // virtual token reserves at launch
const PUMP_TOTAL_SUPPLY       = 1_000_000_000_000_000n;    // 1B tokens × 10^6 decimals

// Initial MC in lamports: totalSupply × virtualSolLamports / virtualTokenReserves ≈ 28 SOL
const PUMP_INIT_MC_LAMPORTS   =
  (PUMP_TOTAL_SUPPLY * PUMP_INIT_VSOL_LAMPORTS / PUMP_INIT_VTOK).toString();
// Initial price in lamports per token atomic unit
const PUMP_INIT_PRICE_ETH     =
  (Number(PUMP_INIT_VSOL_LAMPORTS) / Number(PUMP_INIT_VTOK)).toFixed(12);

// ── On-chain instruction decoder ───────────────────────────────────────────────
// pump.fun CREATE instruction is an Anchor instruction whose data is:
//   8 bytes  – Anchor discriminator (sha256("global:create")[0..8])
//   borsh    – name   (u32 length + utf8 bytes)
//   borsh    – symbol (u32 length + utf8 bytes)
//   borsh    – uri    (u32 length + utf8 bytes)
//   ...      – more fields (ignored)
//
// Decoding this directly from the transaction avoids any external API call,
// which means metadata is available even when pump.fun's CDN blocks us.

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
  return new Uint8Array([...new Array(leading).fill(0), ...bytes]);
}

/** Read one borsh string (u32le length + utf8 bytes) from `buf` at `off`. */
function readBorshStr(buf: Uint8Array, off: number): [string, number] {
  if (off + 4 > buf.length) throw new RangeError("borsh underflow reading length");
  const len = new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, true);
  const end = off + 4 + len;
  if (end > buf.length) throw new RangeError("borsh underflow reading string");
  return [new TextDecoder().decode(buf.subarray(off + 4, end)), end];
}

/** Decode pump.fun CREATE params directly from the transaction instruction data. */
function decodePumpCreate(tx: RpcTx): { name: string; symbol: string; uri: string } | null {
  const keys   = tx.transaction?.message?.accountKeys   ?? [];
  const instrs = tx.transaction?.message?.instructions  ?? [];

  // Find pump.fun program position in account keys
  const progIdx = keys.findIndex(
    (k) => (typeof k === "string" ? k : k.pubkey) === PUMP_PROGRAM,
  );
  if (progIdx < 0) return null;

  // Find the top-level instruction from the pump.fun program
  const instr = instrs.find((i) => i.programIdIndex === progIdx);
  if (!instr?.data) return null;

  try {
    const raw = bs58Decode(instr.data);
    if (raw.length < 9) return null; // discriminator (8) + at least 1 byte
    let off = 8; // skip 8-byte Anchor discriminator
    const [name,   off1] = readBorshStr(raw, off);
    const [symbol, off2] = readBorshStr(raw, off1);
    const [uri]          = readBorshStr(raw, off2);
    if (!name.trim() || !symbol.trim()) return null;
    return { name: name.trim(), symbol: symbol.trim(), uri: uri.trim() };
  } catch {
    return null; // malformed data — not a pump.fun create instruction
  }
}

/** Fetch token image by downloading the metadata JSON at a URI (IPFS / CDN). */
async function fetchImageFromUri(uri: string): Promise<string | null> {
  if (!uri) return null;
  try {
    const res = await fetch(uri, {
      signal:  AbortSignal.timeout(10_000),
      headers: { "User-Agent": "RocketFi/1.0" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { image?: string };
    return json.image?.trim() || null;
  } catch {
    return null;
  }
}

// ── Indexer ────────────────────────────────────────────────────────────────────

class PumpFunChainIndexer extends SolanaRpcIndexer {
  constructor() {
    super({ programId: PUMP_PROGRAM, adapterName: "pump_fun" });
  }

  /** Process create, buy, and sell instructions */
  protected override shouldProcess(logs: string[]): boolean {
    const t = detectInstructionType(logs);
    return t === "create" || t === "buy" || t === "sell";
  }

  protected override async onEvent(event: LogEvent): Promise<void> {
    const instrType = detectInstructionType(event.logs);

    if (instrType === "create") {
      await this.handleCreate(event);
    } else if (instrType === "buy" || instrType === "sell") {
      await this.handleTrade(event);
    }
  }

  // ── Creation ───────────────────────────────────────────────────────────────

  private async handleCreate(event: LogEvent): Promise<void> {
    const { signature } = event;

    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    const mint    = this.extractPumpMint(tx);
    const creator = this.extractSigner(tx);
    if (!mint) {
      this.log.debug({ signature }, "pump_fun: could not extract mint — skipping create");
      return;
    }

    // Decode name/symbol/uri directly from on-chain instruction data.
    // This replaces the pump.fun REST API call, which is rate-limited / CDN-blocked
    // from hosted environments (returns HTTP 530). All data is sourced on-chain.
    const params = decodePumpCreate(tx);
    const name   = params?.name   ?? mint.slice(0, 8) + "…";
    const symbol = params?.symbol ?? "???";
    const uri    = params?.uri    ?? null;

    await db.insert(tokensTable).values({
      address:              mint,
      name,
      symbol,
      description:          null,
      imageUrl:             null, // filled async once the metadata URI is fetched
      creatorAddress:       creator,
      totalSupply:          PUMP_TOTAL_SUPPLY.toString(),
      virtualTokenReserves: PUMP_INIT_VTOK.toString(),
      virtualEthReserves:   PUMP_INIT_VSOL_SOL,   // stored in SOL (UI uses this for progress bar)
      marketCapEth:         PUMP_INIT_MC_LAMPORTS, // ≈ 28 SOL at launch
      priceEth:             PUMP_INIT_PRICE_ETH,
      platform:             PLATFORM,
      chain:                CHAIN,
    }).onConflictDoNothing();

    this.log.info({ mint, name, symbol, marketCapEth: PUMP_INIT_MC_LAMPORTS }, "pump_fun: new token ingested (chain-native)");

    emitNewToken({
      type: "newToken",
      token: {
        address:      mint,
        name,
        symbol,
        imageUrl:     null,
        priceEth:     PUMP_INIT_PRICE_ETH,
        marketCapEth: PUMP_INIT_MC_LAMPORTS,
        platform:     PLATFORM,
        chain:        CHAIN,
        createdAt:    tx.blockTime
          ? new Date(tx.blockTime * 1000).toISOString()
          : new Date().toISOString(),
      },
    });

    // Fire-and-forget: fetch image from metadata URI (IPFS / pump.fun CDN).
    // Updates the DB row when the image arrives; the enrichment loop also retries
    // missing images independently.
    if (uri) {
      fetchImageFromUri(uri)
        .then(async (imageUrl) => {
          if (!imageUrl) return;
          await db.update(tokensTable).set({ imageUrl }).where(eq(tokensTable.address, mint));
          this.log.debug({ mint }, "pump_fun: image fetched from URI");
        })
        .catch(() => {/* enrichment loop retries */});
    }
  }

  // ── Trade (buy / sell) ────────────────────────────────────────────────────

  private async handleTrade(event: LogEvent): Promise<void> {
    const { signature } = event;

    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    const swap = this.parseSwap(tx);
    if (!swap) return;

    const { mint, isBuy, solLamports, tokenAmount, traderAddress } = swap;

    const priceEth = tokenAmount !== "0"
      ? (Number(solLamports) / Number(tokenAmount)).toFixed(12)
      : null;

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

    if (!trade) return; // duplicate tx

    // Read current virtual reserves to advance the bonding curve
    const [current] = await db
      .select({
        virtualEthReserves:   tokensTable.virtualEthReserves,
        virtualTokenReserves: tokensTable.virtualTokenReserves,
      })
      .from(tokensTable)
      .where(eq(tokensTable.address, mint))
      .limit(1);

    // Constant-product formula: vSol_lamports × vTok = k (invariant)
    // vSol is stored in SOL units (float string), vTok in atomic units.
    let updVSolStr: string | undefined;
    let updVTokStr: string | undefined;
    let updMCStr:   string | undefined;

    try {
      const vSolSol      = parseFloat(current?.virtualEthReserves ?? PUMP_INIT_VSOL_SOL);
      const vTokAtom     = BigInt(current?.virtualTokenReserves ?? PUMP_INIT_VTOK.toString());
      const oldVSolLam   = BigInt(Math.round(vSolSol * 1e9));
      const tradeLam     = BigInt(solLamports);
      const k            = oldVSolLam * vTokAtom;   // constant product

      const newVSolLam   = isBuy
        ? oldVSolLam + tradeLam
        : oldVSolLam > tradeLam ? oldVSolLam - tradeLam : oldVSolLam;

      if (newVSolLam > 0n) {
        const newVTok  = k / newVSolLam;
        updVSolStr     = (Number(newVSolLam) / 1e9).toFixed(6).replace(/\.?0+$/, "");
        updVTokStr     = newVTok.toString();
        // MC_lamports = totalSupply × newVSol_lamports / newVTok
        if (newVTok > 0n)
          updMCStr = (PUMP_TOTAL_SUPPLY * newVSolLam / newVTok).toString();
      }
    } catch { /* keep existing reserves on parse error */ }

    // Update token aggregate stats + bonding curve state
    // Only overwrite priceEth when we have a real value — never erase the last good price with null.
    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
      ...(priceEth !== null ? { priceEth } : {}),
      ...(updVSolStr !== undefined ? { virtualEthReserves:   updVSolStr } : {}),
      ...(updVTokStr !== undefined ? { virtualTokenReserves: updVTokStr } : {}),
      ...(updMCStr   !== undefined ? { marketCapEth:         updMCStr   } : {}),
    }).where(eq(tokensTable.address, mint));

    this.log.debug({ mint, isBuy, sol: solLamports }, "pump_fun: trade ingested");

    // Fetch latest token state for SSE payload
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
        virtualEthReserves:   tokenRow?.virtualEthReserves   ?? "0",
        virtualTokenReserves: tokenRow?.virtualTokenReserves ?? "0",
        tradeCount:           Number(tokenRow?.tradeCount ?? 0),
        platform:             PLATFORM,
        chain:                CHAIN,
      },
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * pump.fun mint is reliably at accountKeys[1] (ends in "pump").
   * Falls back to postTokenBalances diff for safety.
   */
  private extractPumpMint(tx: RpcTx): string | null {
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const k1   = keys[1];
    if (k1) {
      const addr = typeof k1 === "string" ? k1 : k1.pubkey;
      if (addr?.endsWith("pump")) return addr;
    }
    return this.extractNewMint(tx);
  }
}

// ── Exported entry point ───────────────────────────────────────────────────────

export async function startPumpFunAdapter(): Promise<void> {
  const indexer = new PumpFunChainIndexer();
  indexer.start();
}
