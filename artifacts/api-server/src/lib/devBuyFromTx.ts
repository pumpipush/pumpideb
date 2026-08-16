/**
 * Derive a bundled dev buy from a confirmed launch transaction by parsing the
 * program-emitted Anchor TradeEvent — never by inferring from balance deltas.
 *
 * Why events, not balance deltas: a launch transaction also pays rent /
 * account-creation and other non-swap transfers, so the creator's net SOL
 * decrease overstates the buy. The TradeEvent written by the pump.fun /
 * Raydium LaunchLab program itself carries the exact swap amounts.
 *
 * The caller (register-launch) inserts a trade row ONLY when this module finds
 * a verifiable buy event in the transaction:
 *  - the expected program must have been invoked in the tx,
 *  - pump.fun: the event's mint and trader must match the registered mint and
 *    creator exactly,
 *  - LaunchLab: the event has no mint field, so the event's exact token amount
 *    must equal the creator's token-balance increase for the mint in this tx
 *    (binds the event to the mint and the creator).
 */

import { parseTradeEventFromLogs as parsePumpTradeEvent } from "./adapters/pumpfun.js";
import { parseTradeEventFromLogs as parseLabTradeEvent } from "./adapters/raydium-launchlab.js";
import { bs58Decode, bs58Encode } from "./adapters/launchlabDecode.js";

export const PUMP_FUN_PROGRAM_ID  = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const LAUNCHLAB_PROGRAM_ID = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

type TokBal = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount: string; decimals: number };
};

export type ConfirmedTxJson = {
  blockTime?: number | null;
  meta?: {
    err: unknown;
    logMessages?: string[];
    preTokenBalances?: TokBal[];
    postTokenBalances?: TokBal[];
  } | null;
};

export type DerivedDevBuy = {
  solLamports: bigint;
  tokenBaseUnits: bigint;
  priceEth: string | null;
  blockTime: Date | null;
};

/** Creator's net token-balance increase for `mint` in this tx (base units). */
function creatorTokenDelta(tx: ConfirmedTxJson, mint: string, creator: string): bigint {
  const post = (tx.meta?.postTokenBalances ?? []).find(b => b.mint === mint && b.owner === creator);
  if (!post?.uiTokenAmount) return 0n;
  const pre = (tx.meta?.preTokenBalances ?? []).find(b => b.mint === mint && b.owner === creator);
  return BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount?.amount ?? "0");
}

/**
 * Return only the log lines emitted while `programId` is the ACTIVE (top of
 * invocation stack) program. This is the provenance guard: a foreign program
 * in the same transaction can emit a forged "Program data:" TradeEvent-shaped
 * log, but it can never do so while the target program is the active scope —
 * log lines between `Program <id> invoke` and the matching `success`/`failed`
 * that are not inside a nested CPI belong to the program itself.
 */
export function logsForProgramScope(logs: string[], programId: string): string[] {
  const INVOKE = /^Program (\w{32,44}) invoke \[\d+\]$/;
  const END    = /^Program (\w{32,44}) (?:success|failed)/;
  const stack: string[] = [];
  const scoped: string[] = [];
  for (const line of logs) {
    const inv = INVOKE.exec(line);
    if (inv) { stack.push(inv[1]); continue; }
    const end = END.exec(line);
    if (end) {
      // Pop the matching frame (log streams are well-nested).
      if (stack[stack.length - 1] === end[1]) stack.pop();
      continue;
    }
    if (stack[stack.length - 1] === programId) scoped.push(line);
  }
  return scoped;
}

/** priceEth = SOL per display token (project convention: lamports / base-units / 1000 for 6-dp mints). */
function computePriceEth(solLamports: bigint, tokenBaseUnits: bigint): string | null {
  if (tokenBaseUnits <= 0n || solLamports <= 0n) return null;
  return (Number(solLamports) / Number(tokenBaseUnits) / 1000).toFixed(15);
}

/**
 * Extract the exact dev-buy swap from a confirmed transaction's parsed JSON.
 * Returns null when no verifiable buy event for (mint, creator) exists — the
 * caller must then skip the fallback insert entirely.
 */
export function extractDevBuyFromConfirmedTx(
  tx: ConfirmedTxJson,
  mint: string,
  creator: string,
  platform: "pump_fun" | "raydium_launchlab",
): DerivedDevBuy | null {
  if (!tx.meta || tx.meta.err !== null) return null;
  const logs = tx.meta.logMessages ?? [];
  if (logs.length === 0) return null;
  const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;

  if (platform === "pump_fun") {
    // Only logs emitted while pump.fun itself is the active program — a
    // foreign program in the same tx cannot forge into this scope.
    const scoped = logsForProgramScope(logs, PUMP_FUN_PROGRAM_ID);
    if (scoped.length === 0) return null;
    const ev = parsePumpTradeEvent(scoped);
    if (!ev || !ev.isBuy) return null;
    // The event itself binds mint and trader — reject any mismatch.
    if (ev.mint !== mint || ev.traderAddress !== creator) return null;
    const solLamports    = BigInt(ev.solLamports);
    const tokenBaseUnits = BigInt(ev.tokenAmount);
    if (solLamports <= 0n || tokenBaseUnits <= 0n) return null;
    return { solLamports, tokenBaseUnits, priceEth: computePriceEth(solLamports, tokenBaseUnits), blockTime };
  }

  // raydium_launchlab — event carries poolAddress, not mint. Bind it to the
  // mint+creator by requiring the event's exact token amount to equal the
  // creator's token-balance increase for the mint in this transaction.
  const scoped = logsForProgramScope(logs, LAUNCHLAB_PROGRAM_ID);
  if (scoped.length === 0) return null;
  const ev = parseLabTradeEvent(scoped);
  if (!ev || !ev.isBuy) return null;
  const solLamports    = BigInt(ev.solLamports);
  const tokenBaseUnits = BigInt(ev.tokenAmount);
  if (solLamports <= 0n || tokenBaseUnits <= 0n) return null;
  const delta = creatorTokenDelta(tx, mint, creator);
  if (delta !== tokenBaseUnits) return null;
  return { solLamports, tokenBaseUnits, priceEth: computePriceEth(solLamports, tokenBaseUnits), blockTime };
}

/** Compiled instruction from getTransaction (encoding: "json"). */
type CompiledInstruction = {
  programIdIndex: number;
  accounts?: number[];
  data?: string;             // base58-encoded instruction data
};

/**
 * Raw transaction JSON shape from getTransaction (encoding: "json").
 * Includes transaction message for signer extraction.
 */
export type RawConfirmedTx = ConfirmedTxJson & {
  transaction?: {
    message?: {
      accountKeys?: string[];         // base58-encoded public keys
      header?: { numRequiredSignatures: number };
      instructions?: CompiledInstruction[];
    };
    signatures?: string[];
  };
};

/**
 * Fetch the confirmed transaction JSON from the first RPC that returns it.
 * Uses encoding: "json" which includes logMessages and meta.
 * Returns null if all RPCs fail or the tx is not yet confirmed.
 */
export async function fetchConfirmedTx(
  rpcUrls: string[],
  signature: string,
): Promise<RawConfirmedTx | null> {
  for (const url of rpcUrls) {
    try {
      const r = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method:  "getTransaction",
          params:  [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) continue;
      const json = await r.json() as { result?: RawConfirmedTx | null };
      if (json.result) return json.result;
    } catch { continue; }
  }
  return null;
}

/**
 * Extract the fee payer (first account key = always a signer) from a raw tx.
 * Returns null if the transaction structure is unreadable.
 */
export function extractFeePayer(tx: RawConfirmedTx): string | null {
  const keys = tx.transaction?.message?.accountKeys;
  if (!keys || keys.length === 0) return null;
  return typeof keys[0] === "string" ? keys[0] : null;
}

/**
 * Anchor instruction discriminator for `createLaunchpad`.
 * Computed as sha256("global:createLaunchpad")[0..8] = 2eef4b2f33dde9d3.
 */
const CREATE_LAUNCHPAD_DISC = new Uint8Array([0x2e, 0xef, 0x4b, 0x2f, 0x33, 0xdd, 0xe9, 0xd3]);

function discMatches(data: Uint8Array, disc: Uint8Array): boolean {
  if (data.length < disc.length) return false;
  for (let i = 0; i < disc.length; i++) {
    if (data[i] !== disc[i]) return false;
  }
  return true;
}

/**
 * Decode the mint address from a LaunchLab `createLaunchpad` instruction.
 *
 * The Anchor/Borsh instruction data layout is:
 *   [0..7]  discriminator  (8 bytes) — sha256("global:createLaunchpad")[0..8]
 *   [8..39] mintA pubkey   (32 bytes) ← the newly created token mint
 *   [40..]  Borsh-encoded name / symbol / uri strings
 *
 * We identify the specific `createLaunchpad` instruction by its 8-byte Anchor
 * discriminator, not just by program ID. This ensures that if a tx contains
 * multiple LaunchLab instructions (e.g. a swap followed by a create), we always
 * decode the right one. Token-balance presence is not used — it can be forged by
 * bundling an SPL mint-to-new-account for an existing mint in the same tx.
 *
 * Returns the base58-encoded mint public key, or null if no `createLaunchpad`
 * instruction with the expected discriminator is found.
 */
export function extractLaunchLabMintFromInstruction(
  tx: RawConfirmedTx,
  launchLabProgramId: string,
): string | null {
  const keys   = tx.transaction?.message?.accountKeys ?? [];
  const instrs = tx.transaction?.message?.instructions ?? [];

  const progIdx = keys.findIndex(k => k === launchLabProgramId);
  if (progIdx < 0) return null;

  // Find the instruction that (a) belongs to the LaunchLab program AND
  // (b) has the exact createLaunchpad Anchor discriminator in its data.
  for (const instr of instrs) {
    if (instr.programIdIndex !== progIdx || !instr.data) continue;
    try {
      const raw = bs58Decode(instr.data);
      // Need discriminator (8) + mint pubkey (32) = 40 bytes minimum
      if (raw.length < 40) continue;
      if (!discMatches(raw, CREATE_LAUNCHPAD_DISC)) continue;
      // This is the createLaunchpad instruction — bytes 8-39 are the mint
      return bs58Encode(raw.subarray(8, 40));
    } catch { continue; }
  }
  return null;
}

/**
 * Fetch the confirmed transaction and extract the exact dev-buy swap.
 * Returns null when the tx cannot be fetched, failed on-chain, or contains no
 * verifiable buy event for (mint, creator).
 *
 * Pass a pre-fetched `tx` to avoid a second RPC call when the caller already
 * has the transaction (e.g. the register-launch route).
 */
export async function deriveDevBuyFromTx(
  rpcUrls: string[],
  signature: string,
  mint: string,
  creator: string,
  platform: "pump_fun" | "raydium_launchlab",
  prefetchedTx?: RawConfirmedTx | null,
): Promise<DerivedDevBuy | null> {
  const tx = prefetchedTx ?? await fetchConfirmedTx(rpcUrls, signature);
  if (!tx) return null;
  return extractDevBuyFromConfirmedTx(tx, mint, creator, platform);
}
