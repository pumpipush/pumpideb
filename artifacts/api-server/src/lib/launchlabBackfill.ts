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
 * Runs once at server startup, then every BACKFILL_INTERVAL_MS to catch any
 * tokens whose creation was missed during an offline window.
 */

import { eq } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import { logger as rootLogger } from "./logger";

const log = rootLogger.child({ module: "launchlab-backfill" });

const LAUNCHLAB_PROGRAM     = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const PLATFORM              = "raydium_launchlab";
const CHAIN                 = "solana";
const BACKFILL_SIG_LIMIT    = 1000;  // recent signatures to scan per run
const BATCH_SIZE            = 10;    // getTransaction calls per HTTP request
const BATCH_DELAY_MS        = 250;   // ms between batches (rate-limit protection)
const BACKFILL_INTERVAL_MS  = 10 * 60_000; // re-run every 10 min

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

async function rpcPost(body: unknown): Promise<unknown> {
  const res = await fetch(httpRpcUrl(), {
    method:  "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "RocketFi/1.0" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  return res.json();
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

// ── IPFS / URI metadata helpers ───────────────────────────────────────────────

function resolveIpfs(url: string): string {
  return url
    .replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/")
    .replace(/https?:\/\/cf-ipfs\.com\/ipfs\//, "https://ipfs.io/ipfs/");
}

interface UriMeta {
  imageUrl:    string | null;
  description: string | null;
  twitterUrl:  string | null;
  telegramUrl: string | null;
  websiteUrl:  string | null;
}

async function fetchMetaFromUri(uri: string): Promise<UriMeta | null> {
  if (!uri) return null;
  try {
    const res = await fetch(resolveIpfs(uri), {
      signal:  AbortSignal.timeout(10_000),
      headers: { "User-Agent": "RocketFi/1.0" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      image?:       string;
      description?: string;
      twitter?:     string;
      telegram?:    string;
      website?:     string;
    };
    const rawImg = json.image?.trim() || null;
    return {
      imageUrl:    rawImg ? resolveIpfs(rawImg) : null,
      description: json.description?.trim() || null,
      twitterUrl:  json.twitter?.trim()     || null,
      telegramUrl: json.telegram?.trim()    || null,
      websiteUrl:  json.website?.trim()     || null,
    };
  } catch {
    return null;
  }
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

async function getSignaturesForAddress(limit: number): Promise<SigEntry[]> {
  const resp = (await rpcPost({
    jsonrpc: "2.0", id: 1,
    method:  "getSignaturesForAddress",
    params:  [LAUNCHLAB_PROGRAM, { limit, commitment: "confirmed" }],
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

// ── Main backfill ──────────────────────────────────────────────────────────────

export async function backfillLaunchLabTokens(): Promise<void> {
  try {
    log.info("launchlab-backfill: fetching recent signatures");

    const sigs = (await getSignaturesForAddress(BACKFILL_SIG_LIMIT))
      .filter(s => !s.err); // skip failed transactions

    if (sigs.length === 0) {
      log.info("launchlab-backfill: no signatures returned");
      return;
    }

    // Check which mints we already have so we can skip fetching their transactions.
    // We can't know the mint without fetching the tx, so we just track which
    // signatures we've processed by their resulting mint after decode.
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
          ...(decoded.blockTime
            ? { createdAt: new Date(decoded.blockTime * 1000) }
            : {}),
        }).onConflictDoNothing();

        inserted++;
        log.debug({ mint: decoded.mint, name: decoded.name }, "launchlab-backfill: token inserted");

        // Async: fetch metadata from URI — don't block the main loop
        if (decoded.uri) {
          void fetchMetaFromUri(decoded.uri).then(async (meta) => {
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

    log.info(
      { inserted, skipped, total: sigs.length },
      "launchlab-backfill: complete",
    );
  } catch (err) {
    log.error({ err }, "launchlab-backfill: unexpected error");
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function startLaunchLabBackfill(): void {
  // Run immediately on startup (delayed 10 s so adapters connect first)
  setTimeout(() => void backfillLaunchLabTokens(), 10_000);
  // Then every 10 minutes to pick up tokens created while offline
  setInterval(() => void backfillLaunchLabTokens(), BACKFILL_INTERVAL_MS);
}
