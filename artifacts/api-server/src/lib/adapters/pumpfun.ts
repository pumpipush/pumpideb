/**
 * Pump.fun adapter — chain-native real-time indexer.
 *
 * Data source: wss://solana-rpc.publicnode.com (PublicNode free RPC)
 * Program:     6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *
 * Indexes:
 *   - Token creation (CreateV2): extracts mint from Anchor CreateEvent log
 *   - Swaps (Buy / Sell): extracts amounts from Anchor TradeEvent log
 *
 * PRIMARY PATH: Parse "Program data: <base64>" Anchor events emitted by the
 * pump.fun program into every transaction log. This avoids getTransaction
 * entirely — no RPC rate-limiting, zero additional HTTP calls per trade.
 *
 * FALLBACK PATH: If log parsing fails (e.g. different instruction structure),
 * falls back to getTransaction + parseSwap / decodePumpCreate.
 *
 * No env vars required — uses PublicNode free WebSocket RPC.
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
const PUMP_INIT_VSOL_SOL      = "30";
const PUMP_INIT_VSOL_LAMPORTS = 30_000_000_000n;
const PUMP_INIT_VTOK          = 1_073_000_191_045_000n;
const PUMP_TOTAL_SUPPLY       = 1_000_000_000_000_000n;

const PUMP_INIT_MC_LAMPORTS =
  (PUMP_TOTAL_SUPPLY * PUMP_INIT_VSOL_LAMPORTS / PUMP_INIT_VTOK).toString();
const PUMP_INIT_PRICE_ETH =
  (Number(PUMP_INIT_VSOL_LAMPORTS) / Number(PUMP_INIT_VTOK)).toFixed(12);

// ── Anchor event discriminators ────────────────────────────────────────────────
// Precomputed: sha256("event:<EventName>")[0..8] as Buffer
// TradeEvent:  bddb7fd34ee661ee
// CreateEvent: 1b72a94ddeeb6376
const TRADE_EVENT_DISC  = Buffer.from("bddb7fd34ee661ee", "hex");
const CREATE_EVENT_DISC = Buffer.from("1b72a94ddeeb6376", "hex");

// ── Base58 helpers ─────────────────────────────────────────────────────────────
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

function bs58Encode(bytes: Buffer | Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  const chars: string[] = [];
  while (n > 0n) { chars.unshift(BS58_ALPHA[Number(n % 58n)]); n /= 58n; }
  let leading = 0;
  for (const b of bytes) { if (b !== 0) break; leading++; }
  return "1".repeat(leading) + chars.join("");
}

// ── Borsh string reader ────────────────────────────────────────────────────────
/** Read one borsh string (u32le length + utf8 bytes) from `buf` at `off`. */
function readBorshStr(buf: Uint8Array, off: number): [string, number] {
  if (off + 4 > buf.length) throw new RangeError("borsh underflow reading length");
  const len = new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, true);
  const end = off + 4 + len;
  if (end > buf.length) throw new RangeError("borsh underflow reading string");
  return [new TextDecoder().decode(buf.subarray(off + 4, end)), end];
}

// ── Anchor event log parsers ───────────────────────────────────────────────────

/**
 * Parse pump.fun TradeEvent from Anchor "Program data:" log lines.
 *
 * TradeEvent layout (borsh):
 *   discriminator (8)  mint (32)  sol_amount (8)  token_amount (8)
 *   is_buy (1)  user (32)  timestamp (8)  virtual_sol_reserves (8)
 *   virtual_token_reserves (8)
 *
 * Total: 8+32+8+8+1+32+8+8+8 = 113 bytes
 */
function parseTradeEventFromLogs(logs: string[]): {
  mint:                 string;
  solLamports:          string;
  tokenAmount:          string;
  isBuy:                boolean;
  traderAddress:        string;
  virtualSolReserves:   bigint;
  virtualTokenReserves: bigint;
} | null {
  const PREFIX = "Program data: ";
  for (const log of logs) {
    if (!log.startsWith(PREFIX)) continue;
    try {
      const raw = Buffer.from(log.slice(PREFIX.length), "base64");
      if (raw.length < 113) continue;
      if (!raw.subarray(0, 8).equals(TRADE_EVENT_DISC)) continue;

      let off = 8;
      const mint         = bs58Encode(raw.subarray(off, off + 32)); off += 32;
      const solLamports  = raw.readBigUInt64LE(off).toString();     off += 8;
      const tokenAmount  = raw.readBigUInt64LE(off).toString();     off += 8;
      const isBuy        = raw[off] === 1;                          off += 1;
      const traderAddress = bs58Encode(raw.subarray(off, off + 32)); off += 32;
      off += 8; // skip timestamp (i64)
      const virtualSolReserves   = raw.readBigUInt64LE(off); off += 8;
      const virtualTokenReserves = raw.readBigUInt64LE(off);

      return { mint, solLamports, tokenAmount, isBuy, traderAddress,
               virtualSolReserves, virtualTokenReserves };
    } catch { continue; }
  }
  return null;
}

/**
 * Parse pump.fun CreateEvent from Anchor "Program data:" log lines.
 *
 * CreateEvent layout (borsh):
 *   discriminator (8)  name (borsh string)  symbol (borsh string)
 *   uri (borsh string)  mint (32)  bonding_curve (32)  user (32)
 */
function parseCreateEventFromLogs(logs: string[]): {
  name:           string;
  symbol:         string;
  uri:            string;
  mint:           string;
  creatorAddress: string;
} | null {
  const PREFIX = "Program data: ";
  for (const log of logs) {
    if (!log.startsWith(PREFIX)) continue;
    try {
      const raw = Buffer.from(log.slice(PREFIX.length), "base64");
      if (raw.length < 8 + 12 + 96) continue; // minimum plausible length
      if (!raw.subarray(0, 8).equals(CREATE_EVENT_DISC)) continue;

      const u8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
      let off = 8;
      const [name,   off1] = readBorshStr(u8, off);  off = off1;
      const [symbol, off2] = readBorshStr(u8, off);  off = off2;
      const [uri,    off3] = readBorshStr(u8, off);  off = off3;
      if (off + 96 > raw.length) continue; // need mint + bondingCurve + user
      const mint           = bs58Encode(raw.subarray(off, off + 32)); off += 32;
      off += 32; // skip bonding_curve
      const creatorAddress = bs58Encode(raw.subarray(off, off + 32));

      if (!name.trim() || !symbol.trim()) return null;
      return { name: name.trim(), symbol: symbol.trim(), uri: uri.trim(), mint, creatorAddress };
    } catch { continue; }
  }
  return null;
}

// ── On-chain instruction decoder (fallback for CREATE) ─────────────────────────
/** Decode pump.fun CREATE params directly from the transaction instruction data. */
function decodePumpCreate(tx: RpcTx): { name: string; symbol: string; uri: string } | null {
  const keys   = tx.transaction?.message?.accountKeys   ?? [];
  const instrs = tx.transaction?.message?.instructions  ?? [];

  const progIdx = keys.findIndex(
    (k) => (typeof k === "string" ? k : k.pubkey) === PUMP_PROGRAM,
  );
  if (progIdx < 0) return null;

  const instr = instrs.find((i) => i.programIdIndex === progIdx);
  if (!instr?.data) return null;

  try {
    const raw = bs58Decode(instr.data);
    if (raw.length < 9) return null;
    let off = 8;
    const [name,   off1] = readBorshStr(raw, off);
    const [symbol, off2] = readBorshStr(raw, off1);
    const [uri]          = readBorshStr(raw, off2);
    if (!name.trim() || !symbol.trim()) return null;
    return { name: name.trim(), symbol: symbol.trim(), uri: uri.trim() };
  } catch {
    return null;
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
    const { signature, logs } = event;

    // ── Fast path: decode CreateEvent from Anchor program log ──────────────
    const logEvent = parseCreateEventFromLogs(logs);
    let mint:           string;
    let name:           string;
    let symbol:         string;
    let uri:            string | null;
    let creatorAddress: string | null;

    if (logEvent) {
      ({ mint, name, symbol, creatorAddress } = logEvent);
      uri = logEvent.uri || null;
      this.log.debug({ mint, name, symbol }, "pump_fun: create decoded from log event");
    } else {
      // ── Fallback: getTransaction + on-chain instruction decode ───────────
      const tx = await this.getTransaction(signature);
      if (!tx || tx.meta?.err) return;

      mint = this.extractPumpMint(tx) ?? "";
      creatorAddress = this.extractSigner(tx);

      const params = decodePumpCreate(tx);
      name   = params?.name   ?? mint.slice(0, 8) + "…";
      symbol = params?.symbol ?? "???";
      uri    = params?.uri    ?? null;
    }

    if (!mint) {
      this.log.debug({ signature }, "pump_fun: could not extract mint — skipping create");
      return;
    }

    await db.insert(tokensTable).values({
      address:              mint,
      name,
      symbol,
      description:          null,
      imageUrl:             null,
      creatorAddress,
      totalSupply:          PUMP_TOTAL_SUPPLY.toString(),
      virtualTokenReserves: PUMP_INIT_VTOK.toString(),
      virtualEthReserves:   PUMP_INIT_VSOL_SOL,
      marketCapEth:         PUMP_INIT_MC_LAMPORTS,
      priceEth:             PUMP_INIT_PRICE_ETH,
      platform:             PLATFORM,
      chain:                CHAIN,
    }).onConflictDoNothing();

    this.log.info({ mint, name, symbol, marketCapEth: PUMP_INIT_MC_LAMPORTS },
      "pump_fun: new token ingested");

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
        createdAt:    new Date().toISOString(),
      },
    });

    // Fire-and-forget: fetch image from metadata URI (IPFS / pump.fun CDN).
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
    const { signature, logs } = event;

    let mint:           string;
    let isBuy:          boolean;
    let solLamports:    string;
    let tokenAmount:    string;
    let traderAddress:  string;
    // On-chain reserves from TradeEvent (exact); set when log parsing succeeds.
    let onChainVSolLam: bigint | null = null;
    let onChainVTok:    bigint | null = null;

    // ── Fast path: decode TradeEvent from Anchor program log ───────────────
    const logEvent = parseTradeEventFromLogs(logs);
    if (logEvent) {
      ({ mint, solLamports, tokenAmount, isBuy, traderAddress } = logEvent);
      onChainVSolLam = logEvent.virtualSolReserves;
      onChainVTok    = logEvent.virtualTokenReserves;
    } else {
      // ── Fallback: getTransaction + parseSwap ─────────────────────────────
      const tx = await this.getTransaction(signature);
      if (!tx || tx.meta?.err) return;
      const swap = this.parseSwap(tx);
      if (!swap) return;
      ({ mint, isBuy, solLamports, tokenAmount, traderAddress } = swap);
    }

    // Only compute price when both amounts are non-zero — avoids writing
    // 0.000...0 (from protocol fee/allocation events with sol_amount=0) over
    // the last valid price stored in the token row.
    const priceEth = tokenAmount !== "0" && solLamports !== "0"
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

    // ── Compute updated bonding curve state ───────────────────────────────
    // Prefer on-chain values from TradeEvent (exact reserves post-trade).
    // Fall back to constant-product estimation when using getTransaction path.
    let updVSolStr: string | undefined;
    let updVTokStr: string | undefined;
    let updMCStr:   string | undefined;

    if (onChainVSolLam !== null && onChainVTok !== null) {
      // Exact on-chain values — always correct, no estimation needed.
      updVSolStr = (Number(onChainVSolLam) / 1e9).toFixed(6).replace(/\.?0+$/, "");
      updVTokStr = onChainVTok.toString();
      if (onChainVTok > 0n)
        updMCStr = (PUMP_TOTAL_SUPPLY * onChainVSolLam / onChainVTok).toString();
    } else {
      // Fallback: constant-product estimation from current DB reserves.
      try {
        const [current] = await db
          .select({ virtualEthReserves: tokensTable.virtualEthReserves,
                    virtualTokenReserves: tokensTable.virtualTokenReserves })
          .from(tokensTable)
          .where(eq(tokensTable.address, mint))
          .limit(1);

        const vSolSol    = parseFloat(current?.virtualEthReserves ?? PUMP_INIT_VSOL_SOL);
        const vTokAtom   = BigInt(current?.virtualTokenReserves ?? PUMP_INIT_VTOK.toString());
        const oldVSolLam = BigInt(Math.round(vSolSol * 1e9));
        const tradeLam   = BigInt(solLamports);
        const k          = oldVSolLam * vTokAtom;

        const newVSolLam = isBuy
          ? oldVSolLam + tradeLam
          : oldVSolLam > tradeLam ? oldVSolLam - tradeLam : oldVSolLam;

        if (newVSolLam > 0n) {
          const newVTok = k / newVSolLam;
          updVSolStr = (Number(newVSolLam) / 1e9).toFixed(6).replace(/\.?0+$/, "");
          updVTokStr = newVTok.toString();
          if (newVTok > 0n)
            updMCStr = (PUMP_TOTAL_SUPPLY * newVSolLam / newVTok).toString();
        }
      } catch { /* keep existing reserves on parse error */ }
    }

    // Update token aggregate stats + bonding curve — never erase last good price.
    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
      ...(priceEth   !== null    ? { priceEth }                          : {}),
      ...(updVSolStr !== undefined ? { virtualEthReserves: updVSolStr }   : {}),
      ...(updVTokStr !== undefined ? { virtualTokenReserves: updVTokStr } : {}),
      ...(updMCStr   !== undefined ? { marketCapEth: updMCStr }           : {}),
    }).where(eq(tokensTable.address, mint));

    this.log.debug({ mint, isBuy, sol: solLamports, fromLog: logEvent !== null }, "pump_fun: trade ingested");

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
