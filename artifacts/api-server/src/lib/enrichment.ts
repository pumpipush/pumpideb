/**
 * Background token enrichment loop.
 *
 * Tokens inserted by chain-native indexers may race ahead of upstream metadata
 * APIs, landing in the DB with placeholder names/symbols or missing images.
 *
 * The loop runs every 30 s and processes two independent batches per tick:
 *
 * 1. IDENTITY BATCH — tokens with placeholder name ("A6BE4K8L…" / "A6BE4K8L...")
 *    or symbol ("???"). Ordered by createdAt DESC so the freshest tokens are
 *    retried first. No time-window limit — retried until resolved.
 *
 * 2. IMAGE BATCH — tokens that already have a real name/symbol but still have
 *    no imageUrl, created within IMAGE_RETRY_WINDOW_MS. After that window the
 *    token is considered done without an image (platform may simply have none).
 *    This prevents a permanent backlog of image-less records from consuming
 *    every tick and starving new identity-placeholder tokens.
 *
 * Metadata sources:
 *   pump_fun           → https://frontend-api.pump.fun/coins/{mint}
 *   raydium_launchlab  → https://api-v3.raydium.io/mint/ids?mints={mint}
 *   letsbonk           → https://api-v3.raydium.io/mint/ids?mints={mint}
 *   daos_fun           → https://api-v3.raydium.io/mint/ids?mints={mint}
 */

import { and, desc, gte, isNull, like, or, not, eq, inArray, sql, gt } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { logger } from "./logger";
import { emitSnapshot } from "./tradeEmitter";
import { registerGraduatedMint } from "./adapters/raydium-amm";

const POLL_INTERVAL_MS       = 30_000;
const IDENTITY_BATCH_SIZE    = 20;  // max tokens per identity tick
const IMAGE_BATCH_SIZE       = 10;  // max tokens per image tick
const IMAGE_RETRY_WINDOW_MS  = 2 * 60 * 60 * 1_000; // 2 hours — stop retrying image after this

const log = logger.child({ module: "enrichment" });

// Platforms for which we have a metadata provider.
// Only records from these platforms enter the enrichment queue.
// moonshot uses DEXScreener data which already has metadata at insert time.
const ENRICHABLE_PLATFORMS = ["pump_fun", "raydium_launchlab", "letsbonk", "daos_fun"] as const;

// ── Pump.fun metadata ──────────────────────────────────────────────────────────

interface PumpCoin {
  name?:      string;
  symbol?:    string;
  image_uri?: string;
}

async function fetchPumpMeta(mint: string): Promise<PumpCoin | null> {
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      signal:  AbortSignal.timeout(8_000),
      headers: { "User-Agent": "RocketFi/1.0" },
    });
    if (!res.ok) return null;
    return (await res.json()) as PumpCoin;
  } catch {
    return null;
  }
}

// ── Raydium metadata (generic Solana token metadata) ──────────────────────────

interface RaydiumItem {
  name?:    string;
  symbol?:  string;
  logoURI?: string;
}

async function fetchRaydiumMeta(mint: string): Promise<RaydiumItem | null> {
  try {
    const res = await fetch(
      `https://api-v3.raydium.io/mint/ids?mints=${mint}`,
      { signal: AbortSignal.timeout(8_000), headers: { "User-Agent": "RocketFi/1.0" } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: RaydiumItem[] };
    return body.data?.[0] ?? null;
  } catch {
    return null;
  }
}

// ── Placeholder detection ──────────────────────────────────────────────────────

/** True when name is a truncated mint address placeholder.
 *  Supports Unicode "…" (pump_fun, raydium_launchlab, daos_fun)
 *  and ASCII "..." (letsbonk).
 *  Exported for unit testing. */
export function isPlaceholderName(name: string): boolean {
  return name.endsWith("…") || name.endsWith("...");
}

/** Exported for unit testing. */
export function isPlaceholderSymbol(symbol: string): boolean {
  return symbol === "???";
}

/** The set of platforms the enrichment loop processes.
 *  Exported so tests can verify no other platforms are silently included. */
export const ENRICHABLE_PLATFORMS_EXPORT = ENRICHABLE_PLATFORMS;

// ── Per-platform metadata fetch ────────────────────────────────────────────────

interface EnrichResult {
  name?:     string;
  symbol?:   string;
  imageUrl?: string | null;
}

async function fetchMeta(mint: string, platform: string): Promise<EnrichResult | null> {
  if (platform === "pump_fun") {
    // Primary: pump.fun API (may be blocked/rate-limited from hosted environments)
    const pump = await fetchPumpMeta(mint);
    if (pump) return { name: pump.name, symbol: pump.symbol, imageUrl: pump.image_uri ?? null };

    // Fallback: Raydium's /mint/ids works for any SPL token, including pump.fun tokens
    // that have been indexed after launch. Brand-new tokens won't appear here yet
    // but tokens a few minutes old often do.
    const ray = await fetchRaydiumMeta(mint);
    if (ray) return { name: ray.name, symbol: ray.symbol, imageUrl: ray.logoURI ?? null };

    return null;
  }

  if (
    platform === "raydium_launchlab" ||
    platform === "letsbonk" ||
    platform === "daos_fun"
  ) {
    // Raydium's /mint/ids endpoint provides generic Solana token metadata
    // for any SPL token, used as the common enrichment source for all
    // Solana platforms other than pump_fun.
    const meta = await fetchRaydiumMeta(mint);
    if (!meta) return null;
    return { name: meta.name, symbol: meta.symbol, imageUrl: meta.logoURI ?? null };
  }

  return null;
}

// ── Update computation (pure — exported for testing) ──────────────────────────

interface TokenRow {
  address:  string;
  name:     string;
  symbol:   string;
  imageUrl: string | null;
  platform: string;
}

/**
 * Given the current token state and a metadata response from an upstream API,
 * return the fields that should be written to the DB, or null if nothing
 * has improved.
 *
 * Rules:
 *  - Only overwrite name/symbol when the current value is a placeholder AND
 *    the API returned a real (non-placeholder) value.
 *  - Only write imageUrl when the current value is null AND the API returned
 *    a non-null, non-empty string.
 *
 * Exported for unit testing.
 */
export function computeEnrichmentUpdate(
  token: Pick<TokenRow, "name" | "symbol" | "imageUrl">,
  meta:  EnrichResult,
): Record<string, string> | null {
  const newName   = meta.name   && !isPlaceholderName(meta.name)    ? meta.name   : null;
  const newSymbol = meta.symbol && !isPlaceholderSymbol(meta.symbol) ? meta.symbol : null;
  const newImage  = meta.imageUrl ? meta.imageUrl : null;

  const update: Record<string, string> = {};
  if (newName   && isPlaceholderName(token.name))     update["name"]     = newName;
  if (newSymbol && isPlaceholderSymbol(token.symbol)) update["symbol"]   = newSymbol;
  if (newImage  && token.imageUrl == null)             update["imageUrl"] = newImage;

  return Object.keys(update).length > 0 ? update : null;
}

// ── Enrich a single token ──────────────────────────────────────────────────────

async function enrichOne(token: TokenRow): Promise<void> {
  const meta = await fetchMeta(token.address, token.platform);
  if (!meta) return; // upstream API not ready yet

  const update = computeEnrichmentUpdate(token, meta);
  if (!update) return;

  const [updated] = await db
    .update(tokensTable)
    .set(update)
    .where(eq(tokensTable.address, token.address))
    .returning();

  log.info(
    { address: token.address, platform: token.platform, ...update },
    "enrichment: token enriched",
  );

  // Push the enriched state to any open SSE detail-page viewers so the
  // name / symbol / image update live without a page refresh.
  if (updated) {
    emitSnapshot({
      type: "snapshot",
      token: {
        address:              updated.address,
        name:                 updated.name,
        symbol:               updated.symbol,
        imageUrl:             updated.imageUrl,
        priceEth:             updated.priceEth,
        marketCapEth:         updated.marketCapEth,
        volumeEth:            updated.volumeEth,
        virtualEthReserves:   updated.virtualEthReserves,
        virtualTokenReserves: updated.virtualTokenReserves,
        tradeCount:           Number(updated.tradeCount),
        platform:             updated.platform,
        chain:                updated.chain,
      },
    });
  }
}

// ── Main enrichment tick ───────────────────────────────────────────────────────

async function enrichTick(): Promise<void> {
  try {
    // ── Batch 1: Identity placeholders (name/symbol) ─────────────────────────
    // Ordered newest-first (DESC) so a freshly indexed token is always within
    // the first IDENTITY_BATCH_SIZE rows, even when many older stuck records
    // exist that the upstream API has never resolved. This guarantees new tokens
    // are enriched promptly regardless of backlog size.
    const identityTokens = await db
      .select({
        address:  tokensTable.address,
        name:     tokensTable.name,
        symbol:   tokensTable.symbol,
        imageUrl: tokensTable.imageUrl,
        platform: tokensTable.platform,
      })
      .from(tokensTable)
      .where(
        and(
          inArray(tokensTable.platform, [...ENRICHABLE_PLATFORMS]),
          or(
            like(tokensTable.name,   "%…"),
            like(tokensTable.name,   "%..."),
            like(tokensTable.symbol, "???"),
          ),
        ),
      )
      .orderBy(desc(tokensTable.createdAt)) // newest-first: new tokens never starved by old backlog
      .limit(IDENTITY_BATCH_SIZE);

    // ── Batch 2: Missing image (separate concern, time-bounded) ──────────────
    // Only tokens created within IMAGE_RETRY_WINDOW_MS that already have a
    // real identity (name+symbol resolved). After the window expires a token
    // is treated as done-without-image to prevent stale no-image records from
    // permanently consuming batch slots.
    const imageWindowStart = new Date(Date.now() - IMAGE_RETRY_WINDOW_MS);
    const imageTokens = await db
      .select({
        address:  tokensTable.address,
        name:     tokensTable.name,
        symbol:   tokensTable.symbol,
        imageUrl: tokensTable.imageUrl,
        platform: tokensTable.platform,
      })
      .from(tokensTable)
      .where(
        and(
          inArray(tokensTable.platform, [...ENRICHABLE_PLATFORMS]),
          isNull(tokensTable.imageUrl),
          gte(tokensTable.createdAt, imageWindowStart),
          // Exclude tokens that still have placeholder identity — they're
          // already in the identity batch above and will get image enriched there
          not(like(tokensTable.name,   "%…")),
          not(like(tokensTable.name,   "%...")),
          not(like(tokensTable.symbol, "???")),
        ),
      )
      .orderBy(tokensTable.createdAt)
      .limit(IMAGE_BATCH_SIZE);

    const total = identityTokens.length + imageTokens.length;
    if (total === 0) return;

    log.info(
      { identity: identityTokens.length, image: imageTokens.length },
      "enrichment: processing unenriched tokens",
    );

    const allTokens = [...identityTokens, ...imageTokens];
    const results = await Promise.allSettled(allTokens.map(enrichOne));

    const errors = results.filter((r) => r.status === "rejected");
    if (errors.length > 0) {
      log.warn({ count: errors.length }, "enrichment: some tokens failed this tick");
    }
  } catch (err) {
    log.error({ err }, "enrichment: tick error");
  }
}

// ── Bonding curve backfill ─────────────────────────────────────────────────────
// Runs once on startup. For pump.fun tokens whose virtualEthReserves was never
// updated from trade data (stuck at the initial "30" SOL), replays all their
// DB trades using the constant-product formula to compute current state.
//
// For a constant-product AMM: vSol × vTok = k (invariant).
// Since each buy/sell moves SOL linearly: finalVSol = 30e9 + Σbuys − Σsells.
// Then finalVTok = k₀ / finalVSol,  MC = totalSupply × finalVSol / finalVTok.

const PUMP_INIT_VSOL_LAM = 30_000_000_000n;
const PUMP_INIT_VTOK     = 1_073_000_191_045_000n;
const PUMP_TOTAL_SUPPLY  = 1_000_000_000_000_000n;
const PUMP_K0            = PUMP_INIT_VSOL_LAM * PUMP_INIT_VTOK;

async function backfillBondingCurves(): Promise<void> {
  // Tokens that still have the initial reserves despite having trades.
  // Graduated tokens are excluded: the bonding-curve constant-product formula
  // is invalid after migration to Raydium/PumpSwap, so replaying their trades
  // would produce wrong reserve values and corrupt the displayed market cap.
  const stale = await db
    .select({ address: tokensTable.address, tradeCount: tokensTable.tradeCount })
    .from(tokensTable)
    .where(
      and(
        eq(tokensTable.platform, "pump_fun"),
        eq(tokensTable.graduated, false),
        eq(tokensTable.virtualEthReserves, "30"),
        sql`${tokensTable.tradeCount}::int > 0`,
      ),
    )
    .limit(500);

  if (stale.length === 0) return;
  log.info({ count: stale.length }, "enrichment: backfilling bonding curve reserves");

  for (const token of stale) {
    try {
      // Aggregate net SOL for this token: positive = bought in, negative = sold out
      const [agg] = await db
        .select({
          netLamports: sql<string>`
            SUM(CASE WHEN ${tradesTable.isBuy} THEN CAST(${tradesTable.ethAmount} AS NUMERIC)
                     ELSE -CAST(${tradesTable.ethAmount} AS NUMERIC) END)
          `,
        })
        .from(tradesTable)
        .where(eq(tradesTable.tokenAddress, token.address));

      const netLam = BigInt(Math.round(Number(agg?.netLamports ?? "0")));
      const newVSolLam = PUMP_INIT_VSOL_LAM + netLam;
      if (newVSolLam <= 0n) continue;

      const newVTok    = PUMP_K0 / newVSolLam;
      const newMC      = PUMP_TOTAL_SUPPLY * newVSolLam / newVTok;
      const newVSolStr = (Number(newVSolLam) / 1e9).toFixed(6).replace(/\.?0+$/, "");

      await db.update(tokensTable).set({
        virtualEthReserves:   newVSolStr,
        virtualTokenReserves: newVTok.toString(),
        marketCapEth:         newMC.toString(),
      }).where(eq(tokensTable.address, token.address));
    } catch (err) {
      log.warn({ address: token.address, err }, "enrichment: backfill failed for token");
    }
  }

  log.info({ count: stale.length }, "enrichment: bonding curve backfill complete");
}

// ── Graduation detection ───────────────────────────────────────────────────────
// Periodically checks pump.fun tokens still marked graduated=false that have
// significant trade activity. Uses DexScreener to confirm they have a
// PumpSwap/Raydium pool (i.e. they graduated but the migration event was missed).

const GRADUATION_DETECT_INTERVAL_MS = 5 * 60_000; // every 5 minutes
const GRADUATION_DETECT_BATCH       = 20;          // mints per DexScreener call
const GRADUATION_DEX_IDS = new Set(["pumpswap", "raydium", "raydium-clmm", "raydium-cp"]);

interface DexScreenerPair { dexId: string; baseToken: { address: string } }
interface DexScreenerResponse { pairs: DexScreenerPair[] | null }

async function detectGraduations(): Promise<void> {
  // Find pump.fun tokens with significant trade activity still marked ungraduated.
  // tradeCount > 50 avoids wasting API calls on brand-new tokens.
  const candidates = await db
    .select({ address: tokensTable.address })
    .from(tokensTable)
    .where(
      and(
        eq(tokensTable.platform, "pump_fun"),
        eq(tokensTable.graduated, false),
        sql`${tokensTable.tradeCount}::int > 50`,
      ),
    )
    .orderBy(desc(tokensTable.tradeCount))
    .limit(60);

  if (candidates.length === 0) return;

  const newly: string[] = [];

  // DexScreener supports up to ~30 mints per request, comma-separated.
  for (let i = 0; i < candidates.length; i += GRADUATION_DETECT_BATCH) {
    const batch = candidates.slice(i, i + GRADUATION_DETECT_BATCH).map(c => c.address);
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`,
        { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Mintix/1.0" } },
      );
      if (!res.ok) continue;
      const body = (await res.json()) as DexScreenerResponse;
      const pairs = body.pairs ?? [];

      // Collect mints that have a confirmed DEX pair (graduated from bonding curve)
      const graduatedInBatch = new Set(
        pairs
          .filter(p => GRADUATION_DEX_IDS.has(p.dexId))
          .map(p => p.baseToken.address),
      );

      for (const mint of graduatedInBatch) {
        await db
          .update(tokensTable)
          .set({ graduated: true, graduatedAt: sql`COALESCE(${tokensTable.graduatedAt}, NOW())` })
          .where(and(eq(tokensTable.address, mint), eq(tokensTable.graduated, false)));

        registerGraduatedMint(mint);
        newly.push(mint);
      }
    } catch (err) {
      log.warn({ err }, "enrichment: graduation detection batch failed");
    }
  }

  if (newly.length > 0) {
    log.info({ count: newly.length, mints: newly }, "enrichment: detected and registered newly-graduated tokens");
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

export function startEnrichmentLoop(): void {
  log.info({ intervalMs: POLL_INTERVAL_MS }, "enrichment: background loop started");
  // Run bonding-curve backfill immediately so existing tokens get real MC values
  void backfillBondingCurves();
  // Detect tokens that graduated while the indexer was offline (missed migration events)
  void detectGraduations();
  setInterval(() => void detectGraduations(), GRADUATION_DETECT_INTERVAL_MS);
  // First tick slightly delayed so adapters can connect and insert initial records
  setTimeout(() => {
    void enrichTick();
    setInterval(() => void enrichTick(), POLL_INTERVAL_MS);
  }, 5_000);
}
