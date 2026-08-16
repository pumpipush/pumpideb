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

const PUMP_FUN_PROGRAM_ID  = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const LAUNCHLAB_PROGRAM_ID = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

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

/**
 * Fetch the confirmed transaction and extract the exact dev-buy swap.
 * Returns null when the tx cannot be fetched, failed on-chain, or contains no
 * verifiable buy event for (mint, creator).
 */
export async function deriveDevBuyFromTx(
  rpcUrls: string[],
  signature: string,
  mint: string,
  creator: string,
  platform: "pump_fun" | "raydium_launchlab",
): Promise<DerivedDevBuy | null> {
  let tx: ConfirmedTxJson | null = null;
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
      const json = await r.json() as { result?: ConfirmedTxJson | null };
      if (json.result) { tx = json.result; break; }
    } catch { continue; }
  }
  if (!tx) return null;
  return extractDevBuyFromConfirmedTx(tx, mint, creator, platform);
}
