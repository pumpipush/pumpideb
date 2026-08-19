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
import { db, pool, tokensTable, tradesTable } from "@workspace/db";
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
import { fetchMintTotalSupply } from "./adapters/raydium-launchlab";
import { fetchBirdeyeTokenOverview, getSolPriceUsd } from "./birdeye";

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
      headers: { "User-Agent": "Pumpi/1.0" },
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
      { signal: AbortSignal.timeout(8_000), headers: { "User-Agent": "Pumpi/1.0" } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: RaydiumItem[] };
    return body.data?.[0] ?? null;
  } catch {
    return null;
  }
}

// ── Birdeye token overview — high-res image fallback ──────────────────────────
//
// Raydium's /mint/ids endpoint returns a tiny 32×32 px icon from img-v1.raydium.io.
// DexScreener (free, no API key) is tried first for the full-res image via
// pair.info?.imageUrl.  Birdeye's /defi/token_overview is kept as a fallback
// for tokens that DexScreener has not yet indexed (very new LaunchLab tokens).

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
      { signal: AbortSignal.timeout(8_000), headers: { "X-API-KEY": key, "User-Agent": "Pumpi/1.0" } },
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

// ── Solana DAS (getAsset) — full on-chain Metaplex metadata ───────────────────
//
// api.mainnet-beta.solana.com supports the Metaplex DAS getAsset method.
// Unlike getTransaction/getSignaturesForAddress this endpoint is NOT subject to
// the same free-RPC 429 rate limits, making it the preferred source for
// LaunchLab token identity recovery.
//
// Returns name, symbol, json_uri, and direct image link when available.
// Validated on 278/282 unnamed LaunchLab tokens in August 2026.

interface DasAssetMeta {
  name:     string;
  symbol:   string;
  uri:      string | null;
  imageUrl: string | null;
}

async function fetchDasAsset(mint: string): Promise<DasAssetMeta | null> {
  try {
    const res = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: mint } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      result?: {
        content?: {
          metadata?: { name?: string; symbol?: string };
          json_uri?: string;
          links?:    { image?: string };
        };
      };
    };
    const meta  = body.result?.content?.metadata;
    const name   = meta?.name?.trim()   ?? "";
    const symbol = meta?.symbol?.trim() ?? "";
    if (!name || !symbol) return null;
    return {
      name,
      symbol,
      uri:      body.result?.content?.json_uri   ?? null,
      imageUrl: body.result?.content?.links?.image ?? null,
    };
  } catch {
    return null;
  }
}

/** Legacy shim — kept for the processUnenriched image-enrichment path */
async function fetchDasMetadataUri(mint: string): Promise<string | null> {
  const asset = await fetchDasAsset(mint);
  return asset?.uri ?? null;
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

/** Exported for unit testing — internal implementation detail, not public API. */
export async function fetchMeta(
  mint:        string,
  platform:    string,
  metadataUri: string | null = null,
): Promise<EnrichResult | null> {
  if (platform === "pump_fun") {
    // Primary: pump.fun API (may be blocked/rate-limited from hosted environments)
    const pump = await fetchPumpMeta(mint);
    if (pump) {
      const result: EnrichResult = {
        name:        pump.name,
        symbol:      pump.symbol,
        imageUrl:    pump.image_uri  ?? null,
        description: pump.description ? pump.description.trim() || null : null,
        twitterUrl:  pump.twitter    ? pump.twitter.trim()    || null : null,
        telegramUrl: pump.telegram   ? pump.telegram.trim()   || null : null,
        websiteUrl:  pump.website    ? pump.website.trim()    || null : null,
      };
      // If pump.fun API returned identity but no image, try the stored metadata URI.
      // This covers the case where the IPFS image fetch timed out at launch time
      // and imageUrl was stored as null in the DB even though metadataUri was saved.
      if (!result.imageUrl && metadataUri) {
        const uriMeta = await fetchSafeUriMeta(metadataUri).catch(() => null);
        if (uriMeta?.imageUrl) result.imageUrl = uriMeta.imageUrl;
      }
      return result;
    }

    // Fallback: Raydium's /mint/ids works for any SPL token, including pump.fun tokens
    // that have been indexed after launch. Brand-new tokens won't appear here yet
    // but tokens a few minutes old often do.
    const ray = await fetchRaydiumMeta(mint);
    if (ray) {
      let imageUrl = ray.logoURI ?? null;
      // Same metadataUri fallback for the image when Raydium doesn't have one.
      if (!imageUrl && metadataUri) {
        const uriMeta = await fetchSafeUriMeta(metadataUri).catch(() => null);
        if (uriMeta?.imageUrl) imageUrl = uriMeta.imageUrl;
      }
      return { name: ray.name, symbol: ray.symbol, imageUrl };
    }

    // Both pump.fun and Raydium APIs failed — if we have a stored metadataUri, fetch
    // name/symbol/image directly from it. This is the last-resort path for tokens
    // launched via our proxy whose IPFS URL is now available even if the upload
    // response timed out before the image could be stored.
    if (metadataUri) {
      const uriMeta = await fetchSafeUriMeta(metadataUri);
      if (uriMeta) {
        return {
          name:        uriMeta.name   ?? undefined,
          symbol:      uriMeta.symbol ?? undefined,
          imageUrl:    uriMeta.imageUrl,
          description: uriMeta.description,
          twitterUrl:  uriMeta.twitterUrl,
          telegramUrl: uriMeta.telegramUrl,
          websiteUrl:  uriMeta.websiteUrl,
        };
      }
    }

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
      // Fetch full-res image and metadata URI in parallel.
      // DexScreener (free) is tried first for the image; Birdeye is the fallback
      // for tokens not yet indexed there (very new LaunchLab tokens).
      const [dsImage, dasUri] = await Promise.all([
        platform === "raydium_launchlab"
          ? fetchDexScreenerTokens([mint]).then(pairs => bestSolanaPair(pairs)?.info?.imageUrl ?? null)
          : Promise.resolve(null),
        platform === "raydium_launchlab" ? fetchDasMetadataUri(mint) : Promise.resolve(null),
      ]);

      // Image priority: DexScreener → Birdeye fallback (costs CU) → Raydium 32×32 CDN icon
      let imageUrl: string | null = dsImage;
      if (!imageUrl && platform === "raydium_launchlab") {
        imageUrl = await fetchBirdeyeLogoURI(mint);
      }
      imageUrl = imageUrl ?? ray.logoURI ?? null;
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

  const staleAddresses = stale.map((t) => t.address);

  // ── 1. Single grouped aggregate query for all stale tokens ──────────────────
  // Replaces the per-token SELECT inside the loop (was up to 500 queries → 1).
  const aggRows = await db
    .select({
      tokenAddress: tradesTable.tokenAddress,
      netLamports:  sql<string>`
        SUM(CASE WHEN ${tradesTable.isBuy} THEN CAST(${tradesTable.ethAmount} AS NUMERIC)
                 ELSE -CAST(${tradesTable.ethAmount} AS NUMERIC) END)
      `,
    })
    .from(tradesTable)
    .where(inArray(tradesTable.tokenAddress, staleAddresses))
    .groupBy(tradesTable.tokenAddress);

  // Index by address for O(1) lookup when computing reserves below.
  const aggByAddress = new Map(aggRows.map((r) => [r.tokenAddress, r.netLamports]));

  // ── 2. Compute new reserve values in JS (BigInt arithmetic) ─────────────────
  // Parse SQL NUMERIC result as BigInt — avoids Number() precision loss for large
  // lamport sums (>2^53 ≈ 9 PETAlamports = ~9 billion SOL, well outside real range
  // but worth being precise). SUM on whole-number strings gives integer arithmetic.
  const updateAddresses:    string[] = [];
  const updateVSolStrs:     string[] = [];
  const updateVTokStrs:     string[] = [];
  const updateMCStrs:       string[] = [];

  for (const token of stale) {
    const rawNet   = aggByAddress.get(token.address) ?? "0";
    const netLamStr = rawNet.split(".")[0] || "0";
    let netLam: bigint;
    try { netLam = BigInt(netLamStr); }
    catch { log.warn({ address: token.address, netLamStr }, "enrichment: bad netLamStr, skipping"); continue; }

    const newVSolLam = PUMP_INIT_VSOL_LAM + netLam;
    if (newVSolLam <= 0n) continue;

    const newVTok    = PUMP_K0 / newVSolLam;
    const newMC      = PUMP_TOTAL_SUPPLY * newVSolLam / newVTok;
    const newVSolStr = (Number(newVSolLam) / 1e9).toFixed(6).replace(/\.?0+$/, "");

    updateAddresses.push(token.address);
    updateVSolStrs.push(newVSolStr);
    updateVTokStrs.push(newVTok.toString());
    updateMCStrs.push(newMC.toString());
  }

  if (updateAddresses.length === 0) {
    log.info("enrichment: bonding curve backfill — no valid updates to apply");
    return;
  }

  // ── 3. Single batch UPDATE using unnest ────────────────────────────────────
  // Replaces the per-token UPDATE inside the loop (was up to 500 queries → 1).
  // unnest($1::text[], ...) expands the arrays into a virtual table that the
  // UPDATE joins against on address, applying all rows in one round-trip.
  await pool.query(`
    UPDATE tokens AS t
    SET
      virtual_eth_reserves   = v.ver,
      virtual_token_reserves = v.vtr,
      market_cap_eth         = v.mce
    FROM unnest(
      $1::text[],
      $2::text[],
      $3::text[],
      $4::text[]
    ) AS v(address, ver, vtr, mce)
    WHERE t.address = v.address
  `, [updateAddresses, updateVSolStrs, updateVTokStrs, updateMCStrs]);

  log.info({ count: updateAddresses.length }, "enrichment: bonding curve backfill complete");
}

// ── Graduation detection ───────────────────────────────────────────────────────
// Periodically checks pump.fun tokens still marked graduated=false that have
// significant trade activity. Uses DexScreener to confirm they have a
// PumpSwap/Raydium pool (i.e. they graduated but the migration event was missed).

const GRADUATION_DETECT_INTERVAL_MS  = 5 * 60_000; // every 5 minutes
const PUMPSWAP_ENRICH_INTERVAL_MS    = 5 * 60_000; // every 5 minutes
const LL_STATS_RECONCILE_INTERVAL_MS  = 10 * 60_000; // every 10 minutes
const LL_PRICE_ENRICH_INTERVAL_MS    =     60_000; // every 60 s
const LL_PRICE_ENRICH_BATCH          = 60;          // tokens per tick — primary pass (most active)
/** Min trades a long-tail token must have before it triggers a one-time Birdeye check. */
export const LL_PRICE_VERIFY_MIN_TRADES = 10;
/** Max extra Birdeye calls per 60 s tick for the secondary (long-tail) pass. */
export const LL_PRICE_VERIFY_BATCH      =  5;

/**
 * Pure selection helper: given the full set of qualifying long-tail candidates
 * (unverified LL tokens with enough trades) and the addresses already claimed
 * by the primary pass, return up to `limit` addresses that should be processed
 * by the secondary pass — ordered by trade_count descending (most-active first).
 *
 * Exported for unit testing so the overlap-exclusion logic can be verified
 * without a database.
 */
/**
 * Pure helper: given the actual trade stats (recomputed from the trades table)
 * and the stats currently stored on the token row, return true when the stored
 * values have drifted and need to be corrected.
 *
 * Exported for unit testing — the reconciliation SQL job uses equivalent
 * comparison logic inside the database.
 */
export function needsStatReconciliation(
  stored: { tradeCount: number; volumeEth: string },
  actual: { tradeCount: number; volumeEth: bigint },
): boolean {
  return (
    stored.tradeCount !== actual.tradeCount ||
    BigInt(stored.volumeEth) !== actual.volumeEth
  );
}

export function selectLongTailCandidates(
  candidates:   ReadonlyArray<{ address: string; tradeCount: number }>,
  primaryAddrs: ReadonlySet<string>,
  limit:        number,
): string[] {
  const result: string[] = [];
  // Candidates arrive pre-sorted (DESC trade_count) from the DB query.
  for (const { address } of candidates) {
    if (primaryAddrs.has(address)) continue; // already handled by primary pass
    result.push(address);
    if (result.length >= limit) break;
  }
  return result;
}
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
  // Prioritise in two passes so DexScreener quota goes to where it matters most:
  //   Pass 1 — tokens missing market_cap_eth (any age) — fills data gaps.
  //   Pass 2 — most active tokens by trade_count (freshness).
  // Both passes are deduplicated and combined before calling DexScreener.
  const [missingMC, mostActive] = await Promise.all([
    db.select({ address: tokensTable.address, name: tokensTable.name, symbol: tokensTable.symbol })
      .from(tokensTable)
      .where(and(
        eq(tokensTable.platform, "pumpswap"),
        or(isNull(tokensTable.marketCapEth), sql`${tokensTable.marketCapEth} = ''`),
      ))
      .orderBy(desc(tokensTable.tradeCount))
      .limit(60),
    db.select({ address: tokensTable.address, name: tokensTable.name, symbol: tokensTable.symbol })
      .from(tokensTable)
      .where(eq(tokensTable.platform, "pumpswap"))
      .orderBy(desc(tokensTable.createdAt))
      .limit(60),
  ]);
  // Merge, deduplicate by address, cap at 120 total.
  const seen = new Set<string>();
  const tokens: typeof missingMC = [];
  for (const t of [...missingMC, ...mostActive]) {
    if (seen.has(t.address)) continue;
    seen.add(t.address);
    tokens.push(t);
    if (tokens.length >= 120) break;
  }

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

// ── LaunchLab Birdeye price enrichment ────────────────────────────────────────
//
// Fetches authoritative USD price + market cap from Birdeye for the most active
// LaunchLab tokens every 60 s.  This fixes two root problems:
//
//   1. Placeholder tokens (missed CREATE) start with an incorrect initial MC.
//   2. Any single dust trade can briefly corrupt the on-chain-derived price.
//
// Conversion:
//   priceEth (SOL/token)  = price_usd / solPriceUsd
//   marketCapEth (lamps)  = (mc_usd / solPriceUsd) × 1e9
//
// Tokens are processed sequentially (not parallel) to respect Birdeye's
// per-second rate limit.  ~150 CU/min for 30 tokens at 5 CU each.

/**
 * Enrich a single LaunchLab token with live price data and persist to DB.
 * Returns true when the token was successfully updated, false otherwise.
 *
 * Shared by both the primary (top-60) pass and the secondary (long-tail) pass
 * so the enrichment logic stays in one place.
 *
 * Data source priority: DexScreener (free) → Birdeye (API key, fallback).
 */
async function enrichOneLaunchLabToken(address: string, solPrice: number): Promise<boolean> {
  type DbUpdate = {
    priceUsd?: number;
    priceEth: string;
    marketCapUsd?: number;
    marketCapEth?: string;
    pctChange24h?: number;
  };

  let update: DbUpdate | null = null;

  // ── Primary: DexScreener (free, no API key) ───────────────────────────────
  const dsPairs = await fetchDexScreenerTokens([address]);
  const dsPair  = bestSolanaPair(dsPairs);
  if (dsPair?.priceUsd && parseFloat(dsPair.priceUsd) > 0) {
    const dbFields = pairToDbFields(dsPair);
    if (dbFields.priceEth) {
      // pairToDbFields returns undefined priceEth when price is absurdly high
      update = { priceEth: dbFields.priceEth };
      if (dbFields.priceUsd     != null) update.priceUsd     = dbFields.priceUsd;
      if (dbFields.marketCapUsd != null) update.marketCapUsd = dbFields.marketCapUsd;
      if (dbFields.marketCapEth != null) update.marketCapEth = dbFields.marketCapEth;
      if (dbFields.pctChange24h != null) update.pctChange24h = dbFields.pctChange24h;
    }
  }

  // ── Fallback: Birdeye ─────────────────────────────────────────────────────
  if (!update) {
    const overview = await fetchBirdeyeTokenOverview(address);
    if (!overview || !overview.price || overview.price <= 0) return false;

    const priceUsd     = overview.price;
    const mcUsd        = overview.mc;
    const priceEth     = (priceUsd / solPrice).toFixed(15);
    const marketCapEth = mcUsd != null && mcUsd > 0
      ? String(Math.round((mcUsd / solPrice) * 1e9))
      : null;

    update = { priceUsd, priceEth };
    if (mcUsd        != null) update.marketCapUsd = mcUsd;
    if (marketCapEth != null) update.marketCapEth = marketCapEth;
    if (overview.priceChange24hPercent != null)
      update.pctChange24h = overview.priceChange24hPercent;
  }

  const [updatedRow] = await db
    .update(tokensTable)
    .set(update)
    .where(eq(tokensTable.address, address))
    .returning();

  if (updatedRow) {
    emitSnapshot({
      type: "snapshot",
      token: {
        address:              updatedRow.address,
        name:                 updatedRow.name,
        symbol:               updatedRow.symbol,
        imageUrl:             updatedRow.imageUrl,
        priceEth:             updatedRow.priceEth,
        marketCapEth:         updatedRow.marketCapEth,
        volumeEth:            updatedRow.volumeEth,
        virtualEthReserves:   updatedRow.virtualEthReserves,
        virtualTokenReserves: updatedRow.virtualTokenReserves,
        tradeCount:           Number(updatedRow.tradeCount),
        platform:             updatedRow.platform,
        chain:                updatedRow.chain,
      },
    });
    return true;
  }
  return false;
}

async function enrichLaunchLabPrices(): Promise<void> {
  const solPrice = await getSolPriceUsd();
  if (!solPrice) {
    log.warn("enrichment: launchlab price refresh skipped — SOL price unavailable");
    return;
  }

  // ── Primary pass: top LL_PRICE_ENRICH_BATCH tokens by activity ───────────
  // Best use of Birdeye quota — keeps prices fresh for the most-traded tokens.
  const tokens = await db
    .select({ address: tokensTable.address })
    .from(tokensTable)
    .where(eq(tokensTable.platform, "raydium_launchlab"))
    .orderBy(desc(tokensTable.tradeCount))
    .limit(LL_PRICE_ENRICH_BATCH);

  // Collect the primary addresses BEFORE calling Birdeye so the secondary
  // query below can exclude them regardless of whether each Birdeye call
  // succeeds or fails (a failed call leaves price_usd NULL, which would
  // otherwise let that token consume a secondary slot too).
  const primaryAddrs = new Set(tokens.map(t => t.address));

  let updated = 0;
  for (const { address } of tokens) {
    try {
      if (await enrichOneLaunchLabToken(address, solPrice)) updated++;
    } catch (err) {
      log.warn({ address, err }, "enrichment: launchlab birdeye price refresh failed for token");
    }
  }
  if (updated > 0) {
    log.info({ updated, solPrice }, "enrichment: launchlab prices refreshed from Birdeye");
  }

  // ── Secondary pass: first-time Birdeye verification for long-tail tokens ──
  // Picks tokens that:
  //   a) are NOT already covered by the primary pass (excluded by address)
  //   b) have accumulated enough trades to be worth a Birdeye call (≥ LL_PRICE_VERIFY_MIN_TRADES)
  //   c) have never had a Birdeye price set (price_usd IS NULL)
  //
  // Excluding primary addresses in SQL (not just filtering on price_usd) is
  // essential: if Birdeye returns no data for a primary token its price_usd
  // stays NULL, which would let it consume a secondary slot and starve the
  // genuinely long-tail tokens this pass is meant to serve.
  //
  // Once a long-tail token's price_usd is populated it stops appearing in
  // both this query (condition c) and the secondary pass is no longer needed
  // for it.  The primary pass continues to cover the top-60 by trade_count
  // on every subsequent tick.
  const longTailCandidates = await db
    .select({ address: tokensTable.address, tradeCount: tokensTable.tradeCount })
    .from(tokensTable)
    .where(
      and(
        eq(tokensTable.platform, "raydium_launchlab"),
        isNull(tokensTable.priceUsd),
        sql`${tokensTable.tradeCount}::int >= ${LL_PRICE_VERIFY_MIN_TRADES}`,
        // Exclude all addresses the primary pass already holds, even if their
        // Birdeye call failed and left price_usd NULL.
        primaryAddrs.size > 0
          ? not(inArray(tokensTable.address, [...primaryAddrs]))
          : sql`true`,
      ),
    )
    .orderBy(desc(tokensTable.tradeCount)) // most-active unverified first
    .limit(LL_PRICE_VERIFY_BATCH);

  // Use the pure helper so the selection logic is independently testable.
  const secondaryAddrs = selectLongTailCandidates(
    longTailCandidates.map(r => ({ address: r.address, tradeCount: Number(r.tradeCount) })),
    primaryAddrs,
    LL_PRICE_VERIFY_BATCH,
  );

  if (secondaryAddrs.length > 0) {
    let verified = 0;
    for (const address of secondaryAddrs) {
      try {
        if (await enrichOneLaunchLabToken(address, solPrice)) verified++;
      } catch (err) {
        log.warn({ address, err }, "enrichment: launchlab long-tail birdeye verify failed");
      }
    }
    if (verified > 0) {
      log.info({ verified }, "enrichment: launchlab long-tail tokens Birdeye-verified");
    }
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

const LL_CHAIN_ENRICH_BATCH = 20;
const LL_CHAIN_ENRICH_INTERVAL_MS = 30_000; // runs every 30 s (separate timer)

const LAUNCHLAB_PROGRAM_ID = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

// ── Minimal Solana HTTP RPC helper (always free public RPCs — never Alchemy) ──
// Alchemy is expensive at LaunchLab volume; PublicNode + Solana Foundation are
// sufficient for the small batch sizes used here (≤5 tokens per 60 s tick).

const _LL_FREE_RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

async function _llRpcPost(body: unknown, timeoutMs = 20_000): Promise<unknown> {
  const urls = _LL_FREE_RPCS;
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Pumpi/1.0" },
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
      let resolved: { name: string; symbol: string; uri: string } | null = null;
      let dasImageUrl: string | null = null;

      // ── Step 1: DAS getAsset (primary — no RPC rate limits) ──────────────────
      // Metaplex DAS resolves name/symbol/image directly from on-chain metadata
      // without requiring getSignaturesForAddress + getTransaction (which hit
      // 429 on the free public RPC).  Validated against 278/282 unnamed tokens.
      const dasAsset = await fetchDasAsset(token.address);
      if (dasAsset && !isPlaceholderName(dasAsset.name) && !isPlaceholderSymbol(dasAsset.symbol)) {
        resolved    = { name: dasAsset.name, symbol: dasAsset.symbol, uri: dasAsset.uri ?? "" };
        dasImageUrl = dasAsset.imageUrl;
      }

      // ── Step 2: fall back to RPC chain (createLaunchpad tx decode) ────────────
      // Only attempted when DAS returned no usable identity — e.g. very new tokens
      // not yet indexed by Metaplex, or tokens without on-chain metadata accounts.
      if (!resolved) {
        const createTx = await _findLabCreateTx(token.address);
        if (createTx) {
          resolved = _decodeFromTx(createTx);
        }
      }

      // ── Step 3: fall back to metadataUri if both above paths failed ───────────
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

      // Use DAS-provided image directly when available (avoids extra URI fetch)
      if (dasImageUrl && !token.imageUrl) update["imageUrl"] = dasImageUrl;

      // Attempt to pull image / description / socials from the URI
      if (resolved.uri && (!token.imageUrl && !update["imageUrl"])) {
        try {
          const uriMeta = await fetchSafeUriMeta(resolved.uri);
          if (uriMeta?.imageUrl    && !update["imageUrl"])  update["imageUrl"]    = uriMeta.imageUrl;
          if (uriMeta?.description && !token.description)   update["description"] = uriMeta.description;
          if (uriMeta?.twitterUrl  && !token.twitterUrl)    update["twitterUrl"]  = uriMeta.twitterUrl;
          if (uriMeta?.telegramUrl && !token.telegramUrl)   update["telegramUrl"] = uriMeta.telegramUrl;
          if (uriMeta?.websiteUrl  && !token.websiteUrl)    update["websiteUrl"]  = uriMeta.websiteUrl;
        } catch { /* non-critical — metadata URI fetch is best-effort */ }
      } else if (resolved.uri && !token.metadataUri) {
        // Still fetch socials even if image is already known
        try {
          const uriMeta = await fetchSafeUriMeta(resolved.uri);
          if (uriMeta?.description && !token.description)   update["description"] = uriMeta.description;
          if (uriMeta?.twitterUrl  && !token.twitterUrl)    update["twitterUrl"]  = uriMeta.twitterUrl;
          if (uriMeta?.telegramUrl && !token.telegramUrl)   update["telegramUrl"] = uriMeta.telegramUrl;
          if (uriMeta?.websiteUrl  && !token.websiteUrl)    update["websiteUrl"]  = uriMeta.websiteUrl;
        } catch { /* non-critical */ }
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

const WSOL_MINT_ADDRESS     = "So11111111111111111111111111111111111111112";
/** The legacy hardcoded 1B default supply (1B tokens × 10^6 decimals). */
export const LL_DEFAULT_SUPPLY_STR = "1000000000000000";

/** Page size for keyset-paginated supply backfill. Small to avoid RPC bursts. */
const LL_SUPPLY_BACKFILL_PAGE = 20;

/**
 * Parse a non-negative decimal price string into an exact { num, den } BigInt
 * ratio such that value = num / den.
 *
 * Supports plain decimal notation ("0.0000000004") and scientific notation
 * ("4e-10"), both of which appear in Solana price strings.
 *
 * Returns null when the string is empty, contains invalid characters, or is
 * negative.  Never calls parseFloat — the value is derived entirely from the
 * string's characters so that prices with more decimal places than float64 can
 * represent (> ~15 significant digits) are handled without rounding.
 *
 * Exported for unit testing.
 */
export function _parsePriceToRatio(
  s: string,
): { num: bigint; den: bigint } | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (trimmed === "0") return { num: 0n, den: 1n };
  if (trimmed.startsWith("-")) return null;

  // Match optional scientific notation: e.g. "4e-10", "1.5E+3", "0.00003"
  const m = trimmed.match(/^(\d+(?:\.\d+)?)(?:[eE]([+-]?\d+))?$/);
  if (!m) return null;

  const mantissa  = m[1]!;
  const expShift  = m[2] ? parseInt(m[2], 10) : 0;

  // Split mantissa into integer and fractional digit strings.
  const dotIdx = mantissa.indexOf(".");
  const intStr  = dotIdx === -1 ? mantissa : mantissa.slice(0, dotIdx);
  const fracStr = dotIdx === -1 ? ""        : mantissa.slice(dotIdx + 1);

  // Remove trailing zeros from fracStr — they don't change the value and
  // keeping them just makes the BigInt numbers larger for no benefit.
  const fracTrimmed = fracStr.replace(/0+$/, "");

  // Combined integer representing mantissa × 10^fracTrimmed.length
  //   e.g. "0.0000000004" → intStr="0", fracTrimmed="0000000004"
  //         combined = "00000000004" → 4n
  const combined = (intStr || "0") + fracTrimmed;

  // Total denominator exponent = fracTrimmed.length − expShift
  //   because: value = combined / 10^fracTrimmed.length × 10^expShift
  //                  = combined / 10^(fracTrimmed.length − expShift)
  const denExp = fracTrimmed.length - expShift;

  try {
    const num = BigInt(combined);
    if (denExp <= 0) {
      // The exponent shift makes this a whole-number value.
      return { num: num * (10n ** BigInt(-denExp)), den: 1n };
    }
    return { num, den: 10n ** BigInt(denExp) };
  } catch {
    return null;
  }
}

/**
 * Given a non-standard real supply and the token's stored priceEth, compute
 * the DB update that should be applied to correct the row.
 *
 * Returns null when the real supply matches the legacy default (no correction
 * needed) or is unavailable (RPC failed).
 *
 * Exported for unit testing.
 *
 * Market cap formula:
 *   priceEth = SOL per display token (display token = 10^6 atoms)
 *   price per atom (lamports) = priceEth × 1e9 / 1e6 = priceEth × 1000
 *   marketCapEth (lamports)   = realSupply (atoms) × priceEth × 1000
 */
export function computeSupplyBackfillUpdate(
  realSupply: bigint | null,
  priceEth:   string | null,
): { totalSupply: string; marketCapEth?: string } | null {
  if (!realSupply || realSupply.toString() === LL_DEFAULT_SUPPLY_STR) return null;

  const update: { totalSupply: string; marketCapEth?: string } = {
    totalSupply: realSupply.toString(),
  };

  // Parse priceEth directly into an exact BigInt num/den ratio — never via
  // parseFloat — so that neither the supply nor the price ever passes through
  // a lossy Number() conversion.  e.g. parseFloat("0.0000000004") → 4e-10
  // which, scaled by 1e9, truncates to 0; _parsePriceToRatio handles it exactly.
  //
  // Formula: marketCapEth = realSupply × priceEth × 1000
  //        = realSupply × (num / den) × 1000
  //        = (realSupply × num × 1000) / den  — then half-up round
  const ratio = priceEth ? _parsePriceToRatio(priceEth) : null;
  if (ratio && ratio.num > 0n) {
    const raw          = realSupply * ratio.num * 1000n;
    const quotient     = raw / ratio.den;
    const remainder    = raw % ratio.den;
    // Half-up rounding matches Math.round / Postgres ROUND semantics.
    const marketCapBig = remainder * 2n >= ratio.den ? quotient + 1n : quotient;
    update.marketCapEth = marketCapBig.toString();
  }

  return update;
}

/**
 * One-time startup backfill that corrects existing LaunchLab token rows stored
 * with the hardcoded 1B default supply before per-token supply fetching was added.
 *
 * Uses keyset pagination (ordered by `address`) to exhaust ALL matching rows in
 * a single run — no starvation: every batch advances the cursor past the rows
 * just seen, regardless of whether their supply needed correction.
 *
 * Standard-1B rows and RPC-failed rows are skipped (no DB write), but the
 * cursor still advances past them so they don't re-block later rows in the
 * same run.  On the next restart they will be re-checked (cheap — one RPC call
 * per token), which ensures any that failed transiently are retried.
 */
async function backfillLaunchLabSupply(): Promise<void> {
  let cursor     = ""; // keyset cursor — "" sorts before all valid base58 addresses
  let corrected  = 0;
  let totalSeen  = 0;

  for (;;) {
    const page = await db
      .select({ address: tokensTable.address, priceEth: tokensTable.priceEth })
      .from(tokensTable)
      .where(
        and(
          eq(tokensTable.platform, "raydium_launchlab"),
          eq(tokensTable.totalSupply, LL_DEFAULT_SUPPLY_STR),
          gt(tokensTable.address, cursor),
        ),
      )
      .orderBy(tokensTable.address)  // deterministic keyset order
      .limit(LL_SUPPLY_BACKFILL_PAGE);

    if (page.length === 0) break; // all matching rows exhausted

    if (totalSeen === 0) {
      log.info("enrichment: launchlab supply backfill started — paging through all legacy-default rows");
    }

    cursor    = page[page.length - 1]!.address; // advance cursor past this page
    totalSeen += page.length;

    for (const { address, priceEth } of page) {
      try {
        const realSupply     = await fetchMintTotalSupply(address);
        // Delegate guard check + exact totalSupply computation to the pure helper.
        // Returns null when realSupply is null (RPC failed) or matches the
        // standard 1B default (no correction needed). In both cases the
        // keyset cursor has already advanced past this row, so it is not
        // re-checked in the same run.
        const backfillUpdate = computeSupplyBackfillUpdate(realSupply, priceEth);
        if (!backfillUpdate) continue;

        const supplyStr = backfillUpdate.totalSupply;

        // Compare-and-set UPDATE:
        //   WHERE totalSupply = LL_DEFAULT_SUPPLY_STR prevents this write from
        //   overwriting a correction already applied by a concurrent process (e.g.
        //   another server restart) between our SELECT and this UPDATE.
        //
        // marketCapEth uses the current price_eth column value at write time — not
        // the stale priceEth from the page SELECT — so a trade that landed between
        // the SELECT and this UPDATE is reflected immediately.
        const [updated] = await db.update(tokensTable)
          .set({
            totalSupply:  supplyStr,
            marketCapEth: sql<string>`
              CASE
                WHEN price_eth IS NOT NULL AND CAST(price_eth AS numeric) > 0
                THEN ROUND(CAST(price_eth AS numeric) * CAST(${supplyStr} AS numeric) * 1000)::text
                ELSE market_cap_eth
              END
            `,
          })
          .where(and(
            eq(tokensTable.address, address),
            eq(tokensTable.totalSupply, LL_DEFAULT_SUPPLY_STR), // compare-and-set guard
          ))
          .returning({ address: tokensTable.address });

        if (!updated) continue; // concurrent process already corrected this row — skip

        corrected++;
        log.debug({ address, totalSupply: supplyStr },
          "enrichment: launchlab supply corrected");
      } catch (err) {
        log.warn({ address, err }, "enrichment: launchlab supply backfill failed for token");
      }
    }

    // Brief pause between pages to avoid overwhelming the free public RPC.
    await new Promise<void>(r => setTimeout(r, 150));
  }

  if (totalSeen === 0) {
    log.debug("enrichment: launchlab supply backfill — no legacy-default rows found");
  } else {
    log.info({ totalSeen, corrected },
      "enrichment: launchlab supply backfill complete");
  }
}

// ── LaunchLab trade-stat reconciliation ───────────────────────────────────────
//
// The fast-path adapter increments trade_count / volume_eth only after a
// confirmed DB insert (onConflictDoNothing returning a row).  This prevents
// new phantom stats from accumulating.
//
// This job acts as a belt-and-suspenders self-heal: every 10 minutes it
// recomputes the true trade_count and volume_eth for every LaunchLab token
// directly from the trades table, and corrects any rows that have drifted —
// whether from residual pre-fix phantom inserts, RPC retries, or edge cases
// not covered by the fast-path guard.

async function reconcileLabTradeStats(): Promise<void> {
  try {
    const result = await db.execute(sql`
      UPDATE tokens
      SET
        trade_count = subq.actual_count,
        volume_eth  = subq.actual_volume
      FROM (
        SELECT
          t.address,
          COALESCE(tr.cnt, 0)::int              AS actual_count,
          COALESCE(tr.vol, 0)::text             AS actual_volume
        FROM tokens t
        LEFT JOIN (
          SELECT
            token_address,
            COUNT(*)::int                        AS cnt,
            SUM(CAST(eth_amount AS NUMERIC))     AS vol
          FROM trades
          WHERE platform = 'raydium_launchlab'
          GROUP BY token_address
        ) tr ON t.address = tr.token_address
        WHERE t.platform = 'raydium_launchlab'
          AND (
            t.trade_count::int       != COALESCE(tr.cnt, 0)
            OR t.volume_eth::numeric != COALESCE(tr.vol, 0)
          )
      ) subq
      WHERE tokens.address = subq.address
    `);

    const corrected = (result as { rowCount?: number }).rowCount ?? 0;
    if (corrected > 0) {
      log.info({ corrected }, "enrichment: launchlab trade stats reconciled");
    }
  } catch (err) {
    log.warn({ err }, "enrichment: launchlab trade stats reconciliation failed");
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

let enrichmentStarted = false;
export function startEnrichmentLoop(): void {
  // Idempotence guard: a second call (e.g. hot-reload or worker-lock race)
  // must not install a second set of timers — that would double every request.
  if (enrichmentStarted) {
    log.warn("enrichment: startEnrichmentLoop called twice — ignoring duplicate");
    return;
  }
  enrichmentStarted = true;
  log.info({ intervalMs: POLL_INTERVAL_MS }, "enrichment: background loop started");
  const swallow = (label: string) => (err: unknown) =>
    log.error({ err }, `enrichment: ${label} failed — continuing`);

  // Run bonding-curve backfill immediately so existing tokens get real MC values
  void backfillBondingCurves().catch(swallow("backfillBondingCurves"));
  // Correct existing LaunchLab rows that were stored with the hardcoded 1B supply
  // before per-token supply fetching was added (e.g. USD1, other non-standard tokens).
  void backfillLaunchLabSupply().catch(swallow("backfillLaunchLabSupply"));
  // Detect tokens that graduated while the indexer was offline (missed migration events)
  void detectGraduations().catch(swallow("detectGraduations"));
  setInterval(() => void detectGraduations().catch(swallow("detectGraduations")), GRADUATION_DETECT_INTERVAL_MS);
  // Refresh PumpSwap token prices from DexScreener
  void enrichPumpSwapPrices().catch(swallow("enrichPumpSwapPrices"));
  setInterval(() => void enrichPumpSwapPrices().catch(swallow("enrichPumpSwapPrices")), PUMPSWAP_ENRICH_INTERVAL_MS);
  // Resolve LaunchLab tokens that still have '???' identity by re-reading the
  // creation transaction directly from the Solana RPC with an expanded offset set.
  // Runs 10 s after startup (adapters need a moment to settle) then every 60 s.
  setTimeout(() => {
    void enrichLabTokensFromChain().catch(swallow("enrichLabTokensFromChain-init"));
    setInterval(() => void enrichLabTokensFromChain().catch(swallow("enrichLabTokensFromChain")), LL_CHAIN_ENRICH_INTERVAL_MS);
  }, 10_000);
  // Refresh LaunchLab price + market cap from Birdeye every 60 s.
  // This gives accurate USD-derived values regardless of on-chain trade quality,
  // fixing both placeholder-MC and dust-trade price corruption for display.
  setTimeout(() => {
    void enrichLaunchLabPrices().catch(swallow("enrichLaunchLabPrices-init"));
    setInterval(() => void enrichLaunchLabPrices().catch(swallow("enrichLaunchLabPrices")), LL_PRICE_ENRICH_INTERVAL_MS);
  }, 15_000);
  // Re-sync LaunchLab bonding curve reserves from Raydium's pool API every 5 min.
  // Corrects drift that accumulated from constant-product estimation and also
  // fixes tokens whose reserves were never updated via the live TradeEvent path
  // (e.g. discovered via HTTP poll fallback without a WebSocket TradeEvent).
  // Run once 30 s after startup (let the DB settle first) then on a 5-min cadence.
  setTimeout(() => {
    void refreshLaunchLabReserves().catch(swallow("refreshLaunchLabReserves-init"));
    setInterval(() => void refreshLaunchLabReserves().catch(swallow("refreshLaunchLabReserves")), LL_RESERVE_REFRESH_INTERVAL_MS);
  }, 30_000);
  // Periodically mark LaunchLab tokens as graduated when virtual_eth_reserves
  // exceeds 115 SOL (30 virtual floor + 85 raised = graduation threshold).
  // This catches tokens where the adapter's reserve estimate drifted past the
  // threshold without triggering the in-trade guard (e.g. tokens seen before
  // the guard was added, or replayed events).
  const sweepLaunchLabGraduations = async () => {
    try {
      await db
        .update(tokensTable)
        .set({ graduated: true })
        .where(
          and(
            eq(tokensTable.platform, "raydium_launchlab"),
            eq(tokensTable.graduated, false),
            sql`CAST(${tokensTable.virtualEthReserves} AS NUMERIC) > 115`,
          ),
        );
    } catch (err) {
      log.warn({ err }, "enrichment: launchlab graduation sweep failed");
    }
  };
  void sweepLaunchLabGraduations();
  setInterval(() => void sweepLaunchLabGraduations(), 5 * 60_000); // every 5 min
  // Self-healing reconciliation: recomputes trade_count and volume_eth from the
  // actual trades table and corrects any divergence from phantom stats.
  // Starts 5 minutes after startup (let adapters settle) then every 10 minutes.
  setTimeout(() => {
    void reconcileLabTradeStats();
    setInterval(() => void reconcileLabTradeStats(), LL_STATS_RECONCILE_INTERVAL_MS);
  }, 5 * 60_000);
  // First tick slightly delayed so adapters can connect and insert initial records
  setTimeout(() => {
    void enrichTick();
    setInterval(() => void enrichTick(), POLL_INTERVAL_MS);
  }, 5_000);
}

const LL_INIT_VTOK_BIG      = 1_000_000_000_000_000n; // 1B tokens × 10^6

interface RaydiumPoolsResponse {
  success?: boolean;
  data?: {
    count?: number;
    data?: RaydiumPoolEntry[];
  };
}

/** LaunchLab program ID — used to verify a pool is the bonding-curve pool,
 *  not a post-graduation CPMM/CLMM pool created for the same mint. */
const LL_POOL_PROGRAM_ID = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

const LL_INIT_VSOL_LAM_BIG  = 30_000_000_000n;

const LL_VIRTUAL_SOL_FLOOR  = 30;           // SOL — constant virtual floor

const LL_RESERVE_REFRESH_INTERVAL_MS = 5 * 60_000; // every 5 minutes

const LL_GRADUATION_VSOL    = 115;          // SOL — vSol at graduation

const LL_RESERVE_REFRESH_BATCH       = 40;          // mints per Raydium API call

const LL_K0_BIG             = LL_INIT_VSOL_LAM_BIG * LL_INIT_VTOK_BIG;

interface RaydiumPoolEntry {
  programId?:   string;
  mintA?: { address?: string };
  mintB?: { address?: string };
  mintAmountA?: number;
  mintAmountB?: number;
}

/**
 * Periodic job: resync virtualEthReserves and virtualTokenReserves for all
 * non-graduated LaunchLab tokens from actual Raydium pool state.
 *
 * Uses a rotating offset (_llReserveOffset) so every tick processes a different
 * slice of the token table ordered by address.  One full rotation covers every
 * token in ceil(N / LL_RESERVE_REFRESH_BATCH) ticks — no token is permanently
 * skipped regardless of trade volume.  The offset resets to 0 when a partial
 * page is returned, signalling the end of the table.
 *
 * Only writes when the delta is ≥ 0.01 SOL to avoid unnecessary DB churn for
 * tokens with no new activity since the last refresh.
 */
async function refreshLaunchLabReserves(): Promise<void> {
  const tokens = await db
    .select({
      address:            tokensTable.address,
      totalSupply:        tokensTable.totalSupply,
      virtualEthReserves: tokensTable.virtualEthReserves,
    })
    .from(tokensTable)
    .where(
      and(
        eq(tokensTable.platform, "raydium_launchlab"),
        eq(tokensTable.graduated, false),
      ),
    )
    .orderBy(tokensTable.address) // deterministic order so the offset cursor is stable
    .limit(LL_RESERVE_REFRESH_BATCH)
    .offset(_llReserveOffset);

  // Advance the rotating offset.  A partial page means we've reached the end
  // of the table — reset to 0 so the next tick starts from the beginning again.
  if (tokens.length < LL_RESERVE_REFRESH_BATCH) {
    _llReserveOffset = 0;
  } else {
    _llReserveOffset += LL_RESERVE_REFRESH_BATCH;
  }

  if (tokens.length === 0) return;

  let updated = 0;

  for (const token of tokens) {
    try {
      const realSol = await fetchLabPoolRealSol(token.address);
      if (realSol === null) continue; // no LaunchLab pool yet (very fresh or already graduated)

      // Virtual SOL = real SOL in pool + 30 SOL constant floor
      const newVSolSol = realSol + LL_VIRTUAL_SOL_FLOOR;

      // Sanity check: must be in [30, 200] SOL to be a valid pre-graduation reserve
      if (newVSolSol < LL_VIRTUAL_SOL_FLOOR || newVSolSol > 200) continue;

      // Skip update when the delta is < 0.01 SOL (avoids unnecessary DB writes
      // for tokens with no new activity since the last tick).
      const storedVSol = parseFloat(token.virtualEthReserves ?? "30");
      if (Math.abs(newVSolSol - storedVSol) < 0.01) continue;

      // Recompute vTok from the constant-product invariant k = 30B_lam × totalSupply.
      // This keeps virtualTokenReserves internally consistent with virtualEthReserves.
      const newVSolLam   = BigInt(Math.round(newVSolSol * 1e9));
      const totalSup     = token.totalSupply && BigInt(token.totalSupply) > 0n
        ? BigInt(token.totalSupply)
        : LL_INIT_VTOK_BIG;
      const k            = LL_INIT_VSOL_LAM_BIG * totalSup;
      const newVTok      = k / newVSolLam;
      const vSolStr      = newVSolSol.toFixed(6).replace(/\.?0+$/, "");
      const graduatedNow = newVSolSol >= LL_GRADUATION_VSOL;

      await db.update(tokensTable).set({
        virtualEthReserves:   vSolStr,
        virtualTokenReserves: newVTok.toString(),
        ...(graduatedNow ? { graduated: true } : {}),
      }).where(eq(tokensTable.address, token.address));

      updated++;
    } catch (err) {
      log.warn({ address: token.address, err }, "enrichment: launchlab reserve refresh failed for token");
    }
  }

  if (updated > 0) {
    log.info({ updated, total: tokens.length, nextOffset: _llReserveOffset },
      "enrichment: launchlab bonding curve reserves refreshed from Raydium API");
  }
}

/**
 * Fetch the actual pool reserves for a LaunchLab token from Raydium's v3 API.
 *
 * Only accepts pools whose `programId` matches the LaunchLab program
 * (`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`).  This prevents
 * accidentally reading a post-graduation CPMM/CLMM pool for the same mint,
 * which would give unrelated liquidity amounts and corrupt the progress bar.
 *
 * Returns realSolInPool (SOL, decimal) or null when:
 *   - no LaunchLab pool exists for this token yet (very fresh, or already graduated)
 *   - all returned pools have a different programId
 *   - the response is malformed or times out
 *
 * Exported for unit testing.
 */
export async function fetchLabPoolRealSol(mint: string): Promise<number | null> {
  try {
    const url = `https://api-v3.raydium.io/pools/info/mint?mint1=${mint}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=5&page=1`;
    const res = await fetch(url, {
      signal:  AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Pumpi/1.0" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as RaydiumPoolsResponse;
    const pools = body.data?.data ?? [];

    for (const pool of pools) {
      // Only accept the LaunchLab bonding-curve pool — reject any CPMM/CLMM
      // pool created post-graduation for the same token mint.
      if (pool.programId !== LL_POOL_PROGRAM_ID) continue;

      const aAddr = pool.mintA?.address ?? "";
      const bAddr = pool.mintB?.address ?? "";
      const aAmt  = pool.mintAmountA;
      const bAmt  = pool.mintAmountB;

      // Find which side is SOL (WSOL) and which is the token
      if (aAddr === WSOL_MINT_ADDRESS && bAddr === mint && aAmt != null && aAmt >= 0) {
        return aAmt; // SOL is mintA
      }
      if (bAddr === WSOL_MINT_ADDRESS && aAddr === mint && bAmt != null && bAmt >= 0) {
        return bAmt; // SOL is mintB
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Rotating page offset so every tick covers a different slice of all non-graduated
 *  LaunchLab tokens, guaranteeing the full population is visited over time.
 *  Resets to 0 when a partial page is returned (end of table reached). */
let _llReserveOffset = 0;
