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

import { and, desc, gte, isNull, like, or, not, eq, inArray } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import { logger } from "./logger";
import { emitSnapshot } from "./tradeEmitter";

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

// ── Entry point ────────────────────────────────────────────────────────────────

export function startEnrichmentLoop(): void {
  log.info({ intervalMs: POLL_INTERVAL_MS }, "enrichment: background loop started");
  // First tick slightly delayed so adapters can connect and insert initial records
  setTimeout(() => {
    void enrichTick();
    setInterval(() => void enrichTick(), POLL_INTERVAL_MS);
  }, 5_000);
}
