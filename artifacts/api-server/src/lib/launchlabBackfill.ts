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

const log = rootLogger.child({ module: "launchlab-backfill" });

const LAUNCHLAB_PROGRAM     = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const PLATFORM              = "raydium_launchlab";
const CHAIN                 = "solana";
const BACKFILL_SIG_LIMIT    = 1000;  // signatures per page (max Solana allows)
const BATCH_SIZE            = 10;    // getTransaction calls per HTTP request
const BATCH_DELAY_MS        = 250;   // ms between batches (rate-limit protection)
const BACKFILL_INTERVAL_MS  = 10 * 60_000; // re-run every 10 min

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

// ── Borsh / Base58 utilities (inlined — same as adapter) ──────────────────────

const BS58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bs58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = BS58_ALPHA.indexOf(c);
    if (i < 0) throw new Error(`bad base58 char: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let leading = 0;
  for (const c of s) { if (c !== "1") break; leading++; }
  return new Uint8Array([...new Array<number>(leading).fill(0), ...bytes]);
}

function readBorshStr(buf: Uint8Array, off: number): [string, number] {
  if (off + 4 > buf.length) throw new RangeError("borsh underflow (len)");
  const len = new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, true);
  const end = off + 4 + len;
  if (end > buf.length) throw new RangeError("borsh underflow (str)");
  return [new TextDecoder().decode(buf.subarray(off + 4, end)), end];
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

  // Decode Borsh: try offsets 40 (disc8+mintA32), 8 (disc8), 72 (disc8+2×pubkey)
  for (const startOff of [40, 8, 72]) {
    try {
      const raw = bs58Decode(instr.data);
      if (raw.length < startOff + 8) continue;
      let off = startOff;
      const [name,   o1] = readBorshStr(raw, off); off = o1;
      const [symbol, o2] = readBorshStr(raw, off); off = o2;
      const [uri]        = readBorshStr(raw, off);
      const n = name.trim(), s = symbol.trim();
      if (!n || !s) continue;
      if (n.length > 64 || s.length > 16) continue;
      // Reject binary garbage: control chars + Unicode replacement char
      if (/[\x00-\x08\x0B\x0E-\x1F\x7F\uFFFD]/.test(n) ||
          /[\x00-\x08\x0B\x0E-\x1F\x7F\uFFFD]/.test(s)) continue;
      return {
        mint, name: n, symbol: s,
        uri: uri.trim() || null,
        creatorAddress,
        blockTime: (tx["blockTime"] as number | null) ?? null,
      };
    } catch { continue; }
  }
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
): Promise<Array<Record<string, unknown> | null>> {
  const payload = sigs.map((sig, i) => ({
    jsonrpc: "2.0", id: i + 1,
    method:  "getTransaction",
    params:  [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }],
  }));
  const resp = (await rpcPost(payload)) as Array<{ result?: Record<string, unknown> | null }>;
  return Array.isArray(resp) ? resp.map(r => r.result ?? null) : [];
}

// ── Delay helper ──────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Shared page processor ──────────────────────────────────────────────────────

/**
 * Processes one page of signatures: fetches transactions, decodes creates,
 * inserts missing tokens, and kicks off async URI metadata fetch.
 * Returns { inserted, skipped }.
 */
async function processSignaturePage(sigs: SigEntry[]): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped  = 0;

  for (let i = 0; i < sigs.length; i += BATCH_SIZE) {
    const batch     = sigs.slice(i, i + BATCH_SIZE);
    const batchSigs = batch.map(s => s.signature);

    let txs: Array<Record<string, unknown> | null>;
    try {
      txs = await batchGetTransactions(batchSigs);
    } catch (err) {
      log.warn({ err, offset: i }, "launchlab-backfill: batch fetch failed, skipping");
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

  return { inserted, skipped };
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

  // Regular backfill: run immediately (30 s delay) then every 10 min
  // Catches tokens created since the last startup or missed during an offline window.
  setTimeout(() => void backfillLaunchLabTokens(), 30_000);
  setInterval(() => void backfillLaunchLabTokens(), BACKFILL_INTERVAL_MS);
}
