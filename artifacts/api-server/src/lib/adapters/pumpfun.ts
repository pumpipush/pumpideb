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

import { eq, sql, and, isNull, gt } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { emitTrade, emitNewToken } from "../tradeEmitter";
import { logger as rootLogger } from "../logger";
import {
  SolanaRpcIndexer,
  detectInstructionType,
  type LogEvent,
  type RpcTx,
} from "./solanaRpcBase";
/** PumpSwap (pump-amm) program — graduation destination for pump.fun tokens since ~Mar 2025. */
const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

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
// price_eth is stored as SOL per token (not lamports per base_unit).
// Conversion: (lamports / base_unit) / 1000 = (SOL×1e9 / token×1e6) / 1000 = SOL/token
const PUMP_INIT_PRICE_ETH =
  (Number(PUMP_INIT_VSOL_LAMPORTS) / Number(PUMP_INIT_VTOK) / 1000).toFixed(15);

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

/** Swap slow public IPFS gateway to Cloudflare's CDN-backed gateway. */
function resolveIpfs(url: string): string {
  return url
    .replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/")
    .replace(/https?:\/\/cf-ipfs\.com\/ipfs\//, "https://ipfs.io/ipfs/");
}

interface UriMeta {
  imageUrl:    string | null;
  description: string | null;
  twitterUrl:  string | null;
  telegramUrl: string | null;
  websiteUrl:  string | null;
}

/**
 * Download the metadata JSON at a URI (IPFS / CDN) and extract all useful
 * fields: image, description, twitter, telegram, website.
 */
async function fetchMetaFromUri(uri: string): Promise<UriMeta | null> {
  if (!uri) return null;
  try {
    const res = await fetch(resolveIpfs(uri), {
      signal:  AbortSignal.timeout(10_000),
      headers: { "User-Agent": "RocketFi/1.0" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      image?:       string;
      description?: string;
      twitter?:     string;
      telegram?:    string;
      website?:     string;
    };
    const rawImage = json.image?.trim() || null;
    return {
      imageUrl:    rawImage ? resolveIpfs(rawImage) : null,
      description: json.description?.trim() || null,
      twitterUrl:  json.twitter?.trim()     || null,
      telegramUrl: json.telegram?.trim()    || null,
      websiteUrl:  json.website?.trim()     || null,
    };
  } catch {
    return null;
  }
}

// ── Indexer ────────────────────────────────────────────────────────────────────

class PumpFunChainIndexer extends SolanaRpcIndexer {
  private readonly _pumpApiAdapter = new PumpApiAdapter();

  /**
   * Per-mint write queue — serializes reserve updates for the same mint when
   * using the constant-product fallback path (i.e. when TradeEvent log was
   * unavailable). Without this, two concurrent handlers for the same mint can
   * both READ the same stale reserves, compute two slightly different NEW
   * reserve values, and overwrite each other — leaving the DB with a reserve
   * state that matches neither trade.
   *
   * Each enqueueReserveWrite() chains a new promise onto the tail of the mint's
   * queue so writes for the same mint are always sequential.
   */
  private readonly _mintQueue = new Map<string, Promise<void>>();

  private enqueueReserveWrite(mint: string, fn: () => Promise<void>): void {
    const prev = this._mintQueue.get(mint) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run fn whether prev resolved or rejected
    this._mintQueue.set(mint, next);
    // Cleanup: remove entry once settled to prevent unbounded map growth.
    next.finally(() => {
      if (this._mintQueue.get(mint) === next) this._mintQueue.delete(mint);
    });
  }

  constructor() {
    super({ programId: PUMP_PROGRAM, adapterName: "pump_fun" });
  }

  protected override onAllRpcsExhausted(): void {
    this._pumpApiAdapter.start();
  }

  protected override onRpcRecovered(): void {
    this._pumpApiAdapter.stop();
  }

  protected override shouldProcess(logs: string[]): boolean {
    const t = detectInstructionType(logs);
    if (t === "create" || t === "buy" || t === "sell") return true;
    // Also process graduation (Migrate) events so we can mark tokens as graduated
    // and hand off to the Raydium AMM adapter.
    return logs.some((l) => /Instruction:\s*Migrate\b/i.test(l));
  }

  protected override async onEvent(event: LogEvent): Promise<void> {
    const instrType = detectInstructionType(event.logs);
    if (instrType === "create") {
      await this.handleCreate(event);
    } else if (instrType === "buy" || instrType === "sell") {
      await this.handleTrade(event);
    } else if (event.logs.some((l) => /Instruction:\s*Migrate\b/i.test(l))) {
      await this.handleGraduation(event);
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

    // Guard: never insert WSOL or system programs as pump.fun tokens — they can
    // appear as the "mint" account in transactions where a bonding-curve account
    // is created for WSOL-related operations.
    const CREATION_SKIP = new Set([
      "So11111111111111111111111111111111111111112",    // WSOL
      "11111111111111111111111111111111",               // system program
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  // SPL Token program
    ]);
    if (CREATION_SKIP.has(mint)) {
      this.log.debug({ mint, signature }, "pump_fun: create: skipping known non-token address");
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

    // Helper: broadcast token to the live feed (used below in two paths).
    const broadcastToken = (imageUrl: string | null) => {
      emitNewToken({
        type: "newToken",
        token: {
          address:      mint,
          name,
          symbol,
          imageUrl,
          priceEth:     PUMP_INIT_PRICE_ETH,
          marketCapEth: PUMP_INIT_MC_LAMPORTS,
          platform:     PLATFORM,
          chain:        CHAIN,
          createdAt:    new Date().toISOString(),
        },
      });
    };

    if (uri) {
      // Delay the SSE broadcast until the metadata is resolved so the card never
      // shows a gradient placeholder that immediately flips to a real image.
      //
      // Race plan:
      //  • URI resolves within 3 s → broadcast WITH metadata, done.
      //  • Takes >3 s → broadcast now with null so card at least appears,
      //    then broadcast again with the image when it eventually resolves.
      let broadcasted = false;

      const fallback = setTimeout(() => {
        if (!broadcasted) { broadcasted = true; broadcastToken(null); }
      }, 3_000);

      fetchMetaFromUri(uri)
        .then(async (meta) => {
          clearTimeout(fallback);
          if (meta) {
            // Build update: only include fields that have values
            const dbUpdate: Record<string, string | null> = {};
            if (meta.imageUrl)    dbUpdate["imageUrl"]    = meta.imageUrl;
            if (meta.description) dbUpdate["description"] = meta.description;
            if (meta.twitterUrl)  dbUpdate["twitterUrl"]  = meta.twitterUrl;
            if (meta.telegramUrl) dbUpdate["telegramUrl"] = meta.telegramUrl;
            if (meta.websiteUrl)  dbUpdate["websiteUrl"]  = meta.websiteUrl;
            if (Object.keys(dbUpdate).length > 0) {
              await db.update(tokensTable).set(dbUpdate).where(eq(tokensTable.address, mint));
              this.log.debug({ mint, fields: Object.keys(dbUpdate) }, "pump_fun: metadata fetched from URI");
            }
          }
          const imageUrl = meta?.imageUrl ?? null;
          if (!broadcasted) {
            // Fast path — metadata ready before the 3 s fallback fired
            broadcasted = true;
            broadcastToken(imageUrl);
          } else if (imageUrl) {
            // Slow path — fallback already showed the card; update it with image
            broadcastToken(imageUrl);
          }
        })
        .catch(() => {
          clearTimeout(fallback);
          if (!broadcasted) { broadcasted = true; broadcastToken(null); }
          // enrichment loop will retry the image later
        });
    } else {
      // No metadata URI — broadcast immediately without image
      broadcastToken(null);
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

    // ── Inline repair: correct zero token_amount BEFORE insert ───────────────
    // When the TradeEvent log is present we have exact post-trade virtual
    // reserves on-chain. Back-calculate the pre-trade token reserve and derive
    // the token delta. This is race-free: no DB reads, runs entirely from the
    // parsed event before any other state is written.
    //
    // The fallback path (getTransaction + parseSwap) has no reserves; any
    // zero-amount trade it produces is left for the periodic healer, which
    // replays the full AMM history in correct insertion order.
    if (tokenAmount === "0" && onChainVSolLam !== null && onChainVTok !== null) {
      const solLam = BigInt(solLamports);
      if (solLam > 0n) {
        try {
          const k          = onChainVSolLam * onChainVTok;
          // TradeEvent reserves are POST-trade; reverse to get PRE-trade vSol
          const preVSolLam = isBuy ? onChainVSolLam - solLam : onChainVSolLam + solLam;
          if (preVSolLam > 0n) {
            const preVTok = k / preVSolLam;
            const delta   = isBuy ? preVTok - onChainVTok : onChainVTok - preVTok;
            if (delta > 0n) {
              tokenAmount = delta.toString();
              this.log.debug(
                { mint, tokenAmount, onChainVSolLam: onChainVSolLam.toString() },
                "pump_fun: zero token_amount corrected from on-chain reserves",
              );
            }
          }
        } catch { /* leave as zero — periodic healer will fix */ }
      }
    }

    // Only compute price when both amounts are non-zero — avoids writing
    // 0.000...0 (from protocol fee/allocation events with sol_amount=0) over
    // the last valid price stored in the token row.
    // price_eth = SOL per token = (lamports / base_unit) / 1000
    // (1e9 lamports/SOL ÷ 1e6 base_unit/token = 1e3 factor)
    const priceEth = tokenAmount !== "0" && solLamports !== "0"
      ? (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15)
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
      // This path is taken only when the Anchor TradeEvent log was absent.
      // Wrapped in enqueueReserveWrite() to serialize concurrent fallback
      // writes for the same mint — prevents two handlers from reading the
      // same stale reserves and overwriting each other with conflicting estimates.
      await new Promise<void>((resolve) => {
        this.enqueueReserveWrite(mint, async () => {
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
          resolve();
        });
      });
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

  // ── Graduation (Migrate) ───────────────────────────────────────────────────

  /**
   * Handle a pump.fun Migrate instruction — fires when the bonding curve fills
   * and liquidity moves to a DEX pool (PumpSwap since ~Mar 2025, Raydium AMM before).
   *
   * This method:
   *   1. Extracts the token mint from the transaction.
   *   2. Detects the destination DEX by checking whether the PumpSwap program
   *      appears in the transaction's account keys.
   *   3. Sets `graduated = true` and updates `platform` to 'pumpswap' when
   *      appropriate so the token immediately appears in the PumpSwap tab.
   */
  private async handleGraduation(event: LogEvent): Promise<void> {
    const { signature } = event;
    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    // The migrated token mint is account key 1 (the mint account) in pump.fun's
    // migrate instruction, or falls back to the new-mint extraction heuristic.
    const mint = this.extractPumpMint(tx);
    if (!mint) {
      this.log.debug({ signature }, "pump_fun: graduation: could not extract mint — skipping");
      return;
    }

    // Derive graduation time from the transaction's on-chain block time so the
    // chart boundary is precise regardless of RPC delays, reconnects, or replays.
    // Fall back to wall-clock only when blockTime is absent (very rare; pre-2020
    // transactions or archival RPCs that omit the field).
    const graduatedAt = tx.blockTime
      ? new Date(tx.blockTime * 1000)
      : new Date();

    // Extract fee payer and all account keys from the migration tx.
    const migKeys = tx.transaction?.message?.accountKeys ?? [];
    const migK0   = migKeys[0];
    const migFeePayer = migK0 ? (typeof migK0 === "string" ? migK0 : (migK0 as { pubkey?: string }).pubkey ?? "") : "";

    // Detect graduation destination: if PumpSwap program appears in the tx's
    // account keys, the token migrated to PumpSwap. Otherwise it went to old
    // Raydium AMM (pre-Mar 2025 path, no longer indexed).
    const allKeyStrings = migKeys.map(k =>
      typeof k === "string" ? k : (k as { pubkey?: string }).pubkey ?? ""
    );
    const destPlatform = allKeyStrings.includes(PUMPSWAP_PROGRAM) ? "pumpswap" : PLATFORM;

    // Guard: WSOL and system programs can appear as the "mint" in malformed
    // migration transactions and must never be treated as a graduated token.
    const GRADUATION_SKIP = new Set([
      "So11111111111111111111111111111111111111112",   // WSOL
      "11111111111111111111111111111111",              // system program
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token program
    ]);
    if (GRADUATION_SKIP.has(mint)) {
      this.log.warn({ mint, signature }, "pump_fun: graduation: skipping known non-token address");
      return;
    }

    // Upsert: create a minimal stub if this token was never indexed, then mark as
    // graduated and update platform. This handles tokens that launched and graduated
    // during a reconnect gap — without this they'd be invisible to the PumpSwap indexer.
    // The enrichment job fills in name, symbol, and image from on-chain metadata.
    await db
      .insert(tokensTable)
      .values({
        address:              mint,
        name:                 "???",       // placeholder — enrichment will overwrite
        symbol:               "???",       // placeholder — enrichment will overwrite
        description:          null,
        imageUrl:             null,
        creatorAddress:       migFeePayer || "unknown",
        totalSupply:          PUMP_TOTAL_SUPPLY.toString(),
        virtualTokenReserves: "0",
        virtualEthReserves:   "0",
        marketCapEth:         "0",
        priceEth:             null,
        platform:             destPlatform,
        chain:                CHAIN,
        graduated:            true,
        graduatedAt,
      })
      .onConflictDoUpdate({
        target: tokensTable.address,
        set: {
          // Update graduation fields + platform so the token moves to the right tab.
          // Never overwrite name, symbol, price, or other bonding-curve-phase data.
          graduated:   true,
          graduatedAt: sql`COALESCE(${tokensTable.graduatedAt}, EXCLUDED.graduated_at)`,
          platform:    sql`EXCLUDED.platform`,
        },
      });

    this.log.info({ mint, signature, destPlatform }, "pump_fun: token graduated");
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

// ── Periodic zero-amount trade heal job ───────────────────────────────────────

/**
 * Every HEAL_INTERVAL_MS, scan for pump_fun trades inserted in the last
 * HEAL_WINDOW_MS with token_amount='0' and price_eth IS NULL. For each
 * affected token, replay all its trades in insertion order (constant-product
 * AMM) to derive the missing amounts — identical to the manual backfill
 * script but running continuously in the background.
 *
 * Only non-graduated tokens are replayed (same reason as backfill Pass 1:
 * constant-product is invalid after Raydium migration).
 */

const HEAL_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes
const HEAL_WINDOW_MS   = 30 * 60 * 1_000; // look back 30 minutes

const healLog = rootLogger.child({ job: "zero-heal" });

async function healZeroAmountTrades(): Promise<void> {
  const windowStart = new Date(Date.now() - HEAL_WINDOW_MS);

  // Find distinct token mints with recent zero-amount eligible trades.
  // Join tokensTable to exclude graduated tokens: the bonding-curve constant-
  // product formula is only valid while the token is still on pump.fun's curve.
  // Graduated tokens that migrated to Raydium use a different AMM and would
  // produce wildly wrong replay prices.
  const affectedRows = await db
    .selectDistinct({ tokenAddress: tradesTable.tokenAddress })
    .from(tradesTable)
    .innerJoin(tokensTable, eq(tradesTable.tokenAddress, tokensTable.address))
    .where(
      and(
        eq(tradesTable.platform, "pump_fun"),
        eq(tradesTable.tokenAmount, "0"),
        isNull(tradesTable.priceEth),
        gt(tradesTable.ethAmount, "0"),
        gt(tradesTable.timestamp, windowStart),
        eq(tokensTable.graduated, false),
      )
    );

  if (affectedRows.length === 0) return;

  healLog.info({ count: affectedRows.length }, "zero-heal: found tokens with zero-amount trades");

  for (const { tokenAddress: mint } of affectedRows) {
    try {
      await healTokenTrades(mint);
    } catch (err) {
      healLog.warn({ err, mint }, "zero-heal: error healing token");
    }
  }
}

/**
 * Walk all pump_fun trades for `mint` in insertion order.
 * Starting from the protocol-defined initial reserves, advance the virtual
 * reserves for every valid trade and back-fill any row whose token_amount
 * is still '0' (and price_eth is null).
 */
async function healTokenTrades(mint: string): Promise<void> {
  const trades = await db
    .select({
      id:          tradesTable.id,
      isBuy:       tradesTable.isBuy,
      ethAmount:   tradesTable.ethAmount,
      tokenAmount: tradesTable.tokenAmount,
      priceEth:    tradesTable.priceEth,
    })
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.tokenAddress, mint),
        eq(tradesTable.platform, "pump_fun"),
      )
    )
    .orderBy(tradesTable.id);

  if (trades.length === 0) return;

  let vSolLam = PUMP_INIT_VSOL_LAMPORTS;
  let vTok    = PUMP_INIT_VTOK;
  const k     = vSolLam * vTok; // constant-product invariant

  let healed = 0;

  for (const trade of trades) {
    const solLam   = BigInt(trade.ethAmount);
    const needsFix = trade.tokenAmount === "0" && trade.priceEth === null;

    if (solLam === 0n) continue; // zero-SOL: no price derivable, skip advancing reserves

    let newVSolLam: bigint;
    let newVTok:    bigint;
    let tokenDelta: bigint;

    try {
      if (trade.isBuy) {
        newVSolLam = vSolLam + solLam;
        newVTok    = k / newVSolLam;
        tokenDelta = vTok - newVTok;
      } else {
        newVSolLam = vSolLam > solLam ? vSolLam - solLam : vSolLam;
        newVTok    = k / newVSolLam;
        tokenDelta = newVTok - vTok;
      }

      if (tokenDelta <= 0n || newVTok <= 0n) continue;

      if (needsFix) {
        // price_eth = SOL per token = (lamports / base_unit) / 1000
        // (same formula as the main trade handler — must divide by 1000)
        const derivedPriceEth = Number(solLam) / Number(tokenDelta) / 1000;

        // Sanity ceiling: pump.fun bonding-curve prices are never legitimately
        // above ~0.001 SOL/token (graduation happens around 0.00005). If the
        // replay diverged due to missing/reordered trades the derived price can
        // spike far beyond this. Skip writing rather than corrupt the DB — the
        // OHLCV query has a matching < 1.0 guard as a second line of defence,
        // but it is better to never write bad data in the first place.
        const HEAL_PRICE_CEILING = 0.01; // 0.01 SOL/token — 200× graduation price
        if (derivedPriceEth > HEAL_PRICE_CEILING) {
          healLog.warn(
            { mint, tradeId: trade.id, derivedPriceEth, ceiling: HEAL_PRICE_CEILING },
            "zero-heal: derived price exceeds ceiling — skipping write to protect chart",
          );
          // Still advance reserves so subsequent rows stay consistent
        } else {
          const priceEth = derivedPriceEth.toFixed(15);
          await db.update(tradesTable)
            .set({ tokenAmount: tokenDelta.toString(), priceEth })
            .where(eq(tradesTable.id, trade.id));
          healed++;
        }
      }

      // Always advance reserves — even for already-good rows — so the
      // virtual state stays consistent for subsequent zero rows.
      vSolLam = newVSolLam;
      vTok    = newVTok;
    } catch {
      continue;
    }
  }

  if (healed > 0) {
    healLog.info({ mint, healed }, "zero-heal: repaired zero-amount trades for token");
  }
}

function startZeroHealJob(): void {
  // Run once shortly after startup, then on a fixed interval.
  setTimeout(() => {
    void healZeroAmountTrades().catch((err: unknown) =>
      healLog.warn({ err }, "zero-heal: initial run failed"),
    );
    setInterval(() => {
      void healZeroAmountTrades().catch((err: unknown) =>
        healLog.warn({ err }, "zero-heal: periodic run failed"),
      );
    }, HEAL_INTERVAL_MS);
  }, 30_000); // 30 s after start — let the indexer warm up first
}

// ── PumpApiAdapter — last-resort fallback when all Solana RPC WSS endpoints are silent ──

/**
 * Connects to the pumpapi.io managed WebSocket stream (wss://stream.pumpapi.io/).
 * This service re-streams pump.fun trade and token-creation events without
 * requiring callers to run their own Solana RPC subscription.
 *
 * Used ONLY as a last-resort fallback after PumpFunChainIndexer exhausts all
 * its Solana RPC WSS endpoints.
 *
 * pumpapi.io stream event schema:
 *   action           — "buy" | "sell" | "create"
 *   pool             — "pump" for bonding-curve; may also be "pump-swap", "raydium", etc.
 *   signature        — Solana tx signature (one tx may emit multiple events)
 *   mint             — token mint address
 *   txSigner         — trader/creator public key
 *   quoteAmount      — SOL amount in decimal SOL (NOT lamports); multiply × 1e9 for lamports
 *   baseAmount       — token amount in decimal display units (6 dp); multiply × 1e6 for base
 *   vQuoteInBondingCurve — virtual SOL reserves (decimal SOL); multiply × 1e9 for lamports
 *   vBaseInBondingCurve  — virtual token reserves (decimal display units); × 1e6 for base
 *   timestamp        — unix timestamp in seconds
 *   name / symbol / uri — creation-only fields
 *
 * Events are deduped by (signature + mint) so no duplicate writes appear if
 * the chain RPC recovers while both sources briefly overlap, AND so that
 * multiple distinct events sharing the same signature (different mints) are
 * all processed correctly.
 */
const PUMPAPI_WSS = "wss://stream.pumpapi.io/";

/** Maximum number of event keys kept in the dedup set (oldest evicted first). */
const DEDUP_MAX = 20_000;

const pumpApiLog = rootLogger.child({ adapter: "pump_fun_fallback" });

/**
 * pumpapi.io stream event shape.
 * Only pump.fun bonding-curve events are processed (pool === "pump").
 * quoteAmount and virtual reserves arrive as decimal SOL; baseAmount in decimal tokens (6 dp).
 */
interface PumpApiEvent {
  action?:     string;  // "buy" | "sell" | "create"
  pool?:       string;  // "pump" = bonding curve; filter out others
  signature?:  string;
  mint?:       string;
  txSigner?:   string;  // trader / creator public key
  // Amounts in decimal display units (not raw lamports / base-units)
  quoteAmount?: number; // SOL paid/received (decimal); × 1e9 → lamports
  baseAmount?:  number; // token received/paid (decimal, 6 dp); × 1e6 → base units
  // Virtual reserves post-trade (decimal display units)
  vQuoteInBondingCurve?: number; // virtual SOL reserves (decimal); × 1e9 → lamports
  vBaseInBondingCurve?:  number; // virtual token reserves (decimal); × 1e6 → base units
  timestamp?:  number;  // unix timestamp in seconds
  // Creation-only
  name?:   string;
  symbol?: string;
  uri?:    string;
}

class PumpApiAdapter {
  private _ws:     WebSocket | null = null;
  private _active  = false;
  private _delay   = 5_000;
  private readonly _maxDelay = 120_000;
  private _keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Capped dedup set keyed by `signature`.
   *
   * The `trades` table enforces a globally-unique constraint on `tx_hash`, so
   * at most one row can be stored per Solana transaction signature regardless of
   * how many events the pumpapi.io stream emits for that tx. Deduplicating at
   * the signature level matches the DB model exactly: the first event processed
   * for a given signature wins, and subsequent events (if any) are silently
   * dropped — consistent with the chain-RPC path's own `onConflictDoNothing`.
   *
   * When the chain RPC recovers and both sources briefly overlap, this set
   * prevents the fallback from re-inserting rows already written by the chain.
   */
  private readonly _seen:      Set<string> = new Set();
  private readonly _seenOrder: string[]    = [];

  private _trackSeen(signature: string): boolean {
    if (this._seen.has(signature)) return false;
    if (this._seenOrder.length >= DEDUP_MAX) {
      const oldest = this._seenOrder.shift()!;
      this._seen.delete(oldest);
    }
    this._seen.add(signature);
    this._seenOrder.push(signature);
    return true;
  }

  start(): void {
    if (this._active) return;
    this._active = true;
    pumpApiLog.info({ wss: PUMPAPI_WSS }, "pump_fun_fallback: starting pumpapi.io adapter");
    this._connect();
  }

  stop(): void {
    if (!this._active) return;
    this._active = false;
    pumpApiLog.info("pump_fun_fallback: stopping pumpapi.io adapter");
    if (this._keepaliveTimer !== null) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  private _connect(): void {
    if (!this._active) return;
    try {
      const ws = new WebSocket(PUMPAPI_WSS);
      this._ws = ws;

      ws.addEventListener("open", () => {
        this._delay = 5_000;
        pumpApiLog.info({ wss: PUMPAPI_WSS }, "pump_fun_fallback: connected");

        // Keepalive ping every 20 s to prevent silent drops.
        this._keepaliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ method: "ping" })); } catch { /* ignore */ }
          }
        }, 20_000);
      });

      ws.addEventListener("message", (rawEvent) => {
        let msg: PumpApiEvent;
        try {
          msg = JSON.parse(rawEvent.data as string) as PumpApiEvent;
        } catch { return; }

        const action    = (msg.action ?? "").toLowerCase();
        const signature = msg.signature;
        const mint      = msg.mint;

        // Only process bonding-curve events (pool === "pump").
        // Other pools (pump-swap, raydium, meteora, …) would produce wrong AMM maths.
        if (msg.pool && msg.pool !== "pump") return;
        if (!signature || !mint) return;

        // Dedup by signature — matches the DB's globally-unique tx_hash constraint.
        if (!this._trackSeen(signature)) return;

        if (action === "create") {
          void this._handleCreate(msg).catch((err) =>
            pumpApiLog.error({ err, signature }, "pump_fun_fallback: error in handleCreate")
          );
        } else if (action === "buy" || action === "sell") {
          void this._handleTrade(msg, action === "buy").catch((err) =>
            pumpApiLog.error({ err, signature }, "pump_fun_fallback: error in handleTrade")
          );
        }
      });

      ws.addEventListener("error", (err) => {
        pumpApiLog.warn({ err: String(err) }, "pump_fun_fallback: WebSocket error");
      });

      ws.addEventListener("close", () => {
        if (this._keepaliveTimer !== null) {
          clearInterval(this._keepaliveTimer);
          this._keepaliveTimer = null;
        }
        if (!this._active) return; // stopped intentionally
        pumpApiLog.warn(
          { retryMs: this._delay },
          "pump_fun_fallback: disconnected — reconnecting"
        );
        setTimeout(() => this._connect(), this._delay);
        this._delay = Math.min(this._delay * 2, this._maxDelay);
      });
    } catch (err) {
      pumpApiLog.error({ err }, "pump_fun_fallback: failed to open WebSocket");
      if (this._active) {
        setTimeout(() => this._connect(), this._delay);
        this._delay = Math.min(this._delay * 2, this._maxDelay);
      }
    }
  }

  // ── Unit conversion helpers ────────────────────────────────────────────────

  /**
   * Convert decimal SOL to lamports (integer string).
   * quoteAmount from pumpapi.io is in SOL (e.g. 0.5 SOL → 500_000_000 lamports).
   */
  private static _solToLamports(sol: number | undefined): string {
    if (sol == null || !isFinite(sol)) return "0";
    return BigInt(Math.round(sol * 1e9)).toString();
  }

  /**
   * Convert decimal token amount to base units (integer string).
   * baseAmount from pumpapi.io is in display units with 6 decimal places
   * (e.g. 1.5 tokens → 1_500_000 base units for a 6-decimal token).
   */
  private static _tokToBase(display: number | undefined): string {
    if (display == null || !isFinite(display)) return "0";
    return BigInt(Math.round(display * 1e6)).toString();
  }

  /**
   * Parse unix-seconds timestamp from stream into a Date.
   * Falls back to wall-clock if the field is absent or implausible.
   */
  private static _parseTs(ts: number | undefined): Date {
    // pumpapi.io emits unix seconds; values ≥ 1e12 are already milliseconds.
    if (ts == null || ts <= 0) return new Date();
    return ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  private async _handleCreate(msg: PumpApiEvent): Promise<void> {
    const mint   = msg.mint;
    const name   = msg.name?.trim()   ?? "";
    const symbol = msg.symbol?.trim() ?? "";
    const uri    = msg.uri?.trim()    ?? null;
    const creatorAddress = msg.txSigner ?? null;

    if (!mint || !name || !symbol) {
      pumpApiLog.debug({ msg }, "pump_fun_fallback: skipping create — missing mint/name/symbol");
      return;
    }

    await db.insert(tokensTable).values({
      address:              mint,
      name,
      symbol,
      description:          null,
      imageUrl:             null,
      creatorAddress:       creatorAddress ?? "unknown",
      totalSupply:          PUMP_TOTAL_SUPPLY.toString(),
      virtualTokenReserves: PUMP_INIT_VTOK.toString(),
      virtualEthReserves:   PUMP_INIT_VSOL_SOL,
      marketCapEth:         PUMP_INIT_MC_LAMPORTS,
      priceEth:             PUMP_INIT_PRICE_ETH,
      platform:             PLATFORM,
      chain:                CHAIN,
    }).onConflictDoNothing();

    pumpApiLog.info({ mint, name, symbol }, "pump_fun_fallback: new token ingested");

    const broadcastToken = (imageUrl: string | null) => {
      emitNewToken({
        type: "newToken",
        token: {
          address:      mint,
          name,
          symbol,
          imageUrl,
          priceEth:     PUMP_INIT_PRICE_ETH,
          marketCapEth: PUMP_INIT_MC_LAMPORTS,
          platform:     PLATFORM,
          chain:        CHAIN,
          createdAt:    new Date().toISOString(),
        },
      });
    };

    if (uri) {
      let broadcasted = false;
      const fallback = setTimeout(() => {
        if (!broadcasted) { broadcasted = true; broadcastToken(null); }
      }, 3_000);

      fetchMetaFromUri(uri)
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
            }
          }
          const imageUrl = meta?.imageUrl ?? null;
          if (!broadcasted) {
            broadcasted = true;
            broadcastToken(imageUrl);
          } else if (imageUrl) {
            broadcastToken(imageUrl);
          }
        })
        .catch(() => {
          clearTimeout(fallback);
          if (!broadcasted) { broadcasted = true; broadcastToken(null); }
        });
    } else {
      broadcastToken(null);
    }
  }

  private async _handleTrade(msg: PumpApiEvent, isBuy: boolean): Promise<void> {
    const mint          = msg.mint;
    const signature     = msg.signature;
    const traderAddress = msg.txSigner ?? "unknown";

    if (!mint || !signature) return;

    // quoteAmount arrives in decimal SOL; convert to lamports for storage.
    // baseAmount arrives in decimal display units (6 dp); convert to base units.
    const solLamports = PumpApiAdapter._solToLamports(msg.quoteAmount);
    const tokenAmount = PumpApiAdapter._tokToBase(msg.baseAmount);

    // Virtual reserves: convert from decimal display units to lamports / base units.
    const vSolLam = msg.vQuoteInBondingCurve != null
      ? BigInt(PumpApiAdapter._solToLamports(msg.vQuoteInBondingCurve))
      : null;
    const vTokBase = msg.vBaseInBondingCurve != null
      ? BigInt(PumpApiAdapter._tokToBase(msg.vBaseInBondingCurve))
      : null;

    const priceEth = tokenAmount !== "0" && solLamports !== "0"
      ? (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15)
      : null;

    // Use the stream's event timestamp so chart data stays accurate regardless of
    // how long the chain RPC was silent before the fallback activated.
    const eventTs = PumpApiAdapter._parseTs(msg.timestamp);

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
      timestamp:     eventTs,
    }).onConflictDoNothing().returning();

    if (!trade) return; // duplicate

    // Compute updated bonding curve state when on-chain reserves are available.
    // vSolLam / vTokBase are already in lamports / base-units after unit conversion above.
    let updVSolStr: string | undefined;
    let updVTokStr: string | undefined;
    let updMCStr:   string | undefined;

    if (vSolLam !== null && vTokBase !== null && vSolLam > 0n && vTokBase > 0n) {
      updVSolStr = (Number(vSolLam) / 1e9).toFixed(6).replace(/\.?0+$/, "");
      updVTokStr = vTokBase.toString();
      updMCStr   = (PUMP_TOTAL_SUPPLY * vSolLam / vTokBase).toString();
    }

    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
      ...(priceEth    !== null     ? { priceEth }                          : {}),
      ...(updVSolStr  !== undefined ? { virtualEthReserves: updVSolStr }   : {}),
      ...(updVTokStr  !== undefined ? { virtualTokenReserves: updVTokStr } : {}),
      ...(updMCStr    !== undefined ? { marketCapEth: updMCStr }           : {}),
    }).where(eq(tokensTable.address, mint));

    pumpApiLog.debug({ mint, isBuy, sol: solLamports }, "pump_fun_fallback: trade ingested");

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
}

// ── Exported entry point ───────────────────────────────────────────────────────

export async function startPumpFunAdapter(): Promise<void> {
  const indexer = new PumpFunChainIndexer();
  indexer.start();
  startZeroHealJob();
}
