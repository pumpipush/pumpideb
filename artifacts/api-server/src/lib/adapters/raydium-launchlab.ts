/**
 * raydium-launchlab.ts — Raydium LaunchLab real-time indexer.
 *
 * Strategy:
 *   1. logsSubscribe to LAUNCHLAB_PROGRAM via WebSocket
 *   2. shouldProcess matches ONLY LaunchLab-specific instructions:
 *        createLaunchpad | BuyExactIn | SellExactIn | SellExactOut | migrate
 *      (excludes "CreateTokenAccount" from Jupiter routing — avoids wasted RPC calls)
 *   3. FAST PATH for trades: decode mint / sol / tok / is_buy directly from the
 *      "Program data: <base64>" log entry (same discriminator as pump.fun TradeEvent).
 *      Broadcasts SSE price update immediately — zero extra RPC calls.
 *      Background getTransaction fills in trader address + persists full trade to DB.
 *   4. CREATE PATH: getTransaction with commitment:"confirmed" (same level as WS
 *      subscription) so the tx is already available — typical round-trip <300 ms.
 *      LaunchLab does NOT emit an Anchor CreateEvent log, so the full tx is needed
 *      for the name/symbol/mint.
 *   5. WSS FALLBACK: when all WebSocket RPC endpoints go silent, activates a
 *      30-second hotBackfill poll (getSignaturesForAddress, last 30 sigs) so new
 *      tokens appear within ~30 s even while the WSS is dead.
 *
 * TradeEvent layout (147 bytes, Anchor/Borsh):
 *   discriminator (8)   — bddb7fd34ee661ee (same namespace as pump.fun)
 *   mint         (32)   — token mint address
 *   [reserves]   (32)   — 4 × u64 fields (vSol, vTok, realSol, realTok or similar)
 *   sol_amount   (8)    — SOL transferred, in lamports
 *   tok_amount   (8)    — tokens transferred, in base units
 *   is_buy       (1)    — 1 = BuyExactIn, 0 = SellExactIn (offset 88)
 *   [remaining]  (57)   — trader pubkey + timestamp + extras
 *
 * Market cap formula (bonding curve, pre-graduation):
 *   priceEth     = solLamports / tokenAmount / 1000   (SOL per token)
 *   marketCapEth = totalSupply × solLamports / tokenAmount  (in lamports)
 */

import { eq, sql } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { emitTrade, emitNewToken } from "../tradeEmitter";
import { logger as rootLogger } from "../logger";
import { fetchSafeUriMeta } from "../safeUriFetch";
import {
  SolanaRpcIndexer,
  type LogEvent,
  type RpcTx,
} from "./solanaRpcBase";
import { bs58Decode, decodeLabCreateParamsRaw } from "./launchlabDecode";
export { decodeLabCreateParamsRaw } from "./launchlabDecode";
import { hotBackfillLaunchLabTokens } from "../launchlabBackfill";

// ── Constants ─────────────────────────────────────────────────────────────────

const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const PLATFORM          = "raydium_launchlab";
const CHAIN             = "solana";

// Anchor TradeEvent discriminator — sha256("event:TradeEvent")[0..8]
// Same discriminator namespace as pump.fun; layout differs (147 vs 113 bytes).
const TRADE_EVENT_DISC = Buffer.from("bddb7fd34ee661ee", "hex");

// ── Bonding curve constants ───────────────────────────────────────────────────
const LL_TOTAL_SUPPLY        = 1_000_000_000_000_000n;
const LL_INIT_VSOL_SOL       = "30";
const LL_INIT_VSOL_LAMPORTS  = 30_000_000_000n;
const LL_INIT_VTOK           = LL_TOTAL_SUPPLY;
const LL_INIT_MC_LAMPORTS    =
  (LL_TOTAL_SUPPLY * LL_INIT_VSOL_LAMPORTS / LL_INIT_VTOK).toString();
const LL_INIT_PRICE_ETH      =
  (Number(LL_INIT_VSOL_LAMPORTS) / Number(LL_INIT_VTOK) / 1000).toFixed(15);

const SKIP_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
]);

// ── Base58 encode (adapter-local — only needed to format mint pubkeys) ────────

const BS58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bs58Encode(bytes: Buffer | Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  const chars: string[] = [];
  while (n > 0n) { chars.unshift(BS58_ALPHA[Number(n % 58n)]!); n /= 58n; }
  let leading = 0;
  for (const b of bytes) { if (b !== 0) break; leading++; }
  return "1".repeat(leading) + chars.join("");
}

// ── TradeEvent fast-path decoder ──────────────────────────────────────────────

/**
 * Parse a LaunchLab TradeEvent from "Program data: <base64>" log lines.
 *
 * Updated layout (147 bytes) — Raydium changed the event in mid-2026:
 *   [0..7]   discriminator  bddb7fd34ee661ee
 *   [8..39]  poolAddress    LaunchLab pool/bonding-curve state account (NOT the mint)
 *   [40..71] reserves       4 × u64 (vSol, vTok, realSol, realTok)
 *   [72..79] sol_amount     lamports transferred
 *   [80..87] tok_amount     base units transferred
 *   [88]     is_buy         1 = buy, 0 = sell
 *   [89..146] trader + ts + extras
 *
 * NOTE: The mint is no longer embedded in the event. Instead bytes 8-40 hold
 * the pool state account address. The actual token mint lives at offset 205
 * within that pool state account (verified empirically Aug 2026).
 * Use getMintForPool() to resolve poolAddress → tokenMint (cached per pool).
 */
export function parseTradeEventFromLogs(
  logs: string[],
): {
  poolAddress: string;
  solLamports: string;
  tokenAmount: string;
  isBuy:       boolean;
} | null {
  // Instruction log gives us a reliable is_buy signal even if byte 88 is ambiguous.
  const instrBuy  = logs.some(l => /Instruction:\s*BuyExactIn/i.test(l));
  const instrSell = logs.some(l => /Instruction:\s*(SellExactIn|SellExactOut)/i.test(l));
  if (!instrBuy && !instrSell) return null;
  const isBuyFromLog = instrBuy && !instrSell;

  const PREFIX = "Program data: ";
  for (const log of logs) {
    if (!log.startsWith(PREFIX)) continue;
    try {
      const raw = Buffer.from(log.slice(PREFIX.length), "base64");
      if (raw.length < 89) continue;
      if (!raw.subarray(0, 8).equals(TRADE_EVENT_DISC)) continue;

      // Bytes 8-40 = pool state account (post-2026 layout change)
      const poolAddress = bs58Encode(raw.subarray(8, 40));
      const solLamports = raw.readBigUInt64LE(72).toString();
      const tokenAmount = raw.readBigUInt64LE(80).toString();

      // Sanity: skip zero-amount events
      if (solLamports === "0" || tokenAmount === "0") continue;

      // Cross-check byte-88 with instruction log (robustness)
      const isBuyFromEvent = raw[88] === 1;
      const isBuy = isBuyFromLog ?? isBuyFromEvent;

      return { poolAddress, solLamports, tokenAmount, isBuy };
    } catch { continue; }
  }
  return null;
}

// ── Indexer ───────────────────────────────────────────────────────────────────

// Pool state account layout (Raydium LaunchLab, 429 bytes):
//   offset 205..236 — token mint address (32 bytes)
// Verified Aug 2026 by comparing pool 6mgg1Afs… with Low Cortisol mint HxfH5ai9…
const POOL_MINT_OFFSET = 205;

export class RaydiumLaunchLabIndexer extends SolanaRpcIndexer {
  /**
   * Active interval when the WSS is believed to be dead.
   * Started 30 s after the first WSS disconnect; cleared on recovery.
   */
  private _pollFallbackTimer:   ReturnType<typeof setInterval> | null = null;
  /**
   * Pending timer: gives the WSS 30 s to reconnect before starting the poll.
   * Cancelled by onEventReceived() if any WS event arrives before the 30 s elapses.
   */
  private _pollFallbackPending: ReturnType<typeof setTimeout>  | null = null;

  /**
   * Pool-address → token-mint cache.
   * Populated on first trade for each pool via getAccountInfo (one call per pool lifetime).
   * Subsequent trades for the same pool are instant cache lookups with zero RPC calls.
   */
  private _poolMintCache = new Map<string, string>();

  /**
   * Resolve the actual SPL token mint from a LaunchLab pool state account.
   *
   * Raydium's 2026 TradeEvent change removed the mint from event bytes 8-40,
   * replacing it with the pool state account address. The mint lives at offset
   * POOL_MINT_OFFSET (205) within that 429-byte pool state account.
   *
   * Results are cached permanently (a pool's mint never changes).
   */
  private async getMintForPool(poolAddress: string): Promise<string | null> {
    const cached = this._poolMintCache.get(poolAddress);
    if (cached) return cached;

    try {
      // Always use free public RPCs for HTTP calls — never Alchemy (costs CUs).
      const rpcUrl = "https://solana-rpc.publicnode.com";

      const resp = await fetch(rpcUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method:  "getAccountInfo",
          params:  [poolAddress, { encoding: "base64" }],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const j = await resp.json() as { result?: { value?: { data?: [string, string] } | null } };
      const data64 = j.result?.value?.data?.[0];
      if (!data64) return null;

      const buf = Buffer.from(data64, "base64");
      if (buf.length < POOL_MINT_OFFSET + 32) return null;

      const mintBytes = buf.subarray(POOL_MINT_OFFSET, POOL_MINT_OFFSET + 32);
      const mint      = bs58Encode(mintBytes);
      if (SKIP_MINTS.has(mint)) return null;

      this._poolMintCache.set(poolAddress, mint);
      this.log.debug({ poolAddress, mint }, "raydium_launchlab: pool→mint resolved and cached");
      return mint;
    } catch (err) {
      this.log.warn({ poolAddress, err }, "raydium_launchlab: getMintForPool failed");
      return null;
    }
  }

  constructor(opts?: { wssUrl?: string }) {
    super({
      programId:   LAUNCHLAB_PROGRAM,
      adapterName: "raydium_launchlab",
      // 5-minute watchdog — LaunchLab creates ~100 tokens/day (low volume vs pump.fun),
      // so we tolerate longer silences before concluding the connection is dead.
      watchdogMs: 300_000,
      wssUrl:     opts?.wssUrl,
    });
  }

  /**
   * Override stop() to also cancel LaunchLab-specific HTTP poll fallback timers.
   * Without this, an active poll interval or pending start timer would keep running
   * and could trigger getAccountInfo / getSignaturesForAddress calls after the WS is closed.
   */
  override stop(): void {
    this._stopPollFallback();
    super.stop();
  }

  private _startPollFallback(): void {
    if (this._pollFallbackTimer) return; // already active
    this.log.warn(
      "raydium_launchlab: activating HTTP hot-backfill poll (30 s interval) for missed creates",
    );
    void hotBackfillLaunchLabTokens().catch(() => {}); // immediate first pass
    this._pollFallbackTimer = setInterval(() => {
      void hotBackfillLaunchLabTokens().catch(() => {});
    }, 30_000);
  }

  private _stopPollFallback(): void {
    if (this._pollFallbackPending !== null) {
      clearTimeout(this._pollFallbackPending);
      this._pollFallbackPending = null;
    }
    if (this._pollFallbackTimer !== null) {
      clearInterval(this._pollFallbackTimer);
      this._pollFallbackTimer = null;
      this.log.info("raydium_launchlab: WSS recovered — HTTP poll fallback deactivated");
    }
  }

  /**
   * Cancels the pending 30 s start timer AND any active poll interval the moment
   * the WSS delivers any valid event.  This is the primary recovery path —
   * onRpcRecovered() only fires when _fallbackActive is true (all-RPC-exhausted).
   */
  protected override onEventReceived(): void {
    this._stopPollFallback();
  }

  /**
   * Fires as soon as an established WSS connection drops.  Waits 30 s before
   * starting the poll fallback so brief reconnects don't trigger it; if the WSS
   * comes back and delivers events within that window, onEventReceived() cancels
   * the pending start.
   */
  protected override onWssDisconnected(): void {
    if (this._pollFallbackTimer || this._pollFallbackPending) return;
    this._pollFallbackPending = setTimeout(() => {
      this._pollFallbackPending = null;
      this._startPollFallback();
    }, 30_000);
  }

  /**
   * Activated when every WSS endpoint completes a full silent rotation (last
   * resort — normally onWssDisconnected fires first and starts the poll much
   * sooner).
   */
  protected override onAllRpcsExhausted(): void {
    this._startPollFallback();
  }

  /** Deactivates the HTTP poll fallback the moment the WSS delivers events again. */
  protected override onRpcRecovered(): void {
    this._stopPollFallback();
  }

  /**
   * Filter to LaunchLab-specific instruction names only.
   *
   * IMPORTANT: "CreateTokenAccount" (from Jupiter routing) must NOT match here —
   * it looks like a "create" but is just a user opening a token account before
   * buying.  The old regex `/create|buy|sell/i` was triggering on it and causing
   * a wasted getTransaction call per Jupiter trade.
   */
  protected override shouldProcess(logs: string[]): boolean {
    return logs.some((l) =>
      /Instruction:\s*createLaunchpad/i.test(l) ||
      /Instruction:\s*(BuyExactIn|SellExactIn|SellExactOut)/i.test(l) ||
      /Instruction:\s*migrate/i.test(l),
    );
  }

  protected override async onEvent(event: LogEvent): Promise<void> {
    const { logs } = event;

    // Migration trumps everything
    if (logs.some((l) => /Instruction:\s*migrate/i.test(l))) {
      await this.handleGraduation(event);
      return;
    }

    const isCreate = logs.some(l => /Instruction:\s*createLaunchpad/i.test(l));
    const isTrade  = logs.some(l =>
      /Instruction:\s*(BuyExactIn|SellExactIn|SellExactOut)/i.test(l));

    // A single tx can create AND immediately buy — handle both.
    // Create first so the token row exists before the trade is inserted.
    if (isCreate) await this.handleCreate(event);
    if (isTrade)  await this.handleTrade(event);
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  private async handleCreate(event: LogEvent): Promise<void> {
    const { signature } = event;

    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    const mint = this.extractNewMint(tx);
    if (!mint || SKIP_MINTS.has(mint)) {
      this.log.debug({ signature }, "raydium_launchlab: create — no new mint, skip");
      return;
    }

    const creatorAddress = this.extractSigner(tx);
    const params = this._decodeCreateParams(tx);
    const name   = params?.name   ?? mint.slice(0, 8) + "…";
    const symbol = params?.symbol ?? "???";
    const uri    = params?.uri    ?? null;

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

    // Broadcast to live feed — wait up to 3 s for image, then broadcast anyway
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
            const upd: Record<string, string | null> = {};
            if (meta.imageUrl)    upd["imageUrl"]    = meta.imageUrl;
            if (meta.description) upd["description"] = meta.description;
            if (meta.twitterUrl)  upd["twitterUrl"]  = meta.twitterUrl;
            if (meta.telegramUrl) upd["telegramUrl"] = meta.telegramUrl;
            if (meta.websiteUrl)  upd["websiteUrl"]  = meta.websiteUrl;
            if (Object.keys(upd).length > 0) {
              await db.update(tokensTable).set(upd).where(eq(tokensTable.address, mint));
            }
          }
          const imageUrl = meta?.imageUrl ?? null;
          if (!done) { done = true; broadcast(imageUrl); }
          else if (imageUrl) broadcast(imageUrl);
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
    const { signature, logs } = event;

    // ── FAST PATH: decode from "Program data:" log ───────────────────────
    // Since Raydium's 2026 TradeEvent change, bytes 8-40 hold the pool state
    // account address (not the mint).  getMintForPool() resolves the actual
    // token mint from that pool account — cached after the first lookup so
    // subsequent trades on the same token cost zero extra RPC calls.
    const fast = parseTradeEventFromLogs(logs);

    if (fast) {
      const { poolAddress, solLamports, tokenAmount, isBuy } = fast;

      const mint = await this.getMintForPool(poolAddress);
      if (!mint) {
        this.log.warn({ poolAddress, signature }, "raydium_launchlab: could not resolve mint from pool state — skipping trade");
        return;
      }

      // Guard: require at least 1 000 atomic units (~0.001 display tokens) to
      // prevent dust trades (e.g. 1 atom sold for 0.195 SOL) from producing
      // astronomically wrong prices (195 030 SOL/token in one real case).
      const MIN_PRICE_ATOMS = 1_000n;
      const tokBig = BigInt(tokenAmount);
      const priceEth = tokBig >= MIN_PRICE_ATOMS && solLamports !== "0"
        ? (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15)
        : null;

      const updMCStr = tokBig >= MIN_PRICE_ATOMS && solLamports !== "0"
        ? (LL_TOTAL_SUPPLY * BigInt(solLamports) / tokBig).toString()
        : undefined;

      // ── Ensure token row exists (auto-create if we missed the create event) ─
      const [existing] = await db
        .select({ id: tokensTable.id })
        .from(tokensTable)
        .where(eq(tokensTable.address, mint))
        .limit(1);

      if (!existing) {
        this.log.warn({ mint }, "raydium_launchlab: first trade for unknown mint — auto-creating placeholder");
        await db.insert(tokensTable).values({
          address:              mint,
          name:                 mint.slice(0, 8) + "…",
          symbol:               "???",
          description:          null,
          imageUrl:             null,
          creatorAddress:       "unknown",
          totalSupply:          LL_TOTAL_SUPPLY.toString(),
          virtualTokenReserves: LL_INIT_VTOK.toString(),
          virtualEthReserves:   LL_INIT_VSOL_SOL,
          marketCapEth:         updMCStr ?? LL_INIT_MC_LAMPORTS,
          priceEth:             priceEth ?? LL_INIT_PRICE_ETH,
          platform:             PLATFORM,
          chain:                CHAIN,
        }).onConflictDoNothing();

        emitNewToken({
          type: "newToken",
          token: {
            address:      mint,
            name:         mint.slice(0, 8) + "…",
            symbol:       "???",
            imageUrl:     null,
            priceEth:     priceEth ?? LL_INIT_PRICE_ETH,
            marketCapEth: updMCStr ?? LL_INIT_MC_LAMPORTS,
            platform:     PLATFORM,
            chain:        CHAIN,
            createdAt:    new Date().toISOString(),
          },
        });
      }

      // ── Dust trade guard ─────────────────────────────────────────────────
      // Trades with fewer than MIN_PRICE_ATOMS (~0.001 display tokens) OR
      // fewer than MIN_SOL_LAMPORTS SOL are atomically meaningless: they
      // corrupt price/MC and add noise to trade history, volume stats, and
      // holder positions.  Token row was still auto-created above when
      // missing — that placeholder is legitimate.
      const MIN_SOL_LAMPORTS = 10_000n; // 0.00001 SOL ≈ $0.002
      const solBig = BigInt(solLamports);
      if (tokBig < MIN_PRICE_ATOMS || solBig < MIN_SOL_LAMPORTS) {
        this.log.debug({ mint, tokenAmount, solLamports },
          "raydium_launchlab: fast-path dust trade skipped (tokenAmount < MIN_PRICE_ATOMS or solLamports < MIN_SOL_LAMPORTS)");
        return;
      }

      // ── Update token price + market cap immediately ───────────────────────
      await db.update(tokensTable).set({
        tradeCount: sql`${tokensTable.tradeCount} + 1`,
        volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
        ...(priceEth  ? { priceEth }                   : {}),
        ...(updMCStr  ? { marketCapEth: updMCStr }      : {}),
      }).where(eq(tokensTable.address, mint));

      // ── Immediate SSE broadcast ───────────────────────────────────────────
      const [tokenRow] = await db
        .select({
          name:         tokensTable.name,
          symbol:       tokensTable.symbol,
          marketCapEth: tokensTable.marketCapEth,
          volumeEth:    tokensTable.volumeEth,
          tradeCount:   tokensTable.tradeCount,
          virtualEthReserves:   tokensTable.virtualEthReserves,
          virtualTokenReserves: tokensTable.virtualTokenReserves,
        })
        .from(tokensTable)
        .where(eq(tokensTable.address, mint))
        .limit(1);

      // Broadcast SSE now — trader address fills in below from background getTransaction
      const broadcastTrade = (tradeId: number | null, traderAddress: string) => {
        emitTrade({
          type: "trade",
          trade: {
            id:            tradeId ?? 0,
            tokenAddress:  mint,
            traderAddress,
            isBuy,
            ethAmount:     solLamports,
            tokenAmount,
            priceEth,
            txHash:        signature,
            platform:      PLATFORM,
            timestamp:     new Date().toISOString(),
          },
          token: {
            address:              mint,
            name:                 tokenRow?.name     ?? null,
            symbol:               tokenRow?.symbol   ?? null,
            priceEth,
            marketCapEth:         tokenRow?.marketCapEth ?? updMCStr ?? null,
            volumeEth:            tokenRow?.volumeEth    ?? solLamports,
            virtualEthReserves:   tokenRow?.virtualEthReserves   ?? LL_INIT_VSOL_SOL,
            virtualTokenReserves: tokenRow?.virtualTokenReserves ?? LL_INIT_VTOK.toString(),
            tradeCount:           Number(tokenRow?.tradeCount ?? 1),
            platform:             PLATFORM,
            chain:                CHAIN,
          },
        });
      };

      // Broadcast immediately with placeholder trader — background fills the real one
      broadcastTrade(null, "pending");

      // ── Background: getTransaction → persist full trade record ────────────
      void this.getTransaction(signature).then(async (tx) => {
        if (!tx || tx.meta?.err) return;
        const traderAddress = this.extractSigner(tx);

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

        if (!trade) return; // duplicate

        // Update virtual reserves from on-chain state (constant-product estimate)
        try {
          const [cur] = await db
            .select({ virtualEthReserves: tokensTable.virtualEthReserves,
                      virtualTokenReserves: tokensTable.virtualTokenReserves })
            .from(tokensTable)
            .where(eq(tokensTable.address, mint))
            .limit(1);

          const vSolSol  = parseFloat(cur?.virtualEthReserves   ?? LL_INIT_VSOL_SOL);
          const vTokAtom = BigInt(cur?.virtualTokenReserves ?? LL_INIT_VTOK.toString());
          const solLam   = BigInt(solLamports);
          const oldVSolLam = BigInt(Math.round(vSolSol * 1e9));
          const k          = oldVSolLam * vTokAtom;
          const newVSolLam = isBuy
            ? oldVSolLam + solLam
            : oldVSolLam > solLam ? oldVSolLam - solLam : oldVSolLam;

          if (newVSolLam > 0n) {
            const newVTok  = k / newVSolLam;
            const vSolStr  = (Number(newVSolLam) / 1e9).toFixed(6).replace(/\.?0+$/, "");
            // Auto-detect graduation: LaunchLab graduates at 85 SOL raised above
            // the 30 SOL virtual floor, i.e. vSol > 115 SOL total.
            const graduatedNow = Number(newVSolLam) / 1e9 > 115;
            await db.update(tokensTable).set({
              virtualEthReserves:   vSolStr,
              virtualTokenReserves: newVTok.toString(),
              ...(graduatedNow ? { graduated: true } : {}),
            }).where(eq(tokensTable.address, mint));
          }
        } catch { /* non-critical — keep existing reserves */ }

        this.log.debug({ mint, isBuy, sol: solLamports, trader: traderAddress },
          "raydium_launchlab: trade persisted");
      }).catch((err: unknown) => {
        this.log.warn({ err, signature }, "raydium_launchlab: background getTransaction failed");
      });

      this.log.debug({ mint, isBuy, sol: solLamports }, "raydium_launchlab: trade fast-path");
      return;
    }

    // ── FALLBACK: full getTransaction path ────────────────────────────────────
    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    const swap = this.parseSwap(tx);
    if (!swap) return;

    const { mint, isBuy, solLamports, tokenAmount, traderAddress } = swap;

    // Guard: minimum 1 000 atoms to prevent dust trades from corrupting price
    const MIN_PRICE_ATOMS = 1_000n;
    const tokBig = BigInt(tokenAmount);
    const priceEth = tokBig >= MIN_PRICE_ATOMS && solLamports !== "0"
      ? (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15)
      : null;

    // Auto-create token if missed the create event
    const [existing] = await db
      .select({ id: tokensTable.id })
      .from(tokensTable)
      .where(eq(tokensTable.address, mint))
      .limit(1);

    if (!existing) {
      this.log.warn({ mint }, "raydium_launchlab: fallback — auto-creating placeholder token");
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

    // ── Dust trade guard (fallback path) ─────────────────────────────────────
    // Same thresholds as fast path: skip INSERT + token stats for atomically
    // tiny token or SOL amounts.  Token placeholder was still created above.
    const MIN_SOL_LAMPORTS = 10_000n; // 0.00001 SOL ≈ $0.002
    const solBig = BigInt(solLamports);
    if (tokBig < MIN_PRICE_ATOMS || solBig < MIN_SOL_LAMPORTS) {
      this.log.debug({ mint, tokenAmount, solLamports },
        "raydium_launchlab: fallback dust trade skipped (tokenAmount < MIN_PRICE_ATOMS or solLamports < MIN_SOL_LAMPORTS)");
      return;
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
      platform:      PLATFORM,
      timestamp:     new Date(),
    }).onConflictDoNothing().returning();

    if (!trade) return;

    let updMCStr:  string | undefined;
    let updVSolStr: string | undefined;
    let updVTokStr: string | undefined;

    if (tokBig >= MIN_PRICE_ATOMS && solLamports !== "0") {
      updMCStr = (LL_TOTAL_SUPPLY * BigInt(solLamports) / tokBig).toString();
      try {
        const [cur] = await db
          .select({ virtualEthReserves: tokensTable.virtualEthReserves,
                    virtualTokenReserves: tokensTable.virtualTokenReserves })
          .from(tokensTable)
          .where(eq(tokensTable.address, mint))
          .limit(1);
        const vSolSol    = parseFloat(cur?.virtualEthReserves   ?? LL_INIT_VSOL_SOL);
        const vTokAtom   = BigInt(cur?.virtualTokenReserves ?? LL_INIT_VTOK.toString());
        const solLam     = BigInt(solLamports);
        const oldVSolLam = BigInt(Math.round(vSolSol * 1e9));
        const k          = oldVSolLam * vTokAtom;
        const newVSolLam = isBuy
          ? oldVSolLam + solLam
          : oldVSolLam > solLam ? oldVSolLam - solLam : oldVSolLam;
        if (newVSolLam > 0n) {
          updVSolStr = (Number(newVSolLam) / 1e9).toFixed(6).replace(/\.?0+$/, "");
          updVTokStr = (k / newVSolLam).toString();
        }
      } catch { /* keep existing */ }
    }

    // Auto-detect graduation from updated reserves
    const newVSolNum = updVSolStr ? parseFloat(updVSolStr) : null;
    const graduatedNow = newVSolNum !== null && newVSolNum > 115;

    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
      ...(priceEth      ? { priceEth }                           : {}),
      ...(updMCStr      ? { marketCapEth: updMCStr }             : {}),
      ...(updVSolStr    ? { virtualEthReserves:  updVSolStr }    : {}),
      ...(updVTokStr    ? { virtualTokenReserves: updVTokStr }   : {}),
      ...(graduatedNow  ? { graduated: true }                    : {}),
    }).where(eq(tokensTable.address, mint));

    const [tokenRow] = await db
      .select({
        name: tokensTable.name, symbol: tokensTable.symbol,
        marketCapEth: tokensTable.marketCapEth, volumeEth: tokensTable.volumeEth,
        virtualEthReserves: tokensTable.virtualEthReserves,
        virtualTokenReserves: tokensTable.virtualTokenReserves,
        tradeCount: tokensTable.tradeCount,
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
        name:                 tokenRow?.name     ?? null,
        symbol:               tokenRow?.symbol   ?? null,
        priceEth,
        marketCapEth:         tokenRow?.marketCapEth ?? updMCStr ?? null,
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
   * Decode name / symbol / uri from a LaunchLab createLaunchpad instruction.
   * Delegates to the shared decodeLabCreateParamsRaw (launchlabDecode.ts) so
   * offset probing and validation logic live in exactly one place.
   */
  private _decodeCreateParams(tx: RpcTx): { name: string; symbol: string; uri: string } | null {
    const keys   = tx.transaction?.message?.accountKeys   ?? [];
    const instrs = tx.transaction?.message?.instructions  ?? [];

    const progIdx = keys.findIndex(
      (k) => (typeof k === "string" ? k : (k as { pubkey?: string }).pubkey) === LAUNCHLAB_PROGRAM,
    );
    if (progIdx < 0) return null;

    const instr = instrs.find((i) => i.programIdIndex === progIdx);
    if (!instr?.data) return null;

    try {
      const raw = bs58Decode(instr.data);
      if (raw.length < 12) return null;
      return decodeLabCreateParamsRaw(raw);
    } catch {
      return null;
    }
  }

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

// decodeLabCreateParamsRaw is re-exported at the top of this file via:
//   export { decodeLabCreateParamsRaw } from "./launchlabDecode";
