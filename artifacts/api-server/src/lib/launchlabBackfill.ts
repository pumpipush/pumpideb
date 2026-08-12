/**
 * Raydium LaunchLab historical token backfill.
 *
 * Since the Raydium LaunchLab private API is inaccessible from hosted
 * environments, we replay historical on-chain creation transactions directly
 * from the Solana RPC — the same source raydium.io/launchpad/ uses internally.
 *
 * Strategy:
 *   1. getSignaturesForAddress(LaunchLab program, limit=1000) — get recent sigs
 *   2. Batch-fetch transactions 10 at a time via JSON-RPC
 *   3. Keep only those whose logs contain "createLaunchpad"
 *   4. Decode name / symbol / uri from Borsh instruction data
 *   5. Insert missing tokens into DB (onConflictDoNothing)
 *   6. Async-fetch URI metadata (image / description / socials) per token
 *
 * Two modes:
 *   - Regular backfill: runs every BACKFILL_INTERVAL_MS, fetches last 1000 sigs
 *   - Deep backfill: runs ONCE on first startup, paginates ALL history using the
 *     `before` cursor until the Solana genesis is reached (or DEEP_CUTOFF_DATE).
 *     A marker file prevents it from re-running on subsequent restarts.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { eq } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import { logger as rootLogger } from "./logger";
import { fetchSafeUriMeta } from "./safeUriFetch";
import { bs58Decode, decodeLabCreateParamsRaw } from "./adapters/launchlabDecode";

const log = rootLogger.child({ module: "launchlab-backfill" });

const LAUNCHLAB_PROGRAM     = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const PLATFORM              = "raydium_launchlab";
const CHAIN                 = "solana";
const BACKFILL_SIG_LIMIT    = 1000;  // signatures per page (max Solana allows)
const BATCH_SIZE            = 10;    // getTransaction calls per HTTP request
const BATCH_DELAY_MS        = 250;   // ms between batches (rate-limit protection)
const BACKFILL_INTERVAL_MS  = 10 * 60_000; // re-run every 10 min
const BATCH_MAX_RETRIES     = 3;           // max retry attempts per batch on RPC failure
const BATCH_RETRY_BASE_MS   = 2_000;       // base wait: 2 s → 4 s → 8 s (exponential)

// Deep backfill: stop paging if we go past this timestamp (LaunchLab didn't exist before this).
// Raydium LaunchLab launched on Solana mainnet in late 2024.
// Using 2024-10-01 as a conservative lower bound.
const DEEP_CUTOFF_TIMESTAMP = Math.floor(new Date("2024-10-01T00:00:00Z").getTime() / 1000);

// Marker file: once written, deep backfill is skipped on subsequent restarts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEEP_BACKFILL_MARKER = path.resolve(__dirname, "../../.launchlab-deep-backfill-done");

// ── Bonding curve genesis constants (same as raydium-launchlab adapter) ────────
const LL_TOTAL_SUPPLY     = 1_000_000_000_000_000n;
const LL_INIT_VSOL_SOL    = "30";
const LL_INIT_VSOL_LAM    = 30_000_000_000n;
const LL_INIT_VTOK        = LL_TOTAL_SUPPLY;
const LL_INIT_MC_LAMPORTS = (LL_TOTAL_SUPPLY * LL_INIT_VSOL_LAM / LL_INIT_VTOK).toString();
const LL_INIT_PRICE_ETH   = (Number(LL_INIT_VSOL_LAM) / Number(LL_INIT_VTOK) / 1000).toFixed(15);

// Mints to skip when looking for the new token in token balances
const SKIP_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
]);

// ── HTTP RPC ───────────────────────────────────────────────────────────────────

function httpRpcUrl(): string {
  const key = process.env["ALCHEMY_API_KEY"];
  return key
    ? `https://solana-mainnet.g.alchemy.com/v2/${key}`
    : "https://solana-rpc.publicnode.com";
}

const FALLBACK_HTTP_RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

async function rpcPost(body: unknown, timeoutMs = 30_000): Promise<unknown> {
  const urlsToTry = [httpRpcUrl(), ...FALLBACK_HTTP_RPCS.filter(u => u !== httpRpcUrl())];
  let lastErr: unknown;
  for (const url of urlsToTry) {
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "RocketFi/1.0" },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { lastErr = new Error(`RPC HTTP ${res.status} from ${url}`); continue; }
      const json = await res.json() as { error?: { code?: number } };
      // Rate-limited — try next endpoint
      const errCode = (json.error as { code?: number } | undefined)?.code;
      if (errCode === -32005 || errCode === 429) { lastErr = new Error(`rate-limited by ${url}`); continue; }
      return json;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr ?? new Error("all RPC endpoints failed");
}

// ── Instruction decoder ───────────────────────────────────────────────────────

interface DecodedCreate {
  mint:            string;
  name:            string;
  symbol:          string;
  uri:             string | null;
  creatorAddress:  string;
  blockTime:       number | null;
}

function decodeTx(tx: Record<string, unknown>): DecodedCreate | null {
  const meta = tx["meta"] as Record<string, unknown> | null;
  if (!meta || meta["err"]) return null;

  const transaction = tx["transaction"] as Record<string, unknown> | undefined;
  const message     = (transaction?.["message"] as Record<string, unknown>) ?? {};
  const keys        = (message["accountKeys"] as Array<{ pubkey?: string } | string>) ?? [];
  const instrs      = (message["instructions"] as Array<{ programIdIndex: number; data: string }>) ?? [];

  // Creator = fee-payer = first account key
  const firstKey = keys[0];
  const creatorAddress = typeof firstKey === "string"
    ? firstKey
    : ((firstKey as { pubkey?: string }).pubkey ?? "unknown");

  // Token mint: appears in postTokenBalances but NOT preTokenBalances
  const pre  = new Set(((meta["preTokenBalances"]  as Array<{mint:string}>) ?? []).map(b => b.mint));
  const post =          (meta["postTokenBalances"]  as Array<{mint:string}>) ?? [];
  const mint = post.find(b => !pre.has(b.mint) && !SKIP_MINTS.has(b.mint))?.mint;
  if (!mint) return null;

  // Find the LaunchLab program instruction
  const progIdx = keys.findIndex(k =>
    (typeof k === "string" ? k : (k as { pubkey?: string }).pubkey) === LAUNCHLAB_PROGRAM
  );
  if (progIdx < 0) return null;
  const instr = instrs.find(i => i.programIdIndex === progIdx);
  if (!instr?.data) return null;

  // Decode via shared utility (probes 13 offsets, validates, rejects garbage).
  try {
    const raw     = bs58Decode(instr.data);
    const decoded = decodeLabCreateParamsRaw(raw);
    if (decoded) {
      return {
        mint,
        name:          decoded.name,
        symbol:        decoded.symbol,
        uri:           decoded.uri || null,
        creatorAddress,
        blockTime:     (tx["blockTime"] as number | null) ?? null,
      };
    }
  } catch { /* fall through to placeholder */ }

  // Borsh decode failed — use placeholder (enrichment loop will fill later)
  return {
    mint,
    name:           mint.slice(0, 8) + "…",
    symbol:         "???",
    uri:            null,
    creatorAddress,
    blockTime:      (tx["blockTime"] as number | null) ?? null,
  };
}

// ── RPC calls ─────────────────────────────────────────────────────────────────

interface SigEntry { signature: string; blockTime: number | null; err: unknown }

/**
 * Fetch up to `limit` signatures for the LaunchLab program.
 * @param before  If provided, only return signatures OLDER than this one (pagination cursor).
 */
async function getSignaturesForAddress(
  limit: number,
  before?: string,
): Promise<SigEntry[]> {
  const params: [string, Record<string, unknown>] = [
    LAUNCHLAB_PROGRAM,
    { limit, commitment: "confirmed", ...(before ? { before } : {}) },
  ];
  const resp = (await rpcPost({
    jsonrpc: "2.0", id: 1,
    method:  "getSignaturesForAddress",
    params,
  })) as { result?: SigEntry[] };
  return resp.result ?? [];
}

async function batchGetTransactions(
  sigs: string[],
  opts: { throwOnNullResults?: boolean } = {},
): Promise<Array<Record<string, unknown> | null>> {
  const payload = sigs.map((sig, i) => ({
    jsonrpc: "2.0", id: i + 1,
    method:  "getTransaction",
    params:  [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
  }));
  const resp = await rpcPost(payload);

  // A top-level RPC error body (not an array) means the entire batch failed.
  // Throw so the retry loop in processSignaturePage catches it and retries.
  if (!Array.isArray(resp)) {
    throw new Error(
      `batchGetTransactions: expected JSON-RPC batch array, got ${typeof resp} — possible RPC error body`,
    );
  }

  // Length mismatch means the endpoint returned a truncated or partial response.
  if (resp.length !== sigs.length) {
    throw new Error(
      `batchGetTransactions: response length ${resp.length} does not match request length ${sigs.length}`,
    );
  }

  // Per-item RPC errors (e.g. "Transaction version unsupported", rate-limit).
  // Any error in the batch means we cannot trust the full result set; throw so
  // the retry loop handles all items uniformly rather than silently dropping them.
  const errorItems = (resp as Array<{ error?: unknown }>).filter(r => r.error != null);
  if (errorItems.length > 0) {
    throw new Error(
      `batchGetTransactions: ${errorItems.length}/${sigs.length} items returned per-item RPC errors`,
    );
  }

  const results = (resp as Array<{ result?: Record<string, unknown> | null }>)
    .map(r => r.result ?? null);

  // In strict mode (hot backfill): a null result for a known-confirmed signature means
  // the RPC couldn't serve it right now (commitment lag, node cache miss, etc.).
  // Throw so the retry loop retries the batch rather than silently skipping the sig.
  // Regular/deep backfills leave this off because old txs can legitimately be null.
  if (opts.throwOnNullResults) {
    const nullCount = results.filter(r => r === null).length;
    if (nullCount > 0) {
      throw new Error(
        `batchGetTransactions: ${nullCount}/${sigs.length} results were null (transactions temporarily unavailable at confirmed)`,
      );
    }
  }

  return results;
}

// ── Delay helper ──────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Shared page processor ──────────────────────────────────────────────────────

/**
 * Processes one page of signatures: fetches transactions, decodes creates,
 * inserts missing tokens, and kicks off async URI metadata fetch.
 * Returns { inserted, skipped }.
 */
async function processSignaturePage(
  sigs: SigEntry[],
  opts: { strict?: boolean } = {},
): Promise<{ inserted: number; skipped: number; batchFailures: number }> {
  let inserted      = 0;
  let skipped       = 0;
  let batchFailures = 0;

  for (let i = 0; i < sigs.length; i += BATCH_SIZE) {
    const batch     = sigs.slice(i, i + BATCH_SIZE);
    const batchSigs = batch.map(s => s.signature);

    let txs: Array<Record<string, unknown> | null> = [];
    let fetchSucceeded = false;
    let lastFetchErr: unknown;
    for (let attempt = 0; attempt <= BATCH_MAX_RETRIES; attempt++) {
      try {
        // In strict mode (hot backfill): null results are retried — a null result
        // for a confirmed sig is a temporary RPC unavailability, not a real miss.
        // In non-strict mode (regular/deep backfill): nulls are silently skipped
        // since old txs may genuinely be absent from the node's history.
        txs = await batchGetTransactions(batchSigs, { throwOnNullResults: opts.strict });
        fetchSucceeded = true;
        break;
      } catch (err) {
        lastFetchErr = err;
        const waitMs = BATCH_RETRY_BASE_MS * Math.pow(2, attempt);
        log.warn(
          { err, offset: i, attempt, waitMs, firstSig: batchSigs[0], lastSig: batchSigs[batchSigs.length - 1] },
          `launchlab-backfill: batch fetch failed (attempt ${attempt + 1}/${BATCH_MAX_RETRIES + 1}), retrying in ${waitMs}ms`,
        );
        if (attempt < BATCH_MAX_RETRIES) await delay(waitMs);
      }
    }
    if (!fetchSucceeded) {
      log.error(
        {
          err:      lastFetchErr,
          offset:   i,
          firstSig: batchSigs[0],
          lastSig:  batchSigs[batchSigs.length - 1],
          count:    batchSigs.length,
        },
        "launchlab-backfill: batch fetch exhausted all retries — skipped signature range; re-trigger backfill to recover",
      );
      batchFailures++;
      await delay(BATCH_DELAY_MS * 2);
      continue;
    }

    for (const tx of txs) {
      if (!tx) continue;

      // Fast-reject: only process createLaunchpad transactions
      const logs = ((tx["meta"] as Record<string,unknown>)?.["logMessages"] as string[]) ?? [];
      const isCreate = logs.some(l => /Instruction:\s*createLaunchpad/i.test(l));
      if (!isCreate) { skipped++; continue; }

      const decoded = decodeTx(tx);
      if (!decoded) { skipped++; continue; }

      // Skip if already in DB
      const [existing] = await db
        .select({ id: tokensTable.id })
        .from(tokensTable)
        .where(eq(tokensTable.address, decoded.mint))
        .limit(1);
      if (existing) { skipped++; continue; }

      // Insert the token
      await db.insert(tokensTable).values({
        address:              decoded.mint,
        name:                 decoded.name,
        symbol:               decoded.symbol,
        description:          null,
        imageUrl:             null,
        creatorAddress:       decoded.creatorAddress,
        totalSupply:          LL_TOTAL_SUPPLY.toString(),
        virtualTokenReserves: LL_INIT_VTOK.toString(),
        virtualEthReserves:   LL_INIT_VSOL_SOL,
        marketCapEth:         LL_INIT_MC_LAMPORTS,
        priceEth:             LL_INIT_PRICE_ETH,
        platform:             PLATFORM,
        chain:                CHAIN,
        metadataUri:          decoded.uri ?? null,
        ...(decoded.blockTime
          ? { createdAt: new Date(decoded.blockTime * 1000) }
          : {}),
      }).onConflictDoNothing();

      inserted++;
      log.debug({ mint: decoded.mint, name: decoded.name }, "launchlab-backfill: token inserted");

      // Async: fetch metadata from URI — don't block the main loop
      if (decoded.uri) {
        void fetchSafeUriMeta(decoded.uri).then(async (meta) => {
          if (!meta) return;
          const upd: Record<string, string | null> = {};
          if (meta.imageUrl)    upd["imageUrl"]    = meta.imageUrl;
          if (meta.description) upd["description"] = meta.description;
          if (meta.twitterUrl)  upd["twitterUrl"]  = meta.twitterUrl;
          if (meta.telegramUrl) upd["telegramUrl"] = meta.telegramUrl;
          if (meta.websiteUrl)  upd["websiteUrl"]  = meta.websiteUrl;
          if (Object.keys(upd).length > 0) {
            await db.update(tokensTable).set(upd)
              .where(eq(tokensTable.address, decoded.mint));
          }
        }).catch(() => { /* enrichment loop will retry */ });
      }
    }

    if (i + BATCH_SIZE < sigs.length) await delay(BATCH_DELAY_MS);
  }

  return { inserted, skipped, batchFailures };
}

// ── Hot backfill (watermark-based, runs every 60 s) ───────────────────────────

/**
 * Watermark: newest program signature successfully processed in the last run.
 * Used as the exclusive upper bound for the next run so no creates are skipped
 * regardless of how many trades share the signature stream between polls.
 */
let _hotBackfillWatermark: string | undefined = undefined;
/** Serialization guard — prevents concurrent runs from racing on the watermark. */
let _hotBackfillRunning = false;

/**
 * Gap-safe create-detection pass.
 *
 * Algorithm:
 *   1. Fetch the 200 newest program signatures (page 0).
 *   2. If the prior watermark appears in this page, collect only the slice
 *      before it (strictly newer).
 *   3. If the watermark is NOT in the page (outage gap > 200 sigs), paginate
 *      backward with `before` cursor — up to 4 additional pages (1000 sigs
 *      total) — collecting every page until the watermark is found.
 *   4. Process all collected signatures via processSignaturePage.
 *   5. Advance the watermark to the newest sig in page 0 ONLY after all pages
 *      have been successfully processed.  On any error the watermark stays at
 *      its previous value so the next run retries from the same point.
 *
 * Runs are serialized: if a prior run is still in progress (slow RPC) the new
 * invocation is dropped rather than racing on the watermark state.
 */
export async function hotBackfillLaunchLabTokens(): Promise<void> {
  if (_hotBackfillRunning) return; // serialize — skip if already in progress
  _hotBackfillRunning = true;
  try {
    // Page 0 — newest 200 signatures
    const firstPage = (await getSignaturesForAddress(200)).filter(s => !s.err);
    if (firstPage.length === 0) return;

    // This will become the new watermark once processing succeeds.
    const newWatermark = firstPage[0]?.signature;

    // ── First run: no watermark yet ──────────────────────────────────────────
    if (!_hotBackfillWatermark) {
      // strict: true — null results for recently confirmed sigs must be retried;
      // watermark only advances to newest sig when every batch succeeds.
      const { batchFailures } = await processSignaturePage(firstPage, { strict: true });
      if (batchFailures === 0) {
        // All sigs fetched: advance watermark to the newest sig we processed.
        if (newWatermark) _hotBackfillWatermark = newWatermark;
      } else {
        // Partial failure: anchor the watermark strictly OLDER than the oldest
        // sig we attempted.  This is necessary because subsequent runs use an
        // exclusive bound (slice(0, wmIdx)), so a watermark equal to oldestAttempted
        // would exclude that sig from retries.  By placing the anchor one step
        // further back, wmIdx points to the anchor and slice(0, wmIdx) correctly
        // includes oldestAttempted in the retry window.
        const oldestAttempted = firstPage[firstPage.length - 1]?.signature;
        if (oldestAttempted) {
          try {
            // Fetch exactly one sig older than the oldest we attempted.
            const olderPage = (await getSignaturesForAddress(1, oldestAttempted))
              .filter(s => !s.err);
            if (olderPage.length > 0 && olderPage[0]) {
              _hotBackfillWatermark = olderPage[0].signature;
            }
            // If nothing older exists (program is brand-new), leave watermark
            // unset — the next invocation retries as another first run.
          } catch { /* leave watermark unset; next run retries as first-run */ }
        }
      }
      return;
    }

    // ── Subsequent runs: collect sigs newer than watermark ───────────────────
    const sigsToProcess: SigEntry[] = [];
    let foundWatermark = false;

    // Check page 0 first
    const wmIdxFirst = firstPage.findIndex(s => s.signature === _hotBackfillWatermark);
    if (wmIdxFirst >= 0) {
      sigsToProcess.push(...firstPage.slice(0, wmIdxFirst));
      foundWatermark = true;
    } else {
      sigsToProcess.push(...firstPage);
    }

    // If watermark not in page 0, paginate backward (older) until found.
    // Safety cap: 4 additional pages (1000 sigs total).  If watermark still not
    // found after 5 pages, the gap is too large for this safety net — the regular
    // 10-minute backfill is the recovery path.  Do NOT advance the watermark so
    // the next run retries from the same point without permanently skipping sigs.
    if (!foundWatermark) {
      let cursor = firstPage[firstPage.length - 1]?.signature;
      for (let page = 0; page < 4 && cursor && !foundWatermark; page++) {
        const nextPage = (await getSignaturesForAddress(200, cursor)).filter(s => !s.err);
        if (nextPage.length === 0) break;

        const wmIdx = nextPage.findIndex(s => s.signature === _hotBackfillWatermark);
        if (wmIdx >= 0) {
          sigsToProcess.push(...nextPage.slice(0, wmIdx));
          foundWatermark = true;
        } else {
          sigsToProcess.push(...nextPage);
        }
        cursor = nextPage[nextPage.length - 1]?.signature;
        if (nextPage.length < 200) break; // exhausted program history
      }
    }

    if (!foundWatermark) {
      // Gap exceeds 5 pages: process the newest 1000 sigs as a best-effort pass
      // (catches creates in the visible window) but leave the watermark unchanged
      // so the next run re-scans from the same point rather than permanently
      // skipping the invisible part of the gap.
      log.warn(
        { watermark: _hotBackfillWatermark, sigsCollected: sigsToProcess.length },
        "launchlab-hot-backfill: watermark not found in 5 pages — processing visible window but NOT advancing watermark (regular backfill covers the full gap)",
      );
      // strict: true so null results don't silently skip creates in this window.
      // Watermark is NOT advanced regardless of outcome (next run retries from here).
      if (sigsToProcess.length > 0) await processSignaturePage(sigsToProcess, { strict: true });
      return; // watermark intentionally NOT advanced
    }

    // ── Process sigs newer than watermark ────────────────────────────────────
    // strict: true — null results for confirmed sigs are retried rather than
    // silently skipped; watermark only advances when every sig is confirmed fetched.
    if (sigsToProcess.length === 0) return; // no new sigs since last watermark

    const { inserted, batchFailures } = await processSignaturePage(sigsToProcess, { strict: true });

    if (batchFailures > 0) {
      // Partial RPC failure: some sigs were not fetched. Do NOT advance the
      // watermark — the next run will retry the full range from the same point.
      log.warn(
        { batchFailures, sigsAttempted: sigsToProcess.length },
        "launchlab-hot-backfill: batch fetch failures — watermark NOT advanced (will retry next run)",
      );
      return;
    }

    if (inserted > 0) {
      log.info(
        { inserted, processed: sigsToProcess.length },
        "launchlab-hot-backfill: inserted missed creates",
      );
    }

    // ── Advance watermark ONLY after all sigs processed without batch failures ─
    if (newWatermark) _hotBackfillWatermark = newWatermark;

  } catch (err) {
    log.warn({ err }, "launchlab-hot-backfill: error (non-fatal, watermark unchanged)");
    // Watermark intentionally NOT advanced — next run retries from same point.
  } finally {
    _hotBackfillRunning = false;
  }
}

// ── Regular backfill (last 1000 sigs) ─────────────────────────────────────────

export async function backfillLaunchLabTokens(): Promise<void> {
  try {
    log.info("launchlab-backfill: fetching recent signatures");

    const sigs = (await getSignaturesForAddress(BACKFILL_SIG_LIMIT))
      .filter(s => !s.err); // skip failed transactions

    if (sigs.length === 0) {
      log.info("launchlab-backfill: no signatures returned");
      return;
    }

    const { inserted, skipped } = await processSignaturePage(sigs);

    log.info(
      { inserted, skipped, total: sigs.length },
      "launchlab-backfill: complete",
    );
  } catch (err) {
    log.error({ err }, "launchlab-backfill: unexpected error");
  }
}

// ── Deep backfill (full history, runs once) ────────────────────────────────────

/**
 * Paginate ALL LaunchLab signatures from newest to oldest, inserting any tokens
 * we haven't seen before. Stops when:
 *   - The RPC returns fewer sigs than requested (history exhausted), OR
 *   - The oldest sig in the page predates DEEP_CUTOFF_TIMESTAMP.
 *
 * A marker file is written on success so this never runs again after the first
 * complete pass.
 */
export async function deepBackfillLaunchLabTokens(): Promise<void> {
  // Skip if we've already done the deep backfill
  if (fs.existsSync(DEEP_BACKFILL_MARKER)) {
    log.info("launchlab-deep-backfill: marker found, skipping");
    return;
  }

  log.info(
    { cutoff: new Date(DEEP_CUTOFF_TIMESTAMP * 1000).toISOString() },
    "launchlab-deep-backfill: starting full historical scan",
  );

  let totalInserted = 0;
  let totalSkipped  = 0;
  let pageCount     = 0;
  let cursor: string | undefined = undefined; // oldest sig seen so far

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      pageCount++;
      log.info(
        { page: pageCount, cursor: cursor ?? "(newest)" },
        "launchlab-deep-backfill: fetching page",
      );

      let rawSigs: SigEntry[];
      try {
        rawSigs = await getSignaturesForAddress(BACKFILL_SIG_LIMIT, cursor);
      } catch (err) {
        log.warn({ err, page: pageCount }, "launchlab-deep-backfill: RPC error fetching sigs, retrying in 5s");
        await delay(5_000);
        continue;
      }

      if (rawSigs.length === 0) {
        log.info({ page: pageCount }, "launchlab-deep-backfill: no more signatures, history exhausted");
        break;
      }

      // Advance cursor to the oldest sig in this page (for next iteration)
      const oldestInPage = rawSigs[rawSigs.length - 1];
      cursor = oldestInPage!.signature;

      // Check cutoff: if the oldest sig predates our cutoff, trim the page and stop after
      let reachedCutoff = false;
      let sigsToProcess = rawSigs.filter(s => !s.err);
      if (oldestInPage?.blockTime !== null && oldestInPage?.blockTime !== undefined) {
        if (oldestInPage.blockTime < DEEP_CUTOFF_TIMESTAMP) {
          // Filter to only sigs at or after the cutoff date
          sigsToProcess = rawSigs.filter(
            s => !s.err && (s.blockTime === null || s.blockTime >= DEEP_CUTOFF_TIMESTAMP),
          );
          reachedCutoff = true;
          log.info(
            { page: pageCount, cutoffDate: new Date(DEEP_CUTOFF_TIMESTAMP * 1000).toISOString() },
            "launchlab-deep-backfill: reached cutoff date",
          );
        }
      }

      if (sigsToProcess.length > 0) {
        const { inserted, skipped } = await processSignaturePage(sigsToProcess);
        totalInserted += inserted;
        totalSkipped  += skipped;
        log.info(
          { page: pageCount, inserted, skipped, totalInserted },
          "launchlab-deep-backfill: page complete",
        );
      }

      // Stop conditions
      if (reachedCutoff) break;
      if (rawSigs.length < BACKFILL_SIG_LIMIT) {
        // RPC returned fewer than requested → we've exhausted all history
        log.info({ page: pageCount }, "launchlab-deep-backfill: fewer sigs than limit, history exhausted");
        break;
      }

      // Pause between pages to be a good RPC citizen
      await delay(BATCH_DELAY_MS * 2);
    }

    // Write marker so we don't run again
    fs.writeFileSync(DEEP_BACKFILL_MARKER, new Date().toISOString(), "utf8");
    log.info(
      { totalInserted, totalSkipped, pages: pageCount },
      "launchlab-deep-backfill: complete — marker written",
    );
  } catch (err) {
    log.error({ err }, "launchlab-deep-backfill: unexpected error (will retry next restart)");
    // Do NOT write marker — will retry on next server restart
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function startLaunchLabBackfill(): void {
  // Deep backfill: run once, 15 s after startup (let adapters + DB settle first)
  // This pages through ALL historical LaunchLab transactions, not just the last 1000.
  setTimeout(() => void deepBackfillLaunchLabTokens(), 15_000);

  // Hot backfill: last 30 sigs every 60 s — catches WS-missed creates within ~1 minute.
  // Starts after 20 s to let the WebSocket adapter settle first.
  setTimeout(() => void hotBackfillLaunchLabTokens(), 20_000);
  setInterval(() => void hotBackfillLaunchLabTokens(), 60_000);

  // Regular backfill: run at 60 s delay then every 10 min
  // Catches tokens created since the last startup or missed during an offline window.
  setTimeout(() => void backfillLaunchLabTokens(), 60_000);
  setInterval(() => void backfillLaunchLabTokens(), BACKFILL_INTERVAL_MS);
}
