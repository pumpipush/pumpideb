/**
 * GET /api/blockhash
 *
 * Returns a recent Solana blockhash suitable for signing transactions.
 * The result is cached server-side for 1.5 s — every frontend user making a
 * trade in the same window shares a single Alchemy RPC call instead of each
 * burning their own Compute Unit budget.
 *
 * 1.5 s is safe because:
 *   - A new slot is produced every ~400 ms; a blockhash is valid for 150 slots
 *     (~60 s), so reusing a 1.5-s-old blockhash is well within the window.
 *   - We still stamp the tx right before the user signs, so the blockhash age
 *     at broadcast is always << 60 s.
 */

import { Router, type Request, type Response } from "express";

const router = Router();

// ── RPC endpoint — always use free public RPCs to avoid burning Alchemy CUs ──
// getLatestBlockhash is cheap to call on free RPCs and doesn't need Alchemy's
// premium reliability. Alchemy is reserved only for the WebSocket logsSubscribe.
const RPC_URLS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

// ── In-memory cache ───────────────────────────────────────────────────────────

interface BlockhashEntry {
  blockhash:            string;
  lastValidBlockHeight: number;
  fetchedAt:            number;
}

const CACHE_TTL_MS = 1_500; // 1.5 s — safe margin before blockhash re-fetch

let _cache: BlockhashEntry | null = null;
/** Inflight promise — deduplicates concurrent cache-miss fetches */
let _inflight: Promise<BlockhashEntry> | null = null;

async function getOrFetchBlockhash(): Promise<BlockhashEntry> {
  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) return _cache;

  // Dedup: if another request is already fetching, await the same promise
  if (_inflight) return _inflight;

  _inflight = (async () => {
    // Raw JSON-RPC call — no @solana/web3.js needed server-side
    let blockhash: string | undefined;
    let lastValidBlockHeight: number | undefined;
    for (const url of RPC_URLS) {
      try {
        const rpcRes = await fetch(url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            jsonrpc: "2.0",
            id:      1,
            method:  "getLatestBlockhash",
            params:  [{ commitment: "confirmed" }],
          }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!rpcRes.ok) continue;
        const json = await rpcRes.json() as {
          result: { value: { blockhash: string; lastValidBlockHeight: number } };
          error?: { message: string };
        };
        if (json.error) continue;
        blockhash           = json.result.value.blockhash;
        lastValidBlockHeight = json.result.value.lastValidBlockHeight;
        break;
      } catch { continue; }
    }
    if (!blockhash || lastValidBlockHeight === undefined) throw new Error("All RPC endpoints failed for getLatestBlockhash");
    const entry: BlockhashEntry = { blockhash, lastValidBlockHeight, fetchedAt: Date.now() };
    _cache    = entry;
    _inflight = null;
    return entry;
  })();

  return _inflight;
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get("/blockhash", async (_req: Request, res: Response) => {
  const { blockhash, lastValidBlockHeight } = await getOrFetchBlockhash();
  // Allow the CDN / browser to cache for 1 s (conservative, short-lived)
  res.setHeader("Cache-Control", "public, max-age=1");
  res.json({ blockhash, lastValidBlockHeight });
});

export default router;
