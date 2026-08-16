/**
 * backfill-launchlab-names.ts — one-shot recovery of name/symbol/image for
 * LaunchLab tokens that were inserted as "???" placeholders.
 *
 * Context
 * ───────
 * When a LaunchLab token is first seen via a trade event (before its CREATE
 * transaction is indexed), the indexer inserts a stub row with:
 *   name   = "<addr8>…"
 *   symbol = "???"
 *   metadataUri = null
 *
 * The live enrichment loop handles these at 5 tokens/60 s (rate-limit safe for
 * a shared production server). With 276 existing placeholders that takes ~55 min.
 * This script processes all of them in one pass with higher throughput, then exits.
 *
 * Strategy (per token)
 * ────────────────────
 *   1. getSignaturesForAddress(mint) — paginate from newest to oldest until the
 *      history is fully exhausted (page < SIG_PAGE_SIZE entries) OR the
 *      createLaunchpad instruction is positively identified. The creation tx is
 *      always the oldest tx on a mint, so we keep paginating until the RPC
 *      returns a short page (end of history).
 *   2. decodeLabCreateParamsRaw() — Borsh decode with 13-offset probe set.
 *   3. fetchSafeUriMeta(uri) — fetch image / description / socials.
 *   4. UPDATE tokens SET name, symbol, imageUrl, … WHERE address = mint.
 *
 * Rate limiting
 * ─────────────
 * CONCURRENCY = 5 tokens processed in parallel.
 * BATCH_DELAY_MS = 600 ms pause between batches.
 * PAGE_DELAY_MS  = 300 ms pause between signature pages (per-token RPC pacing).
 * These keep free-RPC usage well within public rate limits.
 *
 * Outcomes
 * ────────
 * resolved       — name/symbol/image recovered and written to DB
 * skipped        — decoded fine but nothing to overwrite (already correct)
 * no_create_tx   — create tx not found AFTER full history scan (genuinely absent)
 * decode_failed  — create tx found but Borsh decode returned null
 * cap_exceeded   — safety page-cap hit before history was exhausted; re-run to retry
 * errored        — unexpected exception
 *
 * Run command (from monorepo root):
 *   pnpm --filter @workspace/api-server run backfill:launchlab-names
 */

import { and, eq, like, or } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import { fetchSafeUriMeta } from "../lib/safeUriFetch.js";
import { bs58Decode, decodeLabCreateParamsRaw } from "../lib/adapters/launchlabDecode.js";

// ── Config ────────────────────────────────────────────────────────────────────

const CONCURRENCY      = 5;    // tokens processed in parallel
const BATCH_DELAY_MS   = 600;  // pause between concurrent batches (ms)
const PAGE_DELAY_MS    = 300;  // pause between signature pages (per token, ms)
const RPC_TIMEOUT_MS   = 20_000;
const SIG_PAGE_SIZE    = 1000;

/**
 * Safety page cap — prevents infinite loops if an RPC always returns exactly
 * SIG_PAGE_SIZE entries (pathological case). 200 pages × 1000 sigs = 200 000
 * transactions per mint, far beyond any realistic LaunchLab token.  When this
 * cap fires we report "cap_exceeded" (not "no_create_tx") so the operator knows
 * the search was truncated.
 */
const SAFETY_PAGE_CAP  = 200;

const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

const FREE_RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const extra = data ? " " + JSON.stringify(data) : "";
  console.log(`[${ts}] ${msg}${extra}`);
}

// ── RPC helpers ───────────────────────────────────────────────────────────────

async function rpcPost(body: unknown): Promise<unknown> {
  let lastErr: unknown;
  for (const url of FREE_RPCS) {
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Pumpi-Backfill/1.0" },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status} from ${url}`); continue; }
      const json = await res.json() as { error?: { code?: number } };
      const code = (json.error as { code?: number } | undefined)?.code;
      if (code === -32005 || code === 429) { lastErr = new Error(`rate-limited by ${url}`); continue; }
      return json;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("all RPC endpoints failed");
}

interface SigEntry { signature: string; err: unknown }
interface RpcTxResult { result?: Record<string, unknown> | null }

async function getSignaturesForMint(mint: string, before?: string): Promise<SigEntry[]> {
  const resp = (await rpcPost({
    jsonrpc: "2.0", id: 1,
    method:  "getSignaturesForAddress",
    params:  [mint, { limit: SIG_PAGE_SIZE, commitment: "confirmed", ...(before ? { before } : {}) }],
  })) as { result?: SigEntry[] };
  return resp.result ?? [];
}

async function getTransaction(sig: string): Promise<Record<string, unknown> | null> {
  const resp = (await rpcPost({
    jsonrpc: "2.0", id: 1,
    method:  "getTransaction",
    params:  [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }],
  })) as RpcTxResult;
  return resp.result ?? null;
}

// ── Decode helpers ────────────────────────────────────────────────────────────

function decodeFromTx(tx: Record<string, unknown>): { name: string; symbol: string; uri: string } | null {
  const meta = tx["meta"] as Record<string, unknown> | null;
  if (!meta || meta["err"]) return null;

  // Guard: only attempt decode on confirmed createLaunchpad transactions.
  // Trade instruction bytes at the same offsets can look like plausible strings,
  // so without this guard we risk writing garbage names to the DB.
  const logMessages = (meta["logMessages"] as string[]) ?? [];
  if (!logMessages.some(l => /Instruction:\s*createLaunchpad/i.test(l))) return null;

  const message = ((tx["transaction"] as Record<string, unknown>)?.["message"] as Record<string, unknown>) ?? {};
  const keys    = (message["accountKeys"] as Array<{ pubkey?: string } | string>) ?? [];
  const instrs  = (message["instructions"] as Array<{ programIdIndex: number; data: string }>) ?? [];

  const progIdx = keys.findIndex(k =>
    (typeof k === "string" ? k : (k as { pubkey?: string }).pubkey) === LAUNCHLAB_PROGRAM,
  );
  if (progIdx < 0) return null;

  const instr = instrs.find(i => i.programIdIndex === progIdx);
  if (!instr?.data) return null;

  try {
    return decodeLabCreateParamsRaw(bs58Decode(instr.data));
  } catch {
    return null;
  }
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Search for the createLaunchpad transaction on `mint` by paginating
 * getSignaturesForAddress from newest to oldest until one of:
 *   a) A short page (< SIG_PAGE_SIZE) is returned → history exhausted.
 *   b) SAFETY_PAGE_CAP pages reached → truncated search.
 *
 * Returns:
 *   { tx, exhausted: true }  — create tx found, full history confirmed scanned
 *   { tx, exhausted: false } — create tx found before full scan (shouldn't happen;
 *                              creation is always oldest, included for completeness)
 *   { tx: null, exhausted: true }  — full history scanned; no create tx found
 *   { tx: null, exhausted: false } — safety cap hit before history exhausted;
 *                                    the create tx may still exist further back
 */
async function findCreateTx(mint: string): Promise<{
  tx: Record<string, unknown> | null;
  exhausted: boolean;
  pagesScanned: number;
}> {
  let cursor: string | undefined;
  let lastPage: SigEntry[] = [];
  let pagesScanned = 0;
  let exhausted = false;

  for (let page = 0; page < SAFETY_PAGE_CAP; page++) {
    pagesScanned = page + 1;

    let sigs: SigEntry[];
    try {
      sigs = await getSignaturesForMint(mint, cursor);
    } catch (err) {
      // RPC error mid-pagination — stop here; we cannot claim history is exhausted.
      log(`findCreateTx: RPC error on page ${page + 1} for ${mint}`, { err: String(err) });
      break;
    }

    if (sigs.length === 0) {
      exhausted = true;
      break;
    }

    lastPage = sigs;

    if (sigs.length < SIG_PAGE_SIZE) {
      // Short page → we have reached the beginning of this mint's history.
      exhausted = true;
      break;
    }

    // Full page — more history exists; advance the cursor.
    cursor = sigs[sigs.length - 1]?.signature;

    // Pace between pages so we don't hammer the free RPC endpoint.
    await delay(PAGE_DELAY_MS);
  }

  if (!exhausted) {
    // Safety cap fired — report this so callers can distinguish from a genuine miss.
    return { tx: null, exhausted: false, pagesScanned };
  }

  // The creation tx is ALWAYS the oldest transaction on a mint — the last entry
  // of the last (oldest) page.  Try up to 3 candidates from the oldest end in
  // case the very last sig was a failed tx (err !== null).
  const validSigs = lastPage.filter(s => !s.err).map(s => s.signature);
  const candidates = [...validSigs].reverse().slice(0, 3);

  for (const sig of candidates) {
    try {
      const tx = await getTransaction(sig);
      if (!tx) continue;
      const decoded = decodeFromTx(tx);
      // decodeFromTx checks the createLaunchpad log guard internally.
      if (decoded !== null) return { tx, exhausted: true, pagesScanned };
    } catch { continue; }
  }

  // No decodable createLaunchpad tx in the oldest candidates.
  return { tx: null, exhausted: true, pagesScanned };
}

// ── Per-token recovery ────────────────────────────────────────────────────────

type Outcome = "resolved" | "no_create_tx" | "decode_failed" | "skipped" | "cap_exceeded";

interface TokenRow {
  address:     string;
  name:        string | null;
  symbol:      string | null;
  imageUrl:    string | null;
  description: string | null;
  twitterUrl:  string | null;
  telegramUrl: string | null;
  websiteUrl:  string | null;
  metadataUri: string | null;
}

async function recoverToken(token: TokenRow): Promise<Outcome> {
  // ── Step 1: find the create transaction on-chain ──────────────────────────
  const { tx: createTx, exhausted, pagesScanned } = await findCreateTx(token.address);

  if (!exhausted) {
    // Safety page cap fired before history was exhausted.
    // The creation tx may still exist beyond the scanned range — report this
    // separately so the operator knows to re-run and can investigate.
    log(`cap_exceeded: full history not scanned for ${token.address}`, { pagesScanned });
    return "cap_exceeded";
  }

  if (!createTx) {
    // Full history scanned; creation tx is genuinely absent (already-graduated
    // tokens with no create record, or off-chain token creation paths).
    return "no_create_tx";
  }

  // ── Step 2: decode name / symbol / uri ───────────────────────────────────
  const resolved = decodeFromTx(createTx);
  if (!resolved) return "decode_failed";

  // ── Step 3: fetch metadata URI for image / description / socials ──────────
  const update: Record<string, string | null> = {};

  const isPlaceholderName   = !token.name   || token.name   === "???" || token.name.endsWith("…") || token.name.endsWith("...");
  const isPlaceholderSymbol = !token.symbol || token.symbol === "???";

  if (isPlaceholderName   && resolved.name   && resolved.name   !== "???") update["name"]        = resolved.name;
  if (isPlaceholderSymbol && resolved.symbol && resolved.symbol !== "???") update["symbol"]      = resolved.symbol;
  if (resolved.uri && !token.metadataUri)                                  update["metadataUri"] = resolved.uri;

  if (resolved.uri) {
    try {
      const uriMeta = await fetchSafeUriMeta(resolved.uri);
      if (uriMeta) {
        if (uriMeta.imageUrl    && !token.imageUrl)    update["imageUrl"]    = uriMeta.imageUrl;
        if (uriMeta.description && !token.description) update["description"] = uriMeta.description;
        if (uriMeta.twitterUrl  && !token.twitterUrl)  update["twitterUrl"]  = uriMeta.twitterUrl;
        if (uriMeta.telegramUrl && !token.telegramUrl) update["telegramUrl"] = uriMeta.telegramUrl;
        if (uriMeta.websiteUrl  && !token.websiteUrl)  update["websiteUrl"]  = uriMeta.websiteUrl;
      }
    } catch { /* non-critical */ }
  }

  if (Object.keys(update).length === 0) return "skipped";

  // ── Step 4: persist ───────────────────────────────────────────────────────
  await db.update(tokensTable)
    .set(update)
    .where(eq(tokensTable.address, token.address));

  log("resolved", {
    address: token.address,
    name:    update["name"]    ?? token.name,
    symbol:  update["symbol"]  ?? token.symbol,
    hasImg:  !!update["imageUrl"],
    pages:   pagesScanned,
  });

  return "resolved";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("backfill-launchlab-names: starting");

  // Query all placeholder LaunchLab tokens
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
      metadataUri: tokensTable.metadataUri,
    })
    .from(tokensTable)
    .where(
      and(
        eq(tokensTable.platform, "raydium_launchlab"),
        or(
          like(tokensTable.symbol, "???"),
          like(tokensTable.name,   "%…"),
          like(tokensTable.name,   "%..."),
        ),
      ),
    )
    .orderBy(tokensTable.createdAt); // oldest first → most likely to have settled on-chain

  log(`backfill-launchlab-names: found ${tokens.length} placeholder tokens`);

  if (tokens.length === 0) {
    log("backfill-launchlab-names: nothing to do — exiting");
    return;
  }

  const stats: Record<Outcome | "errored", number> = {
    resolved:     0,
    no_create_tx: 0,
    decode_failed: 0,
    skipped:      0,
    cap_exceeded: 0,
    errored:      0,
  };

  // Process CONCURRENCY tokens at a time with a delay between batches.
  for (let i = 0; i < tokens.length; i += CONCURRENCY) {
    const batch = tokens.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(t => recoverToken(t)));

    for (const result of results) {
      if (result.status === "fulfilled") {
        stats[result.value]++;
      } else {
        stats.errored++;
        log("error", { err: String(result.reason) });
      }
    }

    const done = Math.min(i + CONCURRENCY, tokens.length);
    log(`progress: ${done}/${tokens.length}`, { ...stats });

    if (done < tokens.length) await delay(BATCH_DELAY_MS);
  }

  log("backfill-launchlab-names: complete", { ...stats });

  if (stats.cap_exceeded > 0) {
    log(
      `WARNING: ${stats.cap_exceeded} token(s) hit the ${SAFETY_PAGE_CAP}-page safety cap.` +
      " Their histories were not fully scanned. Re-run the script to attempt recovery.",
    );
  }

  // Report remaining placeholders so callers can verify progress.
  const remaining = await db
    .select({ address: tokensTable.address })
    .from(tokensTable)
    .where(
      and(
        eq(tokensTable.platform, "raydium_launchlab"),
        or(
          like(tokensTable.symbol, "???"),
          like(tokensTable.name, "%…"),
          like(tokensTable.name, "%..."),
        ),
      ),
    );

  log(`backfill-launchlab-names: remaining placeholders after run: ${remaining.length}`);
}

main().catch(err => {
  console.error("backfill-launchlab-names: fatal error", err);
  process.exit(1);
});
