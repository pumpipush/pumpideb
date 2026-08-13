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
import { fetchSafeUriMeta } from "./safeUriFetch";
import {
  fetchDexScreenerTokens,
  pairToDbFields,
  pairToSocialFields,
  bestSolanaPair,
  type DexScreenerPair,
} from "./dexscreener";
import { bs58Decode as _bs58Decode, decodeLabCreateParamsRaw } from "./adapters/launchlabDecode";

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
  name?:        string;
  symbol?:      string;
  image_uri?:   string;
  description?: string;
  twitter?:     string;
  telegram?:    string;
  website?:     string;
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

// ── Birdeye token overview — high-res image + metadata URI ────────────────────
//
// Raydium's /mint/ids endpoint returns a tiny 32×32 px icon from img-v1.raydium.io.
// Birdeye's /defi/token_overview returns the real IPFS/Arweave image URL (100-400 KB)
// stored in the token's on-chain Metaplex metadata.  We prefer this over the CDN icon
// whenever BIRDEYE_API_KEY is available.

interface BirdeyeOverview {
  logoURI?: string;
  extensions?: {
    website?: string;
    twitter?: string;
    telegram?: string;
    description?: string;
  };
}

/**
 * Returns the full-resolution image URL from Birdeye for a given mint,
 * OR null if the key is missing / API call fails / URL is still a tiny CDN icon.
 */
async function fetchBirdeyeLogoURI(mint: string): Promise<string | null> {
  const key = process.env["BIRDEYE_API_KEY"];
  if (!key) return null;
  try {
    const res = await fetch(
      `https://public-api.birdeye.so/defi/token_overview?address=${mint}`,
      { signal: AbortSignal.timeout(8_000), headers: { "X-API-KEY": key, "User-Agent": "RocketFi/1.0" } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: BirdeyeOverview };
    const url = body.data?.logoURI ?? null;
    // Skip the tiny Raydium CDN icon — it's the same 32×32 we already have from Raydium API
    if (!url || url.includes("img-v1.raydium.io")) return null;
    return url;
  } catch {
    return null;
  }
}

// ── Solana DAS (getAsset) — metadata URI for description / socials ─────────────
//
// api.mainnet-beta.solana.com supports the Metaplex DAS getAsset method.
// Returns the json_uri (IPFS / Arweave metadata JSON) which holds description,
// twitter, telegram etc.  We store this as metadataUri so the enrichment loop
// can hydrate socials on the next pass.

async function fetchDasMetadataUri(mint: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: mint } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { content?: { json_uri?: string } } };
    return body.result?.content?.json_uri ?? null;
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
  name?:        string;
  symbol?:      string;
  imageUrl?:    string | null;
  description?: string | null;
  twitterUrl?:  string | null;
  telegramUrl?: string | null;
  websiteUrl?:  string | null;
}

async function fetchMeta(
  mint:        string,
  platform:    string,
  metadataUri: string | null = null,
): Promise<EnrichResult | null> {
  if (platform === "pump_fun") {
    // Primary: pump.fun API (may be blocked/rate-limited from hosted environments)
    const pump = await fetchPumpMeta(mint);
    if (pump) return {
      name:        pump.name,
      symbol:      pump.symbol,
      imageUrl:    pump.image_uri  ?? null,
      description: pump.description ? pump.description.trim() || null : null,
      twitterUrl:  pump.twitter    ? pump.twitter.trim()    || null : null,
      telegramUrl: pump.telegram   ? pump.telegram.trim()   || null : null,
      websiteUrl:  pump.website    ? pump.website.trim()    || null : null,
    };

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
    // Primary: Raydium's /mint/ids endpoint provides name + symbol.
    // Note: its logoURI is a tiny 32×32 icon — we override it with the full-res
    // Birdeye image below.
    const ray = await fetchRaydiumMeta(mint);
    if (ray?.name && ray?.symbol) {
      // Fetch full-res image (Birdeye) and metadata URI (DAS) in parallel.
      // Both are best-effort — fall back to Raydium CDN icon if they fail.
      const [birdeyeImg, dasUri] = await Promise.all([
        platform === "raydium_launchlab" ? fetchBirdeyeLogoURI(mint) : Promise.resolve(null),
        platform === "raydium_launchlab" ? fetchDasMetadataUri(mint) : Promise.resolve(null),
      ]);
      const imageUrl = birdeyeImg ?? ray.logoURI ?? null;
      const result: EnrichResult = { name: ray.name, symbol: ray.symbol, imageUrl };

      // If we got a DAS metadata URI and didn't already have one, fetch socials from it
      const effectiveUri = dasUri ?? metadataUri;
      if (effectiveUri) {
        try {
          const uriMeta = await fetchSafeUriMeta(effectiveUri);
          if (uriMeta) {
            if (!result.imageUrl && uriMeta.imageUrl)   result.imageUrl    = uriMeta.imageUrl;
            if (uriMeta.description)                     result.description = uriMeta.description;
            if (uriMeta.twitterUrl)                      result.twitterUrl  = uriMeta.twitterUrl;
            if (uriMeta.telegramUrl)                     result.telegramUrl = uriMeta.telegramUrl;
            if (uriMeta.websiteUrl)                      result.websiteUrl  = uriMeta.websiteUrl;
          }
        } catch { /* socials are best-effort */ }
      }

      return result;
    }

    // Raydium API doesn't know this token yet (very fresh).
    // Fallback for LaunchLab: the createLaunchpad instruction embeds a metadata URI
    // (IPFS / Arweave / CDN) that holds the full token JSON including name, symbol,
    // image, description, and socials.
    if (platform === "raydium_launchlab" && metadataUri) {
      const uriMeta = await fetchSafeUriMeta(metadataUri);
      if (!uriMeta) return null;
      return {
        name:        uriMeta.name    ?? undefined,
        symbol:      uriMeta.symbol  ?? undefined,
        imageUrl:    uriMeta.imageUrl,
        description: uriMeta.description,
        twitterUrl:  uriMeta.twitterUrl,
        telegramUrl: uriMeta.telegramUrl,
        websiteUrl:  uriMeta.websiteUrl,
      };
    }

    return null;
  }

  return null;
}

// ── Update computation (pure — exported for testing) ──────────────────────────

interface TokenRow {
  address:     string;
  name:        string;
  symbol:      string;
  imageUrl:    string | null;
  description: string | null;
  twitterUrl:  string | null;
  telegramUrl: string | null;
  websiteUrl:  string | null;
  platform:    string;
  metadataUri: string | null;
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
  token: Pick<TokenRow, "name" | "symbol" | "imageUrl"> & Partial<Pick<TokenRow, "description" | "twitterUrl" | "telegramUrl" | "websiteUrl">>,
  meta:  EnrichResult,
): Record<string, string> | null {
  const newName   = meta.name   && !isPlaceholderName(meta.name)    ? meta.name   : null;
  const newSymbol = meta.symbol && !isPlaceholderSymbol(meta.symbol) ? meta.symbol : null;
  const newImage  = meta.imageUrl ? meta.imageUrl : null;

  /** True when the current image is the tiny 32×32 Raydium CDN icon — safe to upgrade. */
  const isSmallRaydiumIcon = (url: string | null | undefined) =>
    !!url && url.includes("img-v1.raydium.io");

  const update: Record<string, string> = {};
  if (newName   && isPlaceholderName(token.name))     update["name"]     = newName;
  if (newSymbol && isPlaceholderSymbol(token.symbol)) update["symbol"]   = newSymbol;
  // Allow upgrade from null OR from the known-tiny Raydium CDN icon (32×32 px).
  if (newImage && (token.imageUrl == null || isSmallRaydiumIcon(token.imageUrl)))
    update["imageUrl"] = newImage;

  // Only fill social/description fields when currently empty — never overwrite user-set data
  if (meta.description && !token.description)   update["description"] = meta.description;
  if (meta.twitterUrl  && !token.twitterUrl)    update["twitterUrl"]  = meta.twitterUrl;
  if (meta.telegramUrl && !token.telegramUrl)   update["telegramUrl"] = meta.telegramUrl;
  if (meta.websiteUrl  && !token.websiteUrl)    update["websiteUrl"]  = meta.websiteUrl;

  return Object.keys(update).length > 0 ? update : null;
}

// ── Enrich a single token ──────────────────────────────────────────────────────

async function enrichOne(token: TokenRow): Promise<void> {
  const meta = await fetchMeta(token.address, token.platform, token.metadataUri);
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
        address:     tokensTable.address,
        name:        tokensTable.name,
        symbol:      tokensTable.symbol,
        imageUrl:    tokensTable.imageUrl,
        description: tokensTable.description,
        twitterUrl:  tokensTable.twitterUrl,
        telegramUrl: tokensTable.telegramUrl,
        websiteUrl:  tokensTable.websiteUrl,
        platform:    tokensTable.platform,
        metadataUri: tokensTable.metadataUri,
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
        address:     tokensTable.address,
        name:        tokensTable.name,
        symbol:      tokensTable.symbol,
        imageUrl:    tokensTable.imageUrl,
        description: tokensTable.description,
        twitterUrl:  tokensTable.twitterUrl,
        telegramUrl: tokensTable.telegramUrl,
        websiteUrl:  tokensTable.websiteUrl,
        platform:    tokensTable.platform,
        metadataUri: tokensTable.metadataUri,
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

      // Parse SQL NUMERIC result as BigInt directly — avoids Number() precision loss
      // for large lamport sums (>2^53 ≈ 9 PETAlamports = ~9 billion SOL, safe margin
      // but worth being precise). SQL SUM returns integer arithmetic on whole numbers.
      const netLamStr = (agg?.netLamports ?? "0").split(".")[0] || "0";
      const netLam = BigInt(netLamStr);
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

const GRADUATION_DETECT_INTERVAL_MS  = 5 * 60_000; // every 5 minutes
const PUMPSWAP_ENRICH_INTERVAL_MS    = 5 * 60_000; // every 5 minutes
const GRADUATION_DETECT_BATCH        = 20;          // mints per DexScreener call
const GRADUATION_DEX_IDS = new Set(["pumpswap", "raydium", "raydium-clmm", "raydium-cp"]);

async function detectGraduations(): Promise<void> {
  // Find pump.fun tokens that may have graduated to a DEX:
  //   a) graduated=false, tradeCount>50 — missed the migration event
  //   b) graduated=true  — already marked graduated but platform still 'pump_fun'
  //      (happened before graduation handler was updated to set platform='pumpswap')
  const candidates = await db
    .select({ address: tokensTable.address })
    .from(tokensTable)
    .where(
      and(
        eq(tokensTable.platform, "pump_fun"),
        sql`(${tokensTable.graduated} = false AND ${tokensTable.tradeCount}::int > 50
          OR ${tokensTable.graduated} = true)`,
      ),
    )
    .orderBy(desc(tokensTable.tradeCount))
    .limit(120);

  if (candidates.length === 0) return;

  const newly: string[] = [];

  for (let i = 0; i < candidates.length; i += GRADUATION_DETECT_BATCH) {
    const batch = candidates.slice(i, i + GRADUATION_DETECT_BATCH).map(c => c.address);
    try {
      const pairs = await fetchDexScreenerTokens(batch);

      // Group pairs by base token address
      const pairsByMint = new Map<string, DexScreenerPair[]>();
      for (const p of pairs) {
        if (!GRADUATION_DEX_IDS.has(p.dexId)) continue;
        const list = pairsByMint.get(p.baseToken.address) ?? [];
        list.push(p);
        pairsByMint.set(p.baseToken.address, list);
      }

      for (const [mint, mintPairs] of pairsByMint) {
        // Determine destination platform — prefer pumpswap over generic raydium
        const isPumpSwap = mintPairs.some(p => p.dexId === "pumpswap");
        // Raydium LaunchLab graduates go to Raydium pools — map to our adapter name.
        // Without this, any non-PumpSwap graduation was incorrectly tagged "pump_fun".
        const isRaydium  = mintPairs.some(p =>
          p.dexId === "raydium" || p.dexId === "raydium-clmm" || p.dexId === "raydium-cp"
        );
        const destPlatform = isPumpSwap ? "pumpswap"
          : isRaydium ? "raydium_launchlab"
          : "pump_fun";
        const bestPair = bestSolanaPair(mintPairs);
        const priceFields = bestPair ? pairToDbFields(bestPair) : {};

        await db
          .update(tokensTable)
          .set({
            graduated:   true,
            graduatedAt: sql`COALESCE(${tokensTable.graduatedAt}, NOW())`,
            platform:    destPlatform,
            ...priceFields,
          })
          .where(eq(tokensTable.address, mint));

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

/**
 * Refresh price, market cap, volume, and % change for all PumpSwap tokens
 * using DexScreener. Runs every 5 minutes.
 *
 * Also handles tokens that were newly detected by the PumpSwap adapter
 * but have no metadata yet (name = "???").
 */
async function enrichPumpSwapPrices(): Promise<void> {
  const tokens = await db
    .select({ address: tokensTable.address, name: tokensTable.name, symbol: tokensTable.symbol })
    .from(tokensTable)
    .where(eq(tokensTable.platform, "pumpswap"))
    .orderBy(desc(tokensTable.createdAt))
    .limit(120); // batch across multiple DexScreener calls

  if (tokens.length === 0) return;

  let updated = 0;
  const BATCH = 30;

  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    const addresses = batch.map(t => t.address);
    try {
      const pairs = await fetchDexScreenerTokens(addresses);

      for (const token of batch) {
        const tokenPairs = pairs.filter(p => p.baseToken.address === token.address && p.chainId === "solana");
        const best = bestSolanaPair(tokenPairs);
        if (!best) continue;

        const fields = pairToDbFields(best);

        // Fill in metadata when name OR symbol is still a placeholder.
        // Placeholder patterns: "???", first 8 chars of address, or empty string.
        const isPlaceholderN = !token.name || token.name === "???" || token.name === token.address.slice(0, 8);
        const isPlaceholderS = !token.symbol || token.symbol === "???";
        const metaFields: Record<string, string | null> = {};
        if (isPlaceholderN || isPlaceholderS) {
          if (best.baseToken.name)   metaFields["name"]     = best.baseToken.name;
          if (best.baseToken.symbol) metaFields["symbol"]   = best.baseToken.symbol;
          if (best.info?.imageUrl)   metaFields["imageUrl"] = best.info.imageUrl;
        }

        // Always apply social fields from DexScreener for pumpswap tokens —
        // DexScreener is the authoritative metadata source for this platform.
        const socialFields = pairToSocialFields(best);

        await db
          .update(tokensTable)
          .set({ ...fields, ...metaFields, ...socialFields })
          .where(eq(tokensTable.address, token.address));

        updated++;
      }
    } catch (err) {
      log.warn({ err }, "enrichment: pumpswap price refresh batch failed");
    }
  }

  if (updated > 0) {
    log.info({ updated }, "enrichment: pumpswap prices refreshed from DexScreener");
  }
}

// ── LaunchLab chain-update guard (pure — exported for testing) ────────────────

/**
 * Compute the name/symbol update dict for `enrichLabTokensFromChain`.
 *
 * Rules (identical to the `computeEnrichmentUpdate` guard for the main loop):
 *   - Only write `name`   when current name   IS a placeholder AND resolved name   is NOT.
 *   - Only write `symbol` when current symbol IS a placeholder AND resolved symbol is NOT.
 *   - Always write `metadataUri` when we newly know it (resolved.uri) and the token
 *     didn't have one yet — this is a content field, not identity, so no placeholder check.
 *
 * Exported so tests can verify the guard without hitting the DB or RPC layer.
 */
export function buildLabChainUpdate(
  token:    Pick<TokenRow, "name" | "symbol" | "metadataUri">,
  resolved: { name: string; symbol: string; uri: string },
): Record<string, string | null> {
  const update: Record<string, string | null> = {};
  if (isPlaceholderName(token.name)   && !isPlaceholderName(resolved.name))
    update["name"]   = resolved.name;
  if (isPlaceholderSymbol(token.symbol) && !isPlaceholderSymbol(resolved.symbol))
    update["symbol"] = resolved.symbol;
  if (resolved.uri && !token.metadataUri)
    update["metadataUri"] = resolved.uri;
  return update;
}

// ── LaunchLab on-chain identity recovery ───────────────────────────────────────
//
// Some LaunchLab tokens arrive with name="<addr8>…" and symbol="???" because
// the Borsh decode of the createLaunchpad instruction failed at ingest time.
// The existing enrichment loop already retries them via Raydium /mint/ids and
// metadataUri, but very fresh tokens (< 10 minutes old) aren't in those
// registries yet.  This pass goes directly to the chain:
//
//   1. getSignaturesForAddress(mint, limit=20)  → newest-first list of sigs
//   2. The LAST entry is the oldest tx — almost always the createLaunchpad tx
//   3. getTransaction(oldestSig) → full tx data
//   4. decodeLabCreateParamsRaw() with expanded offset set → name/symbol/uri
//   5. If decode succeeds, update DB + emit SSE snapshot
//   6. If decode still fails, fall back to metadataUri (same as main loop)
//
// Rate-limit budget: max 5 tokens per tick (2 RPC calls each = 10 calls/30 s).

const LL_CHAIN_ENRICH_BATCH = 5;
const LL_CHAIN_ENRICH_INTERVAL_MS = 60_000; // runs every 60 s (separate timer)

const LAUNCHLAB_PROGRAM_ID = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

// ── Minimal Solana HTTP RPC helper (same endpoints as launchlabBackfill.ts) ────

function _llRpcUrl(): string {
  const key = process.env["ALCHEMY_API_KEY"];
  return key
    ? `https://solana-mainnet.g.alchemy.com/v2/${key}`
    : "https://solana-rpc.publicnode.com";
}

const _LL_FALLBACK_RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

async function _llRpcPost(body: unknown, timeoutMs = 20_000): Promise<unknown> {
  const urls = [_llRpcUrl(), ..._LL_FALLBACK_RPCS.filter(u => u !== _llRpcUrl())];
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "RocketFi/1.0" },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { lastErr = new Error(`RPC ${res.status}`); continue; }
      const json = await res.json() as { error?: { code?: number } };
      const code = (json.error as { code?: number } | undefined)?.code;
      if (code === -32005 || code === 429) { lastErr = new Error(`rate-limited`); continue; }
      return json;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("all RPC endpoints failed");
}

// _bs58Decode and decodeLabCreateParamsRaw imported from ./adapters/launchlabDecode

interface _SigEntry { signature: string; err: unknown }
interface _RpcTxResult { result?: Record<string, unknown> | null }

async function _getSignaturesForMint(
  mint:    string,
  limit:   number,
  before?: string,
): Promise<_SigEntry[]> {
  const params: [string, Record<string, unknown>] = [
    mint,
    { limit, commitment: "confirmed", ...(before ? { before } : {}) },
  ];
  const resp = (await _llRpcPost({
    jsonrpc: "2.0", id: 1,
    method:  "getSignaturesForAddress",
    params,
  })) as { result?: _SigEntry[] };
  return resp.result ?? [];
}

async function _getTransaction(sig: string): Promise<Record<string, unknown> | null> {
  const resp = (await _llRpcPost({
    jsonrpc: "2.0", id: 1,
    method:  "getTransaction",
    params:  [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }],
  })) as _RpcTxResult;
  return resp.result ?? null;
}

/**
 * Attempt to extract decoded create params from a raw transaction object.
 * ONLY decodes when the transaction logs confirm it is a createLaunchpad
 * instruction — prevents trade instruction bytes being misread as names.
 */
function _decodeFromTx(tx: Record<string, unknown>): { name: string; symbol: string; uri: string } | null {
  const meta = tx["meta"] as Record<string, unknown> | null;
  if (!meta || meta["err"]) return null;

  // Guard: only try the decoder on createLaunchpad transactions.
  // Trade instruction bytes at the same offsets can look like valid strings,
  // so skipping this check risks writing garbage names to the DB.
  const logMessages = ((meta["logMessages"] ?? (tx["meta"] as Record<string,unknown>)?.["logMessages"]) as string[]) ?? [];
  if (!logMessages.some(l => /Instruction:\s*createLaunchpad/i.test(l))) return null;

  const message = ((tx["transaction"] as Record<string,unknown>)?.["message"] as Record<string,unknown>) ?? {};
  const keys    = (message["accountKeys"] as Array<{ pubkey?: string } | string>) ?? [];
  const instrs  = (message["instructions"] as Array<{ programIdIndex: number; data: string }>) ?? [];

  const progIdx = keys.findIndex(k =>
    (typeof k === "string" ? k : (k as { pubkey?: string }).pubkey) === LAUNCHLAB_PROGRAM_ID,
  );
  if (progIdx < 0) return null;

  const instr = instrs.find(i => i.programIdIndex === progIdx);
  if (!instr?.data) return null;

  try {
    const raw = _bs58Decode(instr.data);
    return decodeLabCreateParamsRaw(raw);
  } catch {
    return null;
  }
}

/**
 * Paginate getSignaturesForAddress on the mint address from newest to oldest
 * until we find a confirmed createLaunchpad transaction (bounded by RPC budget).
 *
 * The creation tx is always the OLDEST tx on a mint, so we paginate backward
 * in time.  In the last (oldest) page the creation sig is the final entry.
 * We validate each candidate with getTransaction + log check before decoding.
 *
 * Budget: ≤ MAX_SIG_PAGES × getSignaturesForAddress + ≤ MAX_TX_ATTEMPTS
 *         getTransaction calls per token.
 */
const SIG_PAGE_SIZE  = 1000; // Solana RPC max per call
const MAX_SIG_PAGES  = 5;    // covers up to 5 000 txs per mint
const MAX_TX_ATTEMPTS = 3;   // getTransaction attempts per final page

async function _findLabCreateTx(mint: string): Promise<Record<string, unknown> | null> {
  let cursor: string | undefined;
  let finalPage: string[] = []; // valid sigs in the deepest page reached

  for (let page = 0; page < MAX_SIG_PAGES; page++) {
    let sigs: _SigEntry[];
    try {
      sigs = await _getSignaturesForMint(mint, SIG_PAGE_SIZE, cursor);
    } catch {
      break;
    }
    if (sigs.length === 0) break;

    const validSigs = sigs.filter(s => !s.err).map(s => s.signature);
    finalPage = validSigs;

    if (sigs.length < SIG_PAGE_SIZE) {
      // Last page — the creation tx is among the oldest sigs here (at the end).
      break;
    }

    // Full page → more history exists; paginate further back.
    cursor = sigs[sigs.length - 1]?.signature;
  }

  // In the deepest page, the creation tx is the OLDEST (last in the array).
  // Try up to MAX_TX_ATTEMPTS sigs from the oldest end.
  const candidates = [...finalPage].reverse().slice(0, MAX_TX_ATTEMPTS);
  for (const sig of candidates) {
    try {
      const tx = await _getTransaction(sig);
      if (!tx) continue;
      // _decodeFromTx checks createLaunchpad log internally; null = not a create tx.
      const decoded = _decodeFromTx(tx);
      if (decoded) return tx; // confirmed createLaunchpad with decodable params
    } catch { continue; }
  }

  return null;
}

async function enrichLabTokensFromChain(): Promise<void> {
  // Find LaunchLab tokens that still have a placeholder identity.
  // ORDER BY RANDOM() so every unresolved token gets a fair chance across ticks
  // — if we always picked the newest 5 and those repeatedly fail RPC, older
  // tokens would be permanently starved.
  const tokens = await db
    .select({
      address:     tokensTable.address,
      name:        tokensTable.name,
      symbol:      tokensTable.symbol,
      imageUrl:    tokensTable.imageUrl,
      description: tokensTable.description,
      twitterUrl:  tokensTable.twitterUrl,
      telegramUrl: tokensTable.telegramUrl,
      websiteUrl:  tokensTable.websiteUrl,
      platform:    tokensTable.platform,
      metadataUri: tokensTable.metadataUri,
    })
    .from(tokensTable)
    .where(
      and(
        eq(tokensTable.platform, "raydium_launchlab"),
        or(
          like(tokensTable.name,   "%…"),
          like(tokensTable.name,   "%..."),
          like(tokensTable.symbol, "???"),
        ),
      ),
    )
    .orderBy(sql`RANDOM()`) // fair rotation — prevents starvation of older tokens
    .limit(LL_CHAIN_ENRICH_BATCH);

  if (tokens.length === 0) return;

  log.info({ count: tokens.length }, "enrichment: launchlab on-chain identity recovery pass");

  for (const token of tokens) {
    try {
      // ── Step 1: paginate to the creation tx (createLaunchpad validated) ──────
      const createTx = await _findLabCreateTx(token.address);

      let resolved: { name: string; symbol: string; uri: string } | null = null;
      if (createTx) {
        // ── Step 2: Borsh decode with expanded offsets ────────────────────────
        // _decodeFromTx already checked the createLaunchpad log guard above;
        // decodeLabCreateParamsRaw handles the actual byte parsing.
        resolved = _decodeFromTx(createTx);
      }

      // ── Step 3: fall back to metadataUri if on-chain decode still fails ──────
      if (!resolved && token.metadataUri) {
        const uriMeta = await fetchSafeUriMeta(token.metadataUri);
        if (uriMeta?.name && uriMeta?.symbol &&
            !isPlaceholderName(uriMeta.name) && !isPlaceholderSymbol(uriMeta.symbol)) {
          resolved = {
            name:   uriMeta.name,
            symbol: uriMeta.symbol,
            uri:    token.metadataUri,
          };
        }
      }

      if (!resolved) continue;

      // ── Step 4: build the update — only overwrite placeholders ────────────────
      const update: Record<string, string | null> = buildLabChainUpdate(token, resolved);

      // Attempt to pull image / description / socials from the URI
      if (resolved.uri && !token.imageUrl) {
        try {
          const uriMeta = await fetchSafeUriMeta(resolved.uri);
          if (uriMeta?.imageUrl    && !token.imageUrl)    update["imageUrl"]    = uriMeta.imageUrl;
          if (uriMeta?.description && !token.description) update["description"] = uriMeta.description;
          if (uriMeta?.twitterUrl  && !token.twitterUrl)  update["twitterUrl"]  = uriMeta.twitterUrl;
          if (uriMeta?.telegramUrl && !token.telegramUrl) update["telegramUrl"] = uriMeta.telegramUrl;
          if (uriMeta?.websiteUrl  && !token.websiteUrl)  update["websiteUrl"]  = uriMeta.websiteUrl;
        } catch { /* non-critical — metadata URI fetch is best-effort */ }
      }

      if (Object.keys(update).length === 0) continue;

      const [updated] = await db
        .update(tokensTable)
        .set(update)
        .where(eq(tokensTable.address, token.address))
        .returning();

      log.info(
        { address: token.address, ...update },
        "enrichment: launchlab on-chain identity resolved",
      );

      // ── Step 5: push live SSE update ─────────────────────────────────────────
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
    } catch (err) {
      log.warn({ address: token.address, err }, "enrichment: launchlab chain recovery failed for token");
    }
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
  // Refresh PumpSwap token prices from DexScreener
  void enrichPumpSwapPrices();
  setInterval(() => void enrichPumpSwapPrices(), PUMPSWAP_ENRICH_INTERVAL_MS);
  // Resolve LaunchLab tokens that still have '???' identity by re-reading the
  // creation transaction directly from the Solana RPC with an expanded offset set.
  // Runs 10 s after startup (adapters need a moment to settle) then every 60 s.
  setTimeout(() => {
    void enrichLabTokensFromChain();
    setInterval(() => void enrichLabTokensFromChain(), LL_CHAIN_ENRICH_INTERVAL_MS);
  }, 10_000);
  // First tick slightly delayed so adapters can connect and insert initial records
  setTimeout(() => {
    void enrichTick();
    setInterval(() => void enrichTick(), POLL_INTERVAL_MS);
  }, 5_000);
}
