/**
 * Jupiter strict token list — in-memory cache with periodic refresh.
 *
 * Provides fast prefix-matched search across ~2 K curated Solana tokens
 * (BONK, WIF, JUP, USDC, etc.) without any external API calls at query time.
 *
 * The strict list is curated by Jupiter's trust system — it excludes
 * scam/honeypot tokens and is a good proxy for "established Solana tokens".
 *
 * Refresh schedule: downloaded once on startup, then every 6 hours.
 * File size: ~600 KB JSON.  Parsed and stored as a plain array.
 */

import { logger } from "./logger";

const log = logger.child({ module: "jupiter-tokens" });

export interface JupiterToken {
  address:  string;
  chainId:  number;
  decimals: number;
  name:     string;
  symbol:   string;
  logoURI?: string | null;
  tags?:    string[];
}

// Jupiter's strict token list via the current tokens.jup.ag API.
// Note: the legacy token.jup.ag domain is retired; tokens.jup.ag is the supported endpoint.
const STRICT_LIST_URL = "https://tokens.jup.ag/tokens?tags=strict";
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000; // 6 hours

let _tokens: JupiterToken[] = [];
let _lastFetch = 0;
let _fetching  = false;

// ── Fetch + store ─────────────────────────────────────────────────────────────

async function fetchList(): Promise<void> {
  if (_fetching) return;
  _fetching = true;
  try {
    const res = await fetch(STRICT_LIST_URL, {
      signal:  AbortSignal.timeout(30_000),
      headers: { "User-Agent": "RocketFi/1.0" },
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "jupiter-tokens: list fetch returned non-OK");
      return;
    }
    const data = (await res.json()) as JupiterToken[];
    if (Array.isArray(data) && data.length > 0) {
      _tokens    = data;
      _lastFetch = Date.now();
      log.info({ count: _tokens.length }, "jupiter-tokens: strict list refreshed");
    }
  } catch (err) {
    log.warn({ err }, "jupiter-tokens: list fetch failed (will retry at next interval)");
  } finally {
    _fetching = false;
  }
}

/** Call once at server startup. Downloads the list immediately and schedules 6-hourly refresh. */
export function startJupiterTokenSync(): void {
  void fetchList();
  setInterval(() => void fetchList(), REFRESH_INTERVAL_MS);
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Search the in-memory Jupiter token list by name or symbol.
 * Returns up to `limit` results, ranked by match quality:
 *   3 = exact symbol match
 *   2 = symbol starts with query
 *   1 = name starts with query
 *   0 = contains match
 *
 * @param excludeAddresses  Set of mint addresses to omit (e.g. already shown as platform tokens)
 */
export function searchJupiterTokens(
  query:            string,
  limit             = 5,
  excludeAddresses: Set<string> = new Set(),
): JupiterToken[] {
  const q = query.toLowerCase().trim();
  if (!q || _tokens.length === 0) return [];

  const results: Array<{ token: JupiterToken; score: number }> = [];

  for (const t of _tokens) {
    if (excludeAddresses.has(t.address)) continue;
    const sym  = t.symbol.toLowerCase();
    const name = t.name.toLowerCase();

    let score = -1;
    if (sym === q)              score = 3;
    else if (sym.startsWith(q)) score = 2;
    else if (name.startsWith(q)) score = 1;
    else if (sym.includes(q) || name.includes(q)) score = 0;

    if (score >= 0) results.push({ token: t, score });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.token);
}

/** Look up a single token by mint address from the cached list.  O(n) — for low-frequency use. */
export function getJupiterToken(address: string): JupiterToken | null {
  return _tokens.find((t) => t.address === address) ?? null;
}

/** True if the token list has been loaded at least once. */
export function isJupiterListReady(): boolean {
  return _lastFetch > 0;
}
