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
 * RPC: PublicNode (primary), Solana Foundation and Ankr as free fallbacks.
 */

import { eq, sql, and, isNull, gt } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { emitTrade, emitNewToken, emitSnapshot } from "../tradeEmitter";
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
const PUMPSWAP_PLATFORM = "pumpswap";
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
export function parseTradeEventFromLogs(logs: string[]): {
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
export function parseCreateEventFromLogs(logs: string[]): {
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

// Active IPFS gateways — cf-ipfs.com was shut down by Cloudflare.
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://w3s.link/ipfs/",
];

/** Normalise any IPFS URL variant to canonical https://ipfs.io/ipfs/{cid} form. */
function resolveIpfs(url: string): string {
  return url
    .replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/")
    .replace(/https?:\/\/cf-ipfs\.com\/ipfs\//, "https://ipfs.io/ipfs/");
}

/** Extract the bare CID from any IPFS URL variant. */
function extractIpfsCid(url: string): string | null {
  if (url.startsWith("ipfs://")) return url.slice(7);
  const m = url.match(/\/ipfs\/(.+)$/);
  return m?.[1] ?? null;
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
 *
 * For IPFS URIs, races all active gateways simultaneously so the fastest one
 * wins — this prevents a slow ipfs.io from delaying logo display.
 */
async function fetchMetaFromUri(uri: string): Promise<UriMeta | null> {
  if (!uri) return null;
  try {
    const cid = extractIpfsCid(uri);
    const urlsToTry = cid ? IPFS_GATEWAYS.map(g => g + cid) : [resolveIpfs(uri)];

    const res = await Promise.any(
      urlsToTry.map(u =>
        fetch(u, {
          signal:  AbortSignal.timeout(12_000),
          headers: { "User-Agent": "Pumpi/1.0" },
        }).then(r => r.ok ? r : Promise.reject(new Error(`HTTP ${r.status}`)))
      )
    );
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

const LL_PLATFORM           = "raydium_launchlab";
export class PumpFunChainIndexer extends SolanaRpcIndexer {
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

  constructor(opts?: { wssUrl?: string }) {
    super({ programId: PUMP_PROGRAM, adapterName: "pump_fun", wssUrl: opts?.wssUrl });
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
    // Use on-chain blockTime when available; fast-path (Anchor log) uses wall-clock
    // because no TX fetch is performed. Both are accurate to <5 s for real-time events.
    let tokenCreatedAt = new Date();

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
      if (tx.blockTime) tokenCreatedAt = new Date(tx.blockTime * 1000);
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
      createdAt:            tokenCreatedAt,
    }).onConflictDoUpdate({
      target: tokensTable.address,
      set: {
        // The create event is always authoritative for name/symbol — overwrite
        // any placeholder that handleTrade may have inserted earlier.
        name,
        symbol,
        // Prefer a known creator over the "unknown" placeholder set by handleTrade.
        creatorAddress: creatorAddress
          ? sql`CASE WHEN ${tokensTable.creatorAddress} = 'unknown' THEN ${creatorAddress} ELSE ${tokensTable.creatorAddress} END`
          : sql`${tokensTable.creatorAddress}`,
        // Bonding-curve fields: only initialise if still at the default "0" left by
        // the placeholder — trades running before handleCreate may have already
        // updated these with real on-chain values.
        totalSupply:          sql`CASE WHEN ${tokensTable.totalSupply} = '0' THEN ${PUMP_TOTAL_SUPPLY.toString()} ELSE ${tokensTable.totalSupply} END`,
        virtualTokenReserves: sql`CASE WHEN ${tokensTable.virtualTokenReserves} = '0' THEN ${PUMP_INIT_VTOK.toString()} ELSE ${tokensTable.virtualTokenReserves} END`,
        virtualEthReserves:   sql`CASE WHEN ${tokensTable.virtualEthReserves} = '0' THEN ${PUMP_INIT_VSOL_SOL} ELSE ${tokensTable.virtualEthReserves} END`,
        // Price/MC: set initial values only if not yet computed by a trade.
        marketCapEth: sql`COALESCE(${tokensTable.marketCapEth}, ${PUMP_INIT_MC_LAMPORTS})`,
        priceEth:     sql`COALESCE(${tokensTable.priceEth}, ${PUMP_INIT_PRICE_ETH})`,
      },
    });

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
          createdAt:    tokenCreatedAt.toISOString(),
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
    const tokBig = BigInt(tokenAmount);
    const priceEth = tokBig > 0n && solLamports !== "0"
      ? (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15)
      : null;

    // ── Dust trade guard ──────────────────────────────────────────────────────
    // Trades with fewer than 1 000 atomic token units (~0.001 display tokens)
    // OR fewer than 10 000 lamports SOL (~$0.002) produce astronomically wrong
    // prices and pollute trade history / volume stats.  Skip entirely.
    const MIN_PRICE_ATOMS  = 1_000n;
    const MIN_SOL_LAMPORTS = 10_000n; // 0.00001 SOL ≈ $0.002
    const solBig = BigInt(solLamports);
    if (tokBig < MIN_PRICE_ATOMS || solBig < MIN_SOL_LAMPORTS) {
      this.log.debug({ mint, tokenAmount, solLamports },
        "pump_fun: dust trade skipped (tokenAmount < MIN_PRICE_ATOMS or solLamports < MIN_SOL_LAMPORTS)");
      return;
    }

    // Ensure the token row exists before inserting the trade.
    // Migration 0017 added a FK (fk_trades_token) that rejects inserts when
    // the token_address has no matching tokens.address.  Pump.fun trade events
    // can arrive before (or without) the corresponding create event, so we
    // upsert a minimal placeholder here.  onConflictDoNothing means existing
    // rows are untouched; the full metadata is filled in by handleCreate later.
    await db.insert(tokensTable).values({
      address:        mint,
      name:           mint.slice(0, 8),
      symbol:         "???",
      creatorAddress: "unknown",
      platform:       PLATFORM,
      chain:          CHAIN,
    }).onConflictDoNothing();

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

export function startZeroHealJob(): void {
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

// ── PumpApiAdapter — exported for use by pumpApiManager ──────────────────────────

export const PUMPAPI_WSS = "wss://stream.pumpapi.io/";

/** Maximum number of event keys kept in the dedup set (oldest evicted first). */
const DEDUP_MAX = 20_000;

const pumpApiLog = rootLogger.child({ adapter: "pumpapi_primary" });

/**
 * pumpapi.io stream event shape (verified against live stream 2026-08-13).
 * Fields tokenAmount / vTokensInBondingCurve / vQuoteInBondingCurve match the
 * actual wire format — older field names baseAmount / vBaseInBondingCurve were wrong.
 */
export interface PumpApiEvent {
  action?:    string;  // "buy" | "sell" | "create" | "migrate"
  pool?:      string;  // "pump" = bonding curve; "pump-amm" = PumpSwap
  /** Origin of a PumpSwap pool; migration events from pump.fun set this to "pump". */
  poolCreatedBy?: string;
  /** PumpSwap AMM account supplied on migration/trade events when available. */
  poolAddress?: string;
  /** Alternate pool-address keys observed across PumpAPI stream versions. */
  poolId?:      string;
  ammPool?:     string;
  quoteMint?:   string;
  signature?: string;
  mint?:      string;
  txSigner?:  string;  // fee payer / tx initiator
  // Per-trade amounts — decimal display units (6 dp) / decimal SOL
  tokenAmount?: number; // tokens received/paid (decimal); × 1e6 → base units
  quoteAmount?: number; // SOL paid/received (decimal); × 1e9 → lamports
  // Create-only: amount the creator bought at launch
  initialBuy?: number; // tokens bought at create time (decimal display units)
  // Bonding-curve virtual reserves post-event (decimal display units)
  vTokensInBondingCurve?: number; // virtual token reserves; × 1e6 → base units
  vQuoteInBondingCurve?:  number; // virtual SOL reserves; × 1e9 → lamports
  // AMM reserves supplied on migration / pool-creation events.
  tokensInPool?: number;
  quoteInPool?:  number;
  // Pre-computed market data
  price?:          number; // SOL/token — matches our priceEth storage convention
  marketCapQuote?: number; // market cap in SOL; × 1e9 → lamports for marketCapEth
  timestamp?:      number; // unix timestamp in seconds (≥1e12 = already ms)
  // Metadata (present on all event types)
  name?:   string;
  symbol?: string;
  uri?:    string;
  // Trader breakdown (first entry is the actual user wallet for multi-hop txs)
  breakdown?: Array<{ action?: string; trader?: string; tokenAmount?: number; quoteAmount?: number }>;
}

/**
 * How long (ms) with no WebSocket messages before the watchdog force-closes
 * the connection. pumpapi.io streams all Solana pump.fun activity continuously —
 * 20 s of total silence (no pings, no data frames) reliably indicates a dead
 * or stalled TCP connection.
 * Exported so tests can reference the constant without hard-coding it.
 */
export const PUMPAPI_WATCHDOG_MS = 20_000;

/**
 * How long (ms) with no REAL TRADE OR CREATE events before the data-staleness
 * watchdog force-closes the connection.  This is longer than PUMPAPI_WATCHDOG_MS
 * and only resets on pump / pump-amm trade events — not keepalive pongs.
 *
 * Catches the failure mode where pumpapi.io is alive (pings succeed, raw watchdog
 * resets) but their internal routing has stopped forwarding trade data, causing
 * prices to silently go stale.
 *
 * 30 s is ample — at peak hours pump.fun averages 5–10 trades/second, so even
 * at minimal activity a healthy stream sends a trade event every few seconds.
 * Must remain > PUMPAPI_WATCHDOG_MS so the raw-silence watchdog fires first
 * when the connection is completely dead (no pings either).
 */
export const PUMPAPI_DATA_STALE_MS = 30_000;

export class PumpApiAdapter {
  private _ws:     WebSocket | null = null;
  private _active  = false;
  private _delay   = 5_000;
  private readonly _maxDelay = 120_000;
  private _keepaliveTimer:   ReturnType<typeof setInterval> | null = null;
  private _watchdogTimer:    ReturnType<typeof setTimeout>  | null = null;
  private _dataStaleTimer:   ReturnType<typeof setTimeout>  | null = null;

  /** Optional callbacks for health-based fallback coordination. */
  private readonly _onConnected?:    () => void;
  private readonly _onDisconnected?: () => void;
  /**
   * Called the moment the data-staleness watchdog fires — BEFORE the WebSocket
   * is closed. Lets the manager react immediately (e.g. start chain fallback)
   * rather than waiting for the close event which may arrive after pumpapi.io
   * has already reconnected, causing the fallback to be cancelled prematurely.
   */
  private readonly _onDataStale?:    () => void;
  /**
   * Called the FIRST time pumpapi.io delivers a real trade/create event on the
   * current connection (fires at most once per connect/reconnect cycle).
   * The manager uses this as proof that pumpapi.io is genuinely healthy and can
   * safely stop the chain-RPC fallback adapters.  Reconnecting alone is NOT
   * sufficient — pumpapi.io can reconnect but immediately go stale again.
   */
  private readonly _onRealData?:     () => void;

  /** True once _onRealData has been called for the current WS connection. Reset on each reconnect. */
  private _realDataFired = false;

  /**
   * Raw-silence watchdog window — defaults to PUMPAPI_WATCHDOG_MS.
   * Resets on ANY incoming WebSocket message (including keepalive pongs).
   * Exposed via constructor options so tests can pass a short value.
   */
  private readonly _watchdogMs: number;

  /**
   * Data-staleness watchdog window — defaults to PUMPAPI_DATA_STALE_MS.
   * Resets ONLY on real trade/create events (pool=pump or pump-amm).
   * Fires when pumpapi.io is alive (pings succeed) but stops forwarding data.
   * Exposed via constructor options so tests can pass a short value.
   */
  private readonly _dataStaleMs: number;

  /**
   * Injectable WebSocket factory — defaults to `(url) => new WebSocket(url)`.
   * Tests pass a mock factory to avoid real network connections.
   * This is a test-injection point; do not remove it.
   */
  private readonly _wsFactory: (url: string) => WebSocket;

  constructor(opts?: {
    onConnected?:    () => void;
    onDisconnected?: () => void;
    /**
     * Called when the data-staleness watchdog fires (pumpapi.io alive but no
     * trade data). Fires before the WebSocket close so the manager can schedule
     * the chain fallback before pumpapi.io reconnects and cancels it.
     */
    onDataStale?:    () => void;
    /**
     * Called once per connection the first time pumpapi.io delivers a real
     * trade or create event. The manager uses this as proof that pumpapi.io is
     * genuinely healthy so it can stop the chain-RPC fallback adapters.
     * Reconnecting alone is not enough — pumpapi.io can reconnect but stay stale.
     *
     * TEST-INJECTION POINT — do not remove.
     */
    onRealData?:     () => void;
    /**
     * Override raw-silence watchdog window (ms). Default: PUMPAPI_WATCHDOG_MS (60 000).
     *
     * TEST-INJECTION POINT — do not remove.
     * `pumpApiWatchdog.test.ts` passes a short value (e.g. 200 ms) here so the
     * watchdog fires quickly in fake-timer tests.  Removing this option breaks
     * the raw-silence watchdog test suite.
     */
    watchdogMs?:  number;
    /**
     * Override data-staleness watchdog window (ms). Default: PUMPAPI_DATA_STALE_MS (120 000).
     *
     * TEST-INJECTION POINT — do not remove.
     * `pumpApiWatchdog.test.ts` passes a short value here so the data-stale
     * watchdog fires quickly in fake-timer tests.  Removing this option breaks
     * the data-staleness watchdog test suite.
     */
    dataStaleMs?: number;
    /**
     * Override WebSocket constructor. Default: `(url) => new WebSocket(url)`.
     *
     * TEST-INJECTION POINT — do not remove.
     * `pumpApiWatchdog.test.ts` supplies a `MockWebSocket` factory via this
     * option to avoid real network connections.  Removing this option silently
     * decouples the watchdog tests from the real `_connect()` path.
     * Not intended for production overrides — in production, omit this option.
     */
    wsFactory?:   (url: string) => WebSocket;
  }) {
    this._onConnected    = opts?.onConnected;
    this._onDisconnected = opts?.onDisconnected;
    this._onDataStale    = opts?.onDataStale;
    this._onRealData     = opts?.onRealData;
    this._watchdogMs     = opts?.watchdogMs  ?? PUMPAPI_WATCHDOG_MS;
    this._dataStaleMs    = opts?.dataStaleMs ?? PUMPAPI_DATA_STALE_MS;
    this._wsFactory      = opts?.wsFactory   ?? ((url) => new WebSocket(url));
  }

  /**
   * Capped dedup set keyed by `signature + "|" + action`.
   *
   * Using signature+action (not just signature) allows a single transaction to
   * emit both a "create" event and a "buy" event (initial buy at launch) without
   * the second being dropped by the dedup filter. The DB's onConflictDoNothing
   * on tx_hash prevents duplicate trade rows if the same tx is also seen by a
   * fallback chain-RPC adapter.
   */
  private readonly _seen:      Set<string> = new Set();
  private readonly _seenOrder: string[]    = [];
  /**
   * PumpAPI delivers adjacent swaps and migrations as separate frames. Preserve
   * their wire order per mint so a final bonding-curve aggregate cannot finish
   * after the PumpSwap handoff and overwrite its DEX state.
   */
  private readonly _mintMutations = new Map<string, Promise<void>>();

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

  private _queueMintMutation(mint: string, mutation: () => Promise<void>): Promise<void> {
    const previous = this._mintMutations.get(mint) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this._mintMutations.set(mint, next);

    // Clean up without creating a second rejected promise that would be reported
    // as unhandled before the caller's error logger receives the original error.
    void next.then(
      () => { if (this._mintMutations.get(mint) === next) this._mintMutations.delete(mint); },
      () => { if (this._mintMutations.get(mint) === next) this._mintMutations.delete(mint); },
    );
    return next;
  }

  start(): void {
    if (this._active) return;
    this._active = true;
    pumpApiLog.info({ wss: PUMPAPI_WSS }, "pumpapi: starting primary stream");
    this._connect();
  }

  stop(): void {
    if (!this._active) return;
    this._active = false;
    pumpApiLog.info("pumpapi: stopping stream");
    this._clearWatchdog();
    this._clearDataStaleWatchdog();
    if (this._keepaliveTimer !== null) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  // ── Watchdog helpers ────────────────────────────────────────────────────────

  /**
   * Arm (or re-arm) the RAW-SILENCE watchdog for a specific WebSocket connection.
   * Resets on ANY incoming WebSocket message — including keepalive pongs.
   * Fires after _watchdogMs of total silence (first line of defence).
   */
  private _armWatchdog(ws: WebSocket): void {
    if (this._watchdogTimer !== null) {
      clearTimeout(this._watchdogTimer);
    }
    this._watchdogTimer = setTimeout(() => {
      this._watchdogTimer = null;
      pumpApiLog.warn(
        { watchdogMs: this._watchdogMs },
        "pumpapi: watchdog fired — no messages received; forcing reconnect"
      );
      ws.close(); // triggers close handler → _onDisconnected → reconnect loop
    }, this._watchdogMs);
  }

  private _clearWatchdog(): void {
    if (this._watchdogTimer !== null) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  /**
   * Arm (or re-arm) the DATA-STALENESS watchdog for a specific WebSocket connection.
   * Resets ONLY when a real trade or create event arrives (pool=pump or pump-amm).
   * Keepalive pongs do NOT reset this timer — so a connection that answers pings
   * but stops forwarding trade data will still be detected and recycled.
   */
  private _armDataStaleWatchdog(ws: WebSocket): void {
    if (this._dataStaleTimer !== null) {
      clearTimeout(this._dataStaleTimer);
    }
    this._dataStaleTimer = setTimeout(() => {
      this._dataStaleTimer = null;
      pumpApiLog.warn(
        { dataStaleMs: this._dataStaleMs },
        "pumpapi: data-staleness watchdog fired — no trade events received; forcing reconnect"
      );
      // Notify manager BEFORE closing so it can schedule chain fallback now.
      // Without this, pumpapi.io reconnects in ~5 s and cancels the 30 s
      // fallback timer before it has a chance to fire.
      this._onDataStale?.();
      ws.close(); // triggers close handler → _onDisconnected → reconnect loop
    }, this._dataStaleMs);
  }

  private _clearDataStaleWatchdog(): void {
    if (this._dataStaleTimer !== null) {
      clearTimeout(this._dataStaleTimer);
      this._dataStaleTimer = null;
    }
  }

  private _connect(): void {
    if (!this._active) return;
    try {
      const ws = this._wsFactory(PUMPAPI_WSS);
      this._ws = ws;

      ws.addEventListener("open", () => {
        this._delay = 5_000;
        this._realDataFired = false; // reset per-connection; fires once on first real event
        pumpApiLog.info({ wss: PUMPAPI_WSS }, "pumpapi: connected");
        this._onConnected?.();

        // Keepalive ping every 20 s — first line of defence against silent drops.
        this._keepaliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ method: "ping" })); } catch { /* ignore */ }
          }
        }, 20_000);

        // Raw-silence watchdog: arm on open; resets on every message.
        // Fires after _watchdogMs with zero bytes received (dead connection).
        this._armWatchdog(ws);

        // Data-staleness watchdog: arm on open; resets ONLY on real trade/create events.
        // Fires after _dataStaleMs if pings succeed but data stops (routing failure).
        this._armDataStaleWatchdog(ws);
      });

      ws.addEventListener("message", (rawEvent) => {
        // Reset watchdog on EVERY message — even unrecognised ones — so a live
        // connection that sends non-trade events (e.g. pong frames) isn't killed.
        this._armWatchdog(ws);

        let msg: PumpApiEvent;
        try {
          msg = JSON.parse(rawEvent.data as string) as PumpApiEvent;
        } catch { return; }

        const action    = (msg.action ?? "").toLowerCase();
        const pool      = msg.pool ?? "";
        const signature = msg.signature;
        const mint      = msg.mint;

        // Only process pump.fun bonding-curve, PumpSwap (pump-amm), and
        // Raydium LaunchLab (raydium-launchpad) events.
        if (pool !== "pump" && pool !== "pump-amm" && pool !== "raydium-launchpad") return;
        if (!signature || !mint) return;

        // Reset the data-staleness watchdog ONLY for actions that actually
        // represent real price-moving data (create / buy / sell / migration). Unknown or
        // metadata-only actions from these pools do NOT reset it, so a pumpapi.io
        // routing failure that keeps emitting non-trade messages is still caught.
        //
        // Placed BEFORE dedup: a duplicate event still proves data is flowing.
        const isPumpMigration =
          pool === "pump-amm" &&
          action === "migrate" &&
          msg.poolCreatedBy?.toLowerCase() === "pump";
        const isRealDataAction =
          (pool === "pump"              && (action === "create" || action === "buy" || action === "sell")) ||
          (pool === "pump-amm"          && (action === "buy"    || action === "sell"))         ||
          (pool === "raydium-launchpad" && (action === "create" || action === "buy" || action === "sell")) ||
          isPumpMigration;
        if (isRealDataAction) {
          this._armDataStaleWatchdog(ws);
          // Notify the manager the first time real data flows — proof pumpapi.io
          // is genuinely healthy, not just reconnected-but-stale.
          if (!this._realDataFired) {
            this._realDataFired = true;
            this._onRealData?.();
          }
        }

        // Dedup by (signature + action) — allows the same tx to emit both a
        // "create" and a "buy" event (initial buy at launch) without dropping one.
        const dedupKey = `${signature}|${action}`;
        if (!this._trackSeen(dedupKey)) return;

        if (pool === "pump") {
          if (action === "create") {
            void this._queueMintMutation(mint, () => this._handleCreate(msg)).catch((err) =>
              pumpApiLog.error({ err, signature }, "pumpapi: error in pump create")
            );
          } else if (action === "buy" || action === "sell") {
            void this._queueMintMutation(mint, () => this._handleTrade(msg, action === "buy")).catch((err) =>
              pumpApiLog.error({ err, signature }, "pumpapi: error in pump trade")
            );
          }
        } else if (pool === "pump-amm") {
          if (isPumpMigration) {
            void this._queueMintMutation(mint, () => this._handlePumpMigration(msg)).catch((err) =>
              pumpApiLog.error({ err, signature }, "pumpapi: error in pump migration")
            );
          } else if (action === "buy" || action === "sell") {
            void this._queueMintMutation(mint, () => this._handlePumpAmmTrade(msg, action === "buy")).catch((err) =>
              pumpApiLog.error({ err, signature }, "pumpapi: error in pump-amm trade")
            );
          }
        } else if (pool === "raydium-launchpad") {
          if (action === "create") {
            void this._handleLabCreate(msg).catch((err) =>
              pumpApiLog.error({ err, signature }, "pumpapi: error in raydium-launchpad create")
            );
          } else if (action === "buy" || action === "sell") {
            void this._handleLabTrade(msg, action === "buy").catch((err) =>
              pumpApiLog.error({ err, signature }, "pumpapi: error in raydium-launchpad trade")
            );
          }
        }
      });

      ws.addEventListener("error", (err) => {
        pumpApiLog.warn({ err: String(err) }, "pumpapi: WebSocket error");
      });

      ws.addEventListener("close", () => {
        // Always clear all timers regardless of whether the close was intentional.
        this._clearWatchdog();
        this._clearDataStaleWatchdog();
        if (this._keepaliveTimer !== null) {
          clearInterval(this._keepaliveTimer);
          this._keepaliveTimer = null;
        }
        if (!this._active) return; // stopped intentionally
        pumpApiLog.warn(
          { retryMs: this._delay },
          "pumpapi: disconnected — reconnecting"
        );
        this._onDisconnected?.();
        setTimeout(() => this._connect(), this._delay);
        this._delay = Math.min(this._delay * 2, this._maxDelay);
      });
    } catch (err) {
      pumpApiLog.error({ err }, "pumpapi: failed to open WebSocket");
      if (this._active) {
        this._onDisconnected?.();
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

  /**
   * Return a usable PumpSwap pool address without mistaking the stream's
   * `pool: "pump-amm"` category for an on-chain account address.
   */
  private static _poolAddress(msg: PumpApiEvent): string | null {
    for (const candidate of [msg.poolAddress, msg.poolId, msg.ammPool]) {
      const value = candidate?.trim();
      if (value) return value;
    }
    return null;
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  private async _handleCreate(msg: PumpApiEvent): Promise<void> {
    const mint   = msg.mint;
    const name   = msg.name?.trim()   ?? "";
    const symbol = msg.symbol?.trim() ?? "";
    const uri    = msg.uri?.trim()    ?? null;
    const creatorAddress = msg.txSigner ?? null;

    if (!mint || !name || !symbol) {
      pumpApiLog.debug({ msg }, "pumpapi: skipping create — missing mint/name/symbol");
      return;
    }

    // Use the stream's post-create bonding curve state if available;
    // fall back to protocol-defined initial values if not provided.
    const initVSolStr = msg.vQuoteInBondingCurve != null
      ? String(msg.vQuoteInBondingCurve)
      : PUMP_INIT_VSOL_SOL;
    const initVTokStr = msg.vTokensInBondingCurve != null
      ? PumpApiAdapter._tokToBase(msg.vTokensInBondingCurve)
      : PUMP_INIT_VTOK.toString();
    const initPriceEth = msg.price != null && isFinite(msg.price) && msg.price > 0
      ? msg.price.toFixed(15)
      : PUMP_INIT_PRICE_ETH;
    const initMCStr = msg.marketCapQuote != null
      ? BigInt(Math.round(msg.marketCapQuote * 1e9)).toString()
      : PUMP_INIT_MC_LAMPORTS;

    const tokenCreatedAt = PumpApiAdapter._parseTs(msg.timestamp);

    // Use onConflictDoUpdate for name/symbol/creatorAddress so that if a trade
    // event arrived first and inserted a stub (name=mint.slice(0,8), symbol="???"),
    // the real metadata from the create event overwrites it.  Price/reserve fields
    // are intentionally excluded — a concurrent trade may have set better values.
    await db.insert(tokensTable).values({
      address:              mint,
      name,
      symbol,
      description:          null,
      imageUrl:             null,
      creatorAddress:       creatorAddress ?? "unknown",
      totalSupply:          PUMP_TOTAL_SUPPLY.toString(),
      virtualTokenReserves: initVTokStr,
      virtualEthReserves:   initVSolStr,
      marketCapEth:         initMCStr,
      priceEth:             initPriceEth,
      platform:             PLATFORM,
      chain:                CHAIN,
      createdAt:            tokenCreatedAt,
    }).onConflictDoUpdate({
      target: tokensTable.address,
      set: {
        name,
        symbol,
        creatorAddress: creatorAddress ?? "unknown",
      },
    });

    // If the creator bought tokens at launch, emit an initial-buy trade.
    // This captures it even if no separate buy|pump event is emitted for the same tx.
    if (msg.initialBuy && msg.initialBuy > 0 && msg.quoteAmount && msg.quoteAmount > 0) {
      const initSolLam  = PumpApiAdapter._solToLamports(msg.quoteAmount);
      const initTokBase = PumpApiAdapter._tokToBase(msg.initialBuy);
      const initTrader  = msg.breakdown?.[0]?.trader ?? creatorAddress ?? "unknown";
      const [initTrade] = await db.insert(tradesTable).values({
        tokenAddress:  mint,
        traderAddress: initTrader ?? "unknown",
        isBuy:         true,
        ethAmount:     initSolLam,
        tokenAmount:   initTokBase,
        priceEth:      initPriceEth,
        txHash:        msg.signature!,
        platform:      PLATFORM,
        timestamp:     tokenCreatedAt,
      }).onConflictDoNothing().returning();

      // Count the initial buy in the token's aggregates so the explore page
      // shows correct trade counts for freshly launched tokens (previously they
      // showed 0 trades until a separate buy event arrived).
      if (initTrade) {
        await db.update(tokensTable).set({
          tradeCount: sql`${tokensTable.tradeCount} + 1`,
          volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${initSolLam} AS TEXT)`,
        }).where(eq(tokensTable.address, mint));
      }
    }

    pumpApiLog.info({ mint, name, symbol, marketCapEth: initMCStr }, "pumpapi: new pump_fun token ingested");

    const broadcastToken = (imageUrl: string | null) => {
      emitNewToken({
        type: "newToken",
        token: {
          address:      mint,
          name,
          symbol,
          imageUrl,
          // Use the actual event values — not the protocol-default constants —
          // so the Explore "New" feed shows the real price/mcap at launch time.
          priceEth:     initPriceEth,
          marketCapEth: initMCStr,
          platform:     PLATFORM,
          chain:        CHAIN,
          createdAt:    tokenCreatedAt.toISOString(),
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
    // breakdown[0].trader is the actual user wallet; txSigner may be a bot/aggregator.
    const traderAddress = msg.breakdown?.[0]?.trader ?? msg.txSigner ?? "unknown";

    if (!mint || !signature) return;

    // quoteAmount arrives in decimal SOL; convert to lamports for storage.
    // tokenAmount arrives in decimal display units (6 dp); convert to base units.
    const solLamports = PumpApiAdapter._solToLamports(msg.quoteAmount);
    const tokenAmount = PumpApiAdapter._tokToBase(msg.tokenAmount);

    // Virtual reserves post-trade — decimal SOL / display units → lamports / base units.
    const vSolLam = msg.vQuoteInBondingCurve != null
      ? BigInt(PumpApiAdapter._solToLamports(msg.vQuoteInBondingCurve))
      : null;
    const vTokBase = msg.vTokensInBondingCurve != null
      ? BigInt(PumpApiAdapter._tokToBase(msg.vTokensInBondingCurve))
      : null;

    // priceEth = SOL/token — use stream's pre-computed value when available.
    // msg.price is already in SOL/token (verified: quoteAmount/tokenAmount matches).
    const priceEth = msg.price != null && isFinite(msg.price) && msg.price > 0
      ? msg.price.toFixed(15)
      : (tokenAmount !== "0" && solLamports !== "0"
          ? (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15)
          : null);

    // Use the stream's event timestamp so chart data stays accurate.
    const eventTs = PumpApiAdapter._parseTs(msg.timestamp);

    // ── FK guard ────────────────────────────────────────────────────────────
    // fk_trades_token rejects inserts when token_address has no matching row.
    // Trade events can arrive before (or without) the corresponding create
    // event when create+buy land in the same block and are dispatched as
    // independent fire-and-forget promises.  Upsert a minimal placeholder so
    // the FK is satisfied; onConflictDoNothing leaves existing rows untouched.
    await db.insert(tokensTable).values({
      address:        mint,
      name:           mint.slice(0, 8),
      symbol:         "???",
      creatorAddress: "unknown",
      platform:       PLATFORM,
      chain:          CHAIN,
    }).onConflictDoNothing();

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

    pumpApiLog.debug({ mint, isBuy, sol: solLamports }, "pumpapi: pump_fun trade ingested");

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
  // ── PumpSwap handoff + trade handling ─────────────────────────────────────

  /**
   * Promote an existing pump.fun row after PumpAPI's explicit migration event.
   *
   * This is deliberately one UPDATE statement: readers never see a token marked
   * graduated on the old bonding-curve platform (or vice versa). The stream's
   * timestamp is the authoritative graduation boundary for charts and UI routing.
   */
  private async _handlePumpMigration(msg: PumpApiEvent): Promise<void> {
    const mint = msg.mint;
    if (!mint) return;

    const graduatedAt = PumpApiAdapter._parseTs(msg.timestamp);
    const poolAddress = PumpApiAdapter._poolAddress(msg);
    const quoteMint   = msg.quoteMint?.trim() || null;
    const priceEth = msg.price != null && isFinite(msg.price) && msg.price > 0
      ? msg.price.toFixed(15)
      : (
        msg.tokensInPool != null && msg.tokensInPool > 0 &&
        msg.quoteInPool != null && msg.quoteInPool > 0
          ? (msg.quoteInPool / msg.tokensInPool).toFixed(15)
          : null
      );
    const marketCapEth = msg.marketCapQuote != null && isFinite(msg.marketCapQuote)
      ? BigInt(Math.round(msg.marketCapQuote * 1e9)).toString()
      : null;

    const [updated] = await db
      .update(tokensTable)
      .set({
        graduated:   true,
        graduatedAt,
        platform:    PUMPSWAP_PLATFORM,
        ...(poolAddress ? { poolAddress } : {}),
        ...(quoteMint   ? { quoteMint }   : {}),
        ...(priceEth    ? { priceEth }    : {}),
        ...(marketCapEth ? { marketCapEth } : {}),
      })
      .where(and(
        eq(tokensTable.address, mint),
        eq(tokensTable.platform, PLATFORM),
      ))
      .returning({
        address:              tokensTable.address,
        name:                 tokensTable.name,
        symbol:               tokensTable.symbol,
        imageUrl:             tokensTable.imageUrl,
        priceEth:             tokensTable.priceEth,
        marketCapEth:         tokensTable.marketCapEth,
        volumeEth:            tokensTable.volumeEth,
        virtualEthReserves:   tokensTable.virtualEthReserves,
        virtualTokenReserves: tokensTable.virtualTokenReserves,
        tradeCount:           tokensTable.tradeCount,
        platform:             tokensTable.platform,
        chain:                tokensTable.chain,
      });

    if (!updated) {
      // A missed create is repaired by the first PumpSwap trade, which has the
      // metadata/trade data required to create a useful row. Do not add a blank
      // migration-only token to explorer rankings.
      pumpApiLog.debug({ mint, signature: msg.signature }, "pumpapi: migration arrived before token record");
      return;
    }

    // Let an already-open token detail page switch its quote/trade path before
    // the first PumpSwap swap lands. The client refetches its canonical token
    // record when this snapshot reports the new platform.
    emitSnapshot({
      type: "snapshot",
      token: {
        ...updated,
        tradeCount: Number(updated.tradeCount),
      },
    });

    pumpApiLog.info(
      { mint, poolAddress, quoteMint, graduatedAt: graduatedAt.toISOString() },
      "pumpapi: pump_fun token migrated to pumpswap",
    );
  }

  /**
   * Repair a missed migration when the first PumpSwap trade arrives. Restrict the
   * update to an old pump_fun row so native PumpSwap listings retain their own
   * lifecycle data. An event observed after this fallback is idempotently ignored
   * because there is no safe way to distinguish a replay from a native pool.
   */
  private async _repairPumpSwapTransition(msg: PumpApiEvent, graduatedAt: Date): Promise<void> {
    const mint = msg.mint;
    if (!mint) return;

    const poolAddress = PumpApiAdapter._poolAddress(msg);
    const quoteMint   = msg.quoteMint?.trim() || null;

    await db
      .update(tokensTable)
      .set({
        graduated:   true,
        graduatedAt: sql`COALESCE(${tokensTable.graduatedAt}, ${graduatedAt})`,
        platform:    PUMPSWAP_PLATFORM,
        ...(poolAddress ? { poolAddress: sql`COALESCE(NULLIF(${tokensTable.poolAddress}, ''), ${poolAddress})` } : {}),
        ...(quoteMint   ? { quoteMint:   sql`COALESCE(NULLIF(${tokensTable.quoteMint}, ''), ${quoteMint})` }   : {}),
      })
      .where(and(
        eq(tokensTable.address, mint),
        eq(tokensTable.platform, PLATFORM),
      ));
  }

  private async _handlePumpAmmTrade(msg: PumpApiEvent, isBuy: boolean): Promise<void> {
    const mint          = msg.mint;
    const signature     = msg.signature;
    const traderAddress = msg.breakdown?.[0]?.trader ?? msg.txSigner ?? "unknown";

    if (!mint || !signature) return;

    const solLamports = PumpApiAdapter._solToLamports(msg.quoteAmount);
    const tokenAmount = PumpApiAdapter._tokToBase(msg.tokenAmount);

    const priceEth = msg.price != null && isFinite(msg.price) && msg.price > 0
      ? msg.price.toFixed(15)
      : (tokenAmount !== "0" && solLamports !== "0"
          ? (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15)
          : null);

    const marketCapEth = msg.marketCapQuote != null && isFinite(msg.marketCapQuote)
      ? BigInt(Math.round(msg.marketCapQuote * 1e9)).toString()
      : null;

    const eventTs = PumpApiAdapter._parseTs(msg.timestamp);

    // A missing explicit migration must not leave an old bonding-curve row on
    // pump_fun. Repair the handoff before writing the PumpSwap trade so the
    // detail page, rankings, and Buy/Sell path agree with the trade history.
    await this._repairPumpSwapTransition(msg, eventTs);

    // Auto-create the token record on first encounter (graduated = true). Use a
    // placeholder when PumpAPI omitted metadata so the FK-safe trade insert still
    // succeeds; enrichment will replace it when metadata becomes available.
    const name   = msg.name?.trim()   ?? null;
    const symbol = msg.symbol?.trim() ?? null;
    const [inserted] = await db.insert(tokensTable).values({
      address:        mint,
      name:           name ?? mint.slice(0, 8),
      symbol:         symbol ?? "???",
      imageUrl:       null,
      creatorAddress: traderAddress,
      platform:       PUMPSWAP_PLATFORM,
      chain:          CHAIN,
      graduated:      true,
      graduatedAt:    eventTs,
      ...(PumpApiAdapter._poolAddress(msg) ? { poolAddress: PumpApiAdapter._poolAddress(msg)! } : {}),
      ...(msg.quoteMint?.trim() ? { quoteMint: msg.quoteMint.trim() } : {}),
      ...(priceEth     ? { priceEth }     : {}),
      ...(marketCapEth ? { marketCapEth } : {}),
    }).onConflictDoNothing().returning({ id: tokensTable.id });

    if (inserted && name && symbol) {
      emitNewToken({
        type: "newToken",
        token: {
          address:      mint,
          name,
          symbol,
          imageUrl:     null,
          priceEth,
          marketCapEth,
          platform:     PUMPSWAP_PLATFORM,
          chain:        CHAIN,
          createdAt:    eventTs.toISOString(),
        },
      });
    }

    // Insert trade
    const [trade] = await db.insert(tradesTable).values({
      tokenAddress:  mint,
      traderAddress,
      isBuy,
      ethAmount:     solLamports,
      tokenAmount,
      priceEth,
      txHash:        signature,
      platform:      PUMPSWAP_PLATFORM,
      timestamp:     eventTs,
    }).onConflictDoNothing().returning();

    if (!trade) return; // duplicate

    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
      ...(priceEth     ? { priceEth }     : {}),
      ...(marketCapEth ? { marketCapEth } : {}),
    }).where(eq(tokensTable.address, mint));

    pumpApiLog.debug({ mint, isBuy, sol: solLamports }, "pumpapi: pump-amm trade ingested");

    const [tokenRow] = await db
      .select({
        name:         tokensTable.name,
        symbol:       tokensTable.symbol,
        marketCapEth: tokensTable.marketCapEth,
        volumeEth:    tokensTable.volumeEth,
        tradeCount:   tokensTable.tradeCount,
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
        platform:      PUMPSWAP_PLATFORM,
        timestamp:     trade.timestamp.toISOString(),
      },
      token: {
        address:              mint,
        name:                 tokenRow?.name   ?? null,
        symbol:               tokenRow?.symbol ?? null,
        priceEth,
        marketCapEth:         tokenRow?.marketCapEth ?? marketCapEth,
        volumeEth:            tokenRow?.volumeEth    ?? solLamports,
        virtualEthReserves:   "0",
        virtualTokenReserves: "0",
        tradeCount:           Number(tokenRow?.tradeCount ?? 1),
        platform:             PUMPSWAP_PLATFORM,
        chain:                CHAIN,
      },
    });
  }

  // ── Raydium LaunchLab create handler ──────────────────────────────────────

  private async _handleLabCreate(msg: PumpApiEvent): Promise<void> {
    const mint   = msg.mint;
    const name   = msg.name?.trim()   ?? "";
    const symbol = msg.symbol?.trim() ?? "";
    const uri    = msg.uri?.trim()    ?? null;
    const creatorAddress = msg.txSigner ?? null;

    if (!mint || !name || !symbol) {
      pumpApiLog.debug({ msg }, "pumpapi: skipping raydium-launchpad create — missing mint/name/symbol");
      return;
    }

    const initVSolStr = msg.vQuoteInBondingCurve != null
      ? String(msg.vQuoteInBondingCurve)
      : LL_INIT_VSOL_SOL;
    const initVTokStr = msg.vTokensInBondingCurve != null
      ? PumpApiAdapter._tokToBase(msg.vTokensInBondingCurve)
      : LL_INIT_VTOK.toString();
    const initPriceEth = msg.price != null && isFinite(msg.price) && msg.price > 0
      ? msg.price.toFixed(15)
      : LL_INIT_PRICE_ETH;
    const initMCStr = msg.marketCapQuote != null
      ? BigInt(Math.round(msg.marketCapQuote * 1e9)).toString()
      : LL_INIT_MC_LAMPORTS;

    const tokenCreatedAt = PumpApiAdapter._parseTs(msg.timestamp);

    // Same race-condition fix as pump_fun create: trade events can land before
    // the create event and insert a stub (name=mint.slice(0,8)).  onConflictDoUpdate
    // ensures the real name/symbol always overwrites the placeholder.
    await db.insert(tokensTable).values({
      address:              mint,
      name,
      symbol,
      description:          null,
      imageUrl:             null,
      creatorAddress:       creatorAddress ?? "unknown",
      totalSupply:          LL_TOTAL_SUPPLY.toString(),
      virtualTokenReserves: initVTokStr,
      virtualEthReserves:   initVSolStr,
      marketCapEth:         initMCStr,
      priceEth:             initPriceEth,
      platform:             LL_PLATFORM,
      chain:                CHAIN,
      createdAt:            tokenCreatedAt,
    }).onConflictDoUpdate({
      target: tokensTable.address,
      set: {
        name,
        symbol,
        creatorAddress: creatorAddress ?? "unknown",
      },
    });

    pumpApiLog.info({ mint, name, symbol }, "pumpapi: new raydium_launchlab token ingested");

    const broadcastToken = (imageUrl: string | null) => {
      emitNewToken({
        type: "newToken",
        token: {
          address:      mint,
          name,
          symbol,
          imageUrl,
          priceEth:     initPriceEth,
          marketCapEth: initMCStr,
          platform:     LL_PLATFORM,
          chain:        CHAIN,
          createdAt:    tokenCreatedAt.toISOString(),
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
          if (!broadcasted) { broadcasted = true; broadcastToken(imageUrl); }
          else if (imageUrl) broadcastToken(imageUrl);
        })
        .catch(() => {
          clearTimeout(fallback);
          if (!broadcasted) { broadcasted = true; broadcastToken(null); }
        });
    } else {
      broadcastToken(null);
    }
  }

  // ── Raydium LaunchLab trade handler ────────────────────────────────────────

  private async _handleLabTrade(msg: PumpApiEvent, isBuy: boolean): Promise<void> {
    const mint          = msg.mint;
    const signature     = msg.signature;
    const traderAddress = msg.breakdown?.[0]?.trader ?? msg.txSigner ?? "unknown";

    if (!mint || !signature) return;

    const solLamports = PumpApiAdapter._solToLamports(msg.quoteAmount);
    const tokenAmount = PumpApiAdapter._tokToBase(msg.tokenAmount);

    const vSolLam = msg.vQuoteInBondingCurve != null
      ? BigInt(PumpApiAdapter._solToLamports(msg.vQuoteInBondingCurve))
      : null;
    const vTokBase = msg.vTokensInBondingCurve != null
      ? BigInt(PumpApiAdapter._tokToBase(msg.vTokensInBondingCurve))
      : null;

    const priceEth = msg.price != null && isFinite(msg.price) && msg.price > 0
      ? msg.price.toFixed(15)
      : (tokenAmount !== "0" && solLamports !== "0"
          ? (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15)
          : null);

    const marketCapEth = vSolLam !== null && vTokBase !== null && vTokBase > 0n
      ? (LL_TOTAL_SUPPLY * vSolLam / vTokBase).toString()
      : (msg.marketCapQuote != null && isFinite(msg.marketCapQuote)
          ? BigInt(Math.round(msg.marketCapQuote * 1e9)).toString()
          : undefined);

    const eventTs = PumpApiAdapter._parseTs(msg.timestamp);

    // Auto-create a placeholder token row if we missed the create event.
    const [existing] = await db
      .select({ id: tokensTable.id })
      .from(tokensTable)
      .where(eq(tokensTable.address, mint))
      .limit(1);

    if (!existing) {
      pumpApiLog.warn({ mint }, "pumpapi: raydium-launchpad first trade — auto-creating placeholder");
      await db.insert(tokensTable).values({
        address:              mint,
        name:                 msg.name?.trim() ?? mint.slice(0, 8) + "…",
        symbol:               msg.symbol?.trim() ?? "???",
        description:          null,
        imageUrl:             null,
        creatorAddress:       traderAddress,
        totalSupply:          LL_TOTAL_SUPPLY.toString(),
        virtualTokenReserves: vTokBase?.toString() ?? LL_INIT_VTOK.toString(),
        virtualEthReserves:   vSolLam != null ? (Number(vSolLam) / 1e9).toFixed(6) : LL_INIT_VSOL_SOL,
        marketCapEth:         marketCapEth ?? LL_INIT_MC_LAMPORTS,
        priceEth:             priceEth ?? LL_INIT_PRICE_ETH,
        platform:             LL_PLATFORM,
        chain:                CHAIN,
      }).onConflictDoNothing();
    }

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
      platform:      LL_PLATFORM,
      timestamp:     eventTs,
    }).onConflictDoNothing().returning();

    if (!trade) return; // duplicate

    let updVSolStr: string | undefined;
    let updVTokStr: string | undefined;

    if (vSolLam !== null && vTokBase !== null && vSolLam > 0n && vTokBase > 0n) {
      updVSolStr = (Number(vSolLam) / 1e9).toFixed(6).replace(/\.?0+$/, "");
      updVTokStr = vTokBase.toString();
    }

    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
      ...(priceEth    !== null     ? { priceEth }                          : {}),
      ...(updVSolStr  !== undefined ? { virtualEthReserves: updVSolStr }   : {}),
      ...(updVTokStr  !== undefined ? { virtualTokenReserves: updVTokStr } : {}),
      ...(marketCapEth !== undefined ? { marketCapEth }                    : {}),
    }).where(eq(tokensTable.address, mint));

    pumpApiLog.debug({ mint, isBuy, sol: solLamports }, "pumpapi: raydium_launchlab trade ingested");

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
        platform:      LL_PLATFORM,
        timestamp:     trade.timestamp.toISOString(),
      },
      token: {
        address:              mint,
        name:                 tokenRow?.name        ?? null,
        symbol:               tokenRow?.symbol      ?? null,
        priceEth,
        marketCapEth:         tokenRow?.marketCapEth ?? marketCapEth ?? null,
        volumeEth:            tokenRow?.volumeEth    ?? solLamports,
        virtualEthReserves:   tokenRow?.virtualEthReserves   ?? LL_INIT_VSOL_SOL,
        virtualTokenReserves: tokenRow?.virtualTokenReserves ?? LL_INIT_VTOK.toString(),
        tradeCount:           Number(tokenRow?.tradeCount ?? 1),
        platform:             LL_PLATFORM,
        chain:                CHAIN,
      },
    });
  }
}

// ── Exported entry points ──────────────────────────────────────────────────────

/**
 * Start the pump.fun chain-RPC indexer (logsSubscribe).
 * Called by PumpStreamManager as a fallback when pumpapi.io is down.
 * Normally you should call startPumpStreamManager() from pumpApiManager.ts.
 */
export async function startPumpFunAdapter(): Promise<void> {
  const indexer = new PumpFunChainIndexer();
  indexer.start();
  startZeroHealJob();
}
const LL_TOTAL_SUPPLY       = 1_000_000_000_000_000n;
const LL_INIT_VSOL_LAMPORTS = 30_000_000_000n;
const LL_INIT_VSOL_SOL      = "30";
const LL_INIT_VTOK          = LL_TOTAL_SUPPLY;

const LL_INIT_MC_LAMPORTS   =
  (LL_TOTAL_SUPPLY * LL_INIT_VSOL_LAMPORTS / LL_INIT_VTOK).toString();

const LL_INIT_PRICE_ETH     =
  (Number(LL_INIT_VSOL_LAMPORTS) / Number(LL_INIT_VTOK) / 1000).toFixed(15);
