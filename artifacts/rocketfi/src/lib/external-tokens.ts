/**
 * External Solana token support — metadata cache + client-side Jupiter token list.
 *
 * Two responsibilities:
 *
 * 1. Navigation-time metadata cache (module-level Map)
 *    When a user clicks an "All Solana Tokens" search result, their metadata is stored
 *    here before the SPA navigates to /app?token=<mint>. AppInterface reads it back
 *    when the DB lookup returns 404.
 *
 * 2. Session-level Jupiter strict-list cache
 *    The browser fetches the strict list (~200 KB JSON) lazily on first search.
 *    On failure the list stays null so the next call after a backoff window can retry.
 *    Successful load is persistent for the session.
 *
 *    The list lets ExternalTokenLoader resolve any address even on direct URL / reload,
 *    and lets SearchDialog show "All Solana Tokens" results.
 */

/* ── Types ──────────────────────────────────────────────────────────────────── */

export interface ExternalSolanaToken {
  address:  string;
  name:     string;
  symbol:   string;
  logoURI:  string | null;
  /** SPL token decimal places (needed to convert atoms ↔ display amount) */
  decimals: number;
}

/* ── Navigation-time metadata cache ─────────────────────────────────────────── */

const _store = new Map<string, ExternalSolanaToken>();

export function setExternalToken(token: ExternalSolanaToken): void {
  _store.set(token.address, token);
}

export function getExternalToken(address: string): ExternalSolanaToken | null {
  return _store.get(address) ?? null;
}

/* ── Jupiter strict-list cache ───────────────────────────────────────────────
 *
 * URL: Jupiter's current token API (tokens.jup.ag replaces the retired token.jup.ag).
 *
 * Retry strategy: on failure _list stays null so any subsequent call after the
 * backoff window automatically triggers a new fetch.  Subscribers are notified
 * after every attempt (success or failure) via a persistent callback set, so
 * the React queryKey can increment and trigger a React Query re-fetch each time.
 */

const LIST_URL = "https://tokens.jup.ag/tokens?tags=strict";

// Exponential-ish backoff delays for consecutive fetch failures (ms).
const RETRY_DELAYS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000]; // 30s → 2m → 10m → 30m

let _list: ExternalSolanaToken[] | null = null; // null = not yet loaded
let _fetching      = false;
let _retryCount    = 0;
let _nextRetryAt   = 0;          // epoch ms; 0 means "can fetch now"

// Persistent subscriber set — notified after EVERY attempt (success or failure).
// Kept alive (not cleared) so new subscribers added after the first attempt can
// also be notified on the next retry completion.
const _attemptCallbacks = new Set<() => void>();

/** Call cb after every fetch attempt (success or failure, including retries). */
export function subscribeToJupiterAttempts(cb: () => void): () => void {
  _attemptCallbacks.add(cb);
  return () => _attemptCallbacks.delete(cb);
}

function _notifyAttempt(): void {
  _attemptCallbacks.forEach((fn) => fn());
}

/**
 * Validate and normalise a raw token-list response.
 * Accepts both the old (array root) and new (array root) formats from jup.ag.
 */
function _parseResponse(raw: unknown): ExternalSolanaToken[] {
  if (!Array.isArray(raw)) return [];
  const result: ExternalSolanaToken[] = [];
  for (const item of raw) {
    if (
      typeof item !== "object" || item === null ||
      typeof item.address  !== "string" ||
      typeof item.name     !== "string" ||
      typeof item.symbol   !== "string" ||
      typeof item.decimals !== "number"
    ) continue;
    result.push({
      address:  item.address,
      name:     item.name,
      symbol:   item.symbol,
      logoURI:  typeof item.logoURI === "string" ? item.logoURI : null,
      decimals: item.decimals,
    });
  }
  return result;
}

/**
 * Ensure the Jupiter strict token list is loaded.
 * - Returns immediately if already loaded.
 * - Waits for an in-flight fetch to complete.
 * - On failure keeps _list as null and sets a backoff timer;
 *   the next call after the timer expires will retry.
 */
export async function ensureJupiterList(): Promise<ExternalSolanaToken[]> {
  // Already loaded successfully — return immediately.
  if (_list !== null) return _list;

  // Within a backoff window from a previous failure — skip.
  if (_nextRetryAt > 0 && Date.now() < _nextRetryAt) {
    return [];
  }

  // Another fetch is in flight — wait for it to finish.
  if (_fetching) {
    return new Promise<ExternalSolanaToken[]>((resolve) => {
      const off = subscribeToJupiterAttempts(() => {
        off();
        resolve(_list ?? []);
      });
    });
  }

  _fetching = true;
  try {
    const res = await fetch(LIST_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${LIST_URL}`);
    const raw = await res.json();
    const parsed = _parseResponse(raw);
    if (parsed.length === 0) throw new Error("Token list returned 0 valid entries");
    _list       = parsed;
    _retryCount = 0;
    _nextRetryAt = 0;
  } catch {
    // Leave _list as null so the next in-window check passes after backoff.
    const delay   = RETRY_DELAYS[Math.min(_retryCount, RETRY_DELAYS.length - 1)];
    _nextRetryAt  = Date.now() + delay;
    _retryCount++;
  } finally {
    _fetching = false;
    _notifyAttempt(); // notify subscribers; SearchDialog queryKey bumps on every attempt
  }
  return _list ?? [];
}

/**
 * Search the cached Jupiter list by name or symbol.
 * Returns up to `limit` results ranked by match quality.
 * Returns [] if the list has not been loaded yet.
 */
export function searchClientJupiterTokens(
  query:            string,
  limit             = 5,
  excludeAddresses: Set<string> = new Set(),
): ExternalSolanaToken[] {
  if (!_list || _list.length === 0) return [];
  const q      = query.toLowerCase().trim();
  const scored: Array<{ t: ExternalSolanaToken; s: number }> = [];
  for (const t of _list) {
    if (excludeAddresses.has(t.address)) continue;
    const sym  = t.symbol.toLowerCase();
    const name = t.name.toLowerCase();
    let s = -1;
    if (sym === q)               s = 3;
    else if (sym.startsWith(q))  s = 2;
    else if (name.startsWith(q)) s = 1;
    else if (sym.includes(q) || name.includes(q)) s = 0;
    if (s >= 0) scored.push({ t, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.t);
}

/**
 * Look up a single token by mint address from the cached list.
 * Returns null if not found or list not yet loaded.
 */
export function getJupiterTokenByAddress(address: string): ExternalSolanaToken | null {
  if (!_list) return null;
  return _list.find((t) => t.address === address) ?? null;
}
