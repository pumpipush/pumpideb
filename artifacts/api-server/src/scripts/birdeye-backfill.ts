/**
 * birdeye-backfill.ts — one-time backfill script.
 *
 * Seeds the DB with tokens from Raydium, Orca, Meteora, and PumpSwap using
 * a combination of each DEX's native REST API and Birdeye for price data.
 *
 * Strategy per DEX:
 *   Raydium  — Raydium V3 REST API  (no auth required, 5 pages × 50 pools)
 *   Orca     — Orca Whirlpool API   (no auth required, full list ~15k pools)
 *   Meteora  — Meteora DLMM API     (no auth required)
 *   PumpSwap — graduated pump.fun tokens already in DB; route handles this
 *
 * Birdeye is used for:
 *   - Current SOL price (for priceEth / marketCapEth conversion)
 *   - Price / market cap of tokens that native APIs don't provide
 *
 * Run once on VPS before starting the real-time indexer:
 *   pnpm --filter @workspace/api-server run backfill:birdeye
 *
 * Safe to re-run — uses ON CONFLICT DO UPDATE to refresh prices.
 */

import { db, tokensTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getSolPriceUsd, fetchBirdeyeTokenMeta, usdToLamports } from "../lib/birdeye.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const CHAIN = "solana";

const STABLE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",   // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH (Wormhole)
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // JitoSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",  // bSOL
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y68YB", // stSOL
]);

const BIRDEYE_ENRICH_DELAY_MS = 200; // stay within Birdeye rate limits
const REQUEST_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isStable(mint: string): boolean {
  return STABLE_MINTS.has(mint);
}

// ── Token upsert helper ───────────────────────────────────────────────────────

interface TokenRecord {
  address:       string;
  name:          string;
  symbol:        string;
  imageUrl?:     string | null;
  platform:      string;
  poolAddress?:  string | null;
  quoteMint?:    string | null;
  priceUsd?:     number | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  volumeUsd?:    number | null;
  pctChange24h?: number | null;
}

async function upsertToken(token: TokenRecord, solPrice: number): Promise<boolean> {
  if (!token.address || !token.name || !token.symbol) return false;
  if (isStable(token.address)) return false;
  if (token.name.trim() === "" || token.symbol.trim() === "") return false;

  const priceEth     = token.priceUsd     ? usdToLamports(token.priceUsd,     solPrice) : null;
  const marketCapEth = token.marketCapUsd ? usdToLamports(token.marketCapUsd, solPrice) : null;
  const volumeEth    = token.volumeUsd    ? usdToLamports(token.volumeUsd,    solPrice) : "0";

  try {
    await db.insert(tokensTable).values({
      address:        token.address,
      name:           token.name.trim().slice(0, 128),
      symbol:         token.symbol.trim().slice(0, 32),
      imageUrl:       token.imageUrl ?? null,
      creatorAddress: "unknown",
      platform:       token.platform,
      chain:          CHAIN,
      priceEth,
      marketCapEth,
      volumeEth,
      graduated:      true,
      poolAddress:    token.poolAddress ?? null,
      quoteMint:      token.quoteMint   ?? null,
      liquidityUsd:   token.liquidityUsd ?? null,
      priceUsd:       token.priceUsd    ?? null,
      marketCapUsd:   token.marketCapUsd ?? null,
      pctChange24h:   token.pctChange24h ?? null,
    }).onConflictDoUpdate({
      target: tokensTable.address,
      set: {
        priceEth,
        marketCapEth,
        volumeEth,
        priceUsd:     token.priceUsd    ?? null,
        marketCapUsd: token.marketCapUsd ?? null,
        liquidityUsd: token.liquidityUsd ?? null,
        poolAddress:  token.poolAddress ?? null,
        pctChange24h: token.pctChange24h ?? null,
      },
    });
    return true;
  } catch (err) {
    console.warn(`[backfill] upsert error for ${token.address}:`, err);
    return false;
  }
}

// ── Raydium backfill (native API) ─────────────────────────────────────────────

interface RaydiumMint {
  address: string; name: string; symbol: string; decimals: number; logoURI?: string;
}
interface RaydiumPool {
  id: string; mintA: RaydiumMint; mintB: RaydiumMint;
  price: number; tvl: number; day: { volume: number };
}

async function backfillRaydium(solPrice: number): Promise<number> {
  console.log("[backfill] ── RAYDIUM (Raydium V3 REST API) ──");
  let total = 0;

  for (let page = 1; page <= 5; page++) {
    try {
      const res = await fetch(
        `https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=volume24h&sortType=desc&pageSize=50&page=${page}`,
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!res.ok) { console.warn(`[backfill] raydium page ${page}: HTTP ${res.status}`); break; }
      const json = await res.json() as { data?: { data?: RaydiumPool[] } };
      const pools = json.data?.data ?? [];
      if (pools.length === 0) break;

      let inserted = 0;
      for (const pool of pools) {
        const aIsStable = isStable(pool.mintA.address);
        const bIsStable = isStable(pool.mintB.address);
        if (aIsStable === bIsStable) continue;

        const tokenMint = aIsStable ? pool.mintB : pool.mintA;
        const quoteMint = aIsStable ? pool.mintA : pool.mintB;
        const rawPrice  = aIsStable ? (pool.price > 0 ? 1 / pool.price : 0) : pool.price;
        const quoteIsUsd = quoteMint.address !== "So11111111111111111111111111111111111111112";
        const priceUsd   = quoteIsUsd ? rawPrice : rawPrice * solPrice;

        const ok = await upsertToken({
          address:     tokenMint.address,
          name:        tokenMint.name || tokenMint.symbol,
          symbol:      tokenMint.symbol,
          imageUrl:    tokenMint.logoURI,
          platform:    "raydium",
          poolAddress: pool.id,
          quoteMint:   quoteMint.address,
          priceUsd,
          liquidityUsd: pool.tvl,
          volumeUsd:   pool.day?.volume,
        }, solPrice);
        if (ok) inserted++;
      }
      console.log(`[backfill]   page ${page}: ${pools.length} pools, ${inserted} upserted`);
      total += inserted;
    } catch (err) {
      console.warn(`[backfill] raydium page ${page} error:`, err);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`[backfill] Raydium total: ${total} tokens upserted`);
  return total;
}

// ── Orca backfill (native Whirlpool API) ──────────────────────────────────────

interface OrcaToken {
  mint: string; symbol: string; name: string; decimals: number; logoURI?: string;
}
interface OrcaWhirlpool {
  address: string; tokenA: OrcaToken; tokenB: OrcaToken;
  price: number; tvl?: number; volume?: { day?: number };
}

async function backfillOrca(solPrice: number): Promise<number> {
  console.log("[backfill] ── ORCA (Orca Whirlpool API) ──");
  let total = 0;

  try {
    const res = await fetch("https://api.orca.so/v1/whirlpool/list", {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[backfill] orca: HTTP ${res.status}`);
      return 0;
    }
    const json = await res.json() as { whirlpools?: OrcaWhirlpool[] };
    const whirlpools = json.whirlpools ?? [];
    console.log(`[backfill] Orca: ${whirlpools.length} whirlpools`);

    // Sort by TVL descending, take top 300 interesting pools
    const interesting = whirlpools
      .filter(w => {
        const aStable = isStable(w.tokenA.mint);
        const bStable = isStable(w.tokenB.mint);
        return aStable !== bStable; // one side is stable, one is the token
      })
      .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))
      .slice(0, 300);

    console.log(`[backfill] Orca: ${interesting.length} interesting pools (non-stable pairs)`);

    for (const pool of interesting) {
      const aStable   = isStable(pool.tokenA.mint);
      const tokenMint = aStable ? pool.tokenB : pool.tokenA;
      const quoteMint = aStable ? pool.tokenA : pool.tokenB;

      // Price calculation: pool.price = tokenA price in tokenB units
      // If tokenB is the stable: priceInQuote = pool.price
      // If tokenA is the stable: priceInQuote = 1/pool.price
      const rawPrice   = aStable ? (pool.price > 0 ? 1 / pool.price : 0) : pool.price;
      const quoteIsUsd = quoteMint.mint !== "So11111111111111111111111111111111111111112";
      const priceUsd   = quoteIsUsd ? rawPrice : rawPrice * solPrice;

      const ok = await upsertToken({
        address:     tokenMint.mint,
        name:        tokenMint.name || tokenMint.symbol,
        symbol:      tokenMint.symbol,
        imageUrl:    tokenMint.logoURI,
        platform:    "orca",
        poolAddress: pool.address,
        quoteMint:   quoteMint.mint,
        priceUsd:    priceUsd > 0 ? priceUsd : null,
        liquidityUsd: pool.tvl ?? null,
        volumeUsd:   pool.volume?.day ?? null,
      }, solPrice);
      if (ok) total++;
    }
  } catch (err) {
    console.warn("[backfill] orca error:", err);
  }

  console.log(`[backfill] Orca total: ${total} tokens upserted`);
  return total;
}

// ── Meteora backfill (AMM REST API) ──────────────────────────────────────────

interface MeteoraAmmPool {
  pool_address:          string;
  pool_name:             string;    // e.g. "SOL-USDC"
  pool_token_mints:      string[];  // [mintA, mintB]
  pool_token_amounts:    string[];  // token amounts as strings
  pool_token_usd_amounts: number[]; // USD value of each side
  pool_tvl:              number;
}

async function backfillMeteora(solPrice: number): Promise<number> {
  console.log("[backfill] ── METEORA (AMM REST API) ──");
  let total = 0;

  // Fetch all AMM pools (returns ~36k rows, but we only need the interesting ones)
  // API returns the full list so we'll take top 300 by TVL
  let pools: MeteoraAmmPool[] = [];
  try {
    const res = await fetch("https://amm.meteora.ag/pools", {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[backfill] Meteora AMM API: HTTP ${res.status}`);
      return 0;
    }
    const json = await res.json() as MeteoraAmmPool[];
    pools = Array.isArray(json) ? json : [];
    console.log(`[backfill] Meteora: fetched ${pools.length} AMM pools`);
  } catch (err) {
    console.warn("[backfill] Meteora AMM API error:", String(err).split("\n")[0]);
    return 0;
  }

  // Filter: one side stable, one side interesting; sort by TVL; take top 200
  const interesting = pools
    .filter(p => {
      const mints = p.pool_token_mints ?? [];
      if (mints.length !== 2) return false;
      const aStable = isStable(mints[0]);
      const bStable = isStable(mints[1]);
      return aStable !== bStable;
    })
    .sort((a, b) => (Number(b.pool_tvl) || 0) - (Number(a.pool_tvl) || 0))
    .slice(0, 200);

  console.log(`[backfill] Meteora: ${interesting.length} interesting pools (TVL sorted)`);

  for (const pool of interesting) {
    const [mintA, mintB]     = pool.pool_token_mints;
    const [usdA, usdB]       = pool.pool_token_usd_amounts ?? [0, 0];
    const aStable            = isStable(mintA);
    const tokenMint          = aStable ? mintB : mintA;
    const quoteMint          = aStable ? mintA : mintB;

    // Price = USD value of token side / amount of tokens
    // Simpler: fetch from Birdeye since we have good CU budget
    const meta = await fetchBirdeyeTokenMeta(tokenMint);
    if (!meta) continue;

    // Use USD amounts from pool for price estimate if Birdeye has no price
    const tokenUsd  = aStable ? usdB : usdA;
    const quoteUsd  = aStable ? usdA : usdB;
    const tvl       = (tokenUsd + quoteUsd) > 0 ? tokenUsd + quoteUsd : pool.pool_tvl;

    const ok = await upsertToken({
      address:      tokenMint,
      name:         meta.name,
      symbol:       meta.symbol,
      imageUrl:     meta.logoURI,
      platform:     "meteora",
      poolAddress:  pool.pool_address,
      quoteMint,
      priceUsd:     meta.priceUsd,
      marketCapUsd: meta.marketCapUsd,
      liquidityUsd: tvl > 0 ? tvl : null,
      volumeUsd:    null,
      pctChange24h: meta.priceChange24h ?? null,
    }, solPrice);
    if (ok) total++;

    await sleep(BIRDEYE_ENRICH_DELAY_MS);
  }

  console.log(`[backfill] Meteora total: ${total} tokens upserted`);
  return total;
}

// ── PumpSwap note ─────────────────────────────────────────────────────────────

function notePumpSwap(): void {
  console.log("[backfill] ── PUMPSWAP ──");
  console.log("[backfill] PumpSwap = graduated pump.fun tokens already in DB.");
  console.log("[backfill] The tokens route now shows pump_fun graduated tokens on the PumpSwap tab.");
  console.log("[backfill] Real-time PumpSwap events will be indexed on VPS with ENABLE_STREAMING_ADAPTERS=1");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[backfill] Starting multi-DEX backfill...");

  if (!process.env.BIRDEYE_API_KEY) {
    console.error("[backfill] BIRDEYE_API_KEY not set — aborting");
    process.exit(1);
  }

  const solPrice = await getSolPriceUsd();
  console.log(`[backfill] SOL price: $${solPrice.toFixed(2)}`);

  const raydiumCount  = await backfillRaydium(solPrice);
  await sleep(500);
  const orcaCount     = await backfillOrca(solPrice);
  await sleep(500);
  const meteoraCount  = await backfillMeteora(solPrice);
  notePumpSwap();

  console.log(`\n[backfill] ═══════════════════════════════════════════`);
  console.log(`[backfill] DONE — Total upserted:`);
  console.log(`[backfill]   Raydium  : ${raydiumCount}`);
  console.log(`[backfill]   Orca     : ${orcaCount}`);
  console.log(`[backfill]   Meteora  : ${meteoraCount}`);
  console.log(`[backfill]   PumpSwap : see DB (pump_fun graduated=true)`);
  console.log(`[backfill] ═══════════════════════════════════════════`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
