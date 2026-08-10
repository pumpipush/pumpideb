/**
 * tradeVerifier.ts
 *
 * On-chain trade verification for the POST /tokens/:address/trades route.
 *
 * Strategy — Anchor event log parsing:
 *   All economic fields are derived by decoding the pump.fun TradeEvent Anchor
 *   event from the transaction's program log messages (meta.logMessages).
 *   These events are emitted by the pump.fun program during execution and are
 *   not caller-controllable.  They bind mint, trader, SOL amount, token amount,
 *   and trade direction to a single program-level execution record.
 *
 *   This approach is immune to all balance-delta spoofing attacks because we
 *   never look at pre/post balances — we only read what the program itself
 *   reported in its event log.
 *
 * Scope:
 *   Only pump.fun bonding-curve swaps are verifiable by this method.
 *   PumpSwap, Raydium, and Jupiter trades are handled by their respective
 *   chain-level indexers (which write directly to the DB) and are rejected here.
 *
 * Commitment level:
 *   Transactions are fetched at `finalized` commitment.  Confirmed transactions
 *   can theoretically be rolled back in adversarial conditions; finalized blocks
 *   cannot.  This prevents a time-of-check/time-of-use race where a transaction
 *   is confirmed, recorded, and then rolled back.
 *
 * Failure modes (typed HTTP status):
 *   not_found    (404) — signature not known / not yet finalized
 *   wrong_signer (403) — fee payer ≠ claimedTrader
 *   wrong_trader (403) — TradeEvent user field ≠ claimedTrader
 *   wrong_mint   (409) — TradeEvent mint ≠ expectedMint
 *   no_event     (409) — no valid pump.fun TradeEvent found in log messages
 *   tx_failed    (422) — tx reverted
 *   rpc_error    (503) — all RPCs unreachable / returned malformed data
 */

import { PUBLICNODE_HTTP, FALLBACK_HTTP_RPCS } from "./adapters/solanaRpcBase.js";

// ── pump.fun Anchor event constants ───────────────────────────────────────────

/**
 * pump.fun TradeEvent Anchor discriminator: sha256("event:TradeEvent")[0..8]
 * Precomputed — matches the value used by the pump.fun program.
 */
const TRADE_EVENT_DISC = Buffer.from("bddb7fd34ee661ee", "hex");

/**
 * Minimum encoded size of a pump.fun TradeEvent (borsh):
 *   discriminator(8) + mint(32) + sol_amount(8) + token_amount(8) +
 *   is_buy(1) + user(32) + timestamp(8) + virtual_sol_reserves(8) +
 *   virtual_token_reserves(8) = 113 bytes
 */
const TRADE_EVENT_MIN_BYTES = 113;

// ── Base58 encoder (required to decode pubkeys from raw bytes) ────────────────

const BS58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bs58Encode(bytes: Buffer | Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  const chars: string[] = [];
  while (n > 0n) { chars.unshift(BS58_ALPHA[Number(n % 58n)]); n /= 58n; }
  let leading = 0;
  for (const b of bytes) { if (b !== 0) break; leading++; }
  return "1".repeat(leading) + chars.join("");
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface VerifiedTrade {
  readonly ok: true;
  /** true = trader bought tokens; false = sold */
  readonly isBuy: boolean;
  /** Absolute token amount (raw atoms, no decimals) as reported by the TradeEvent */
  readonly tokenAmountAtoms: string;
  /** SOL amount (lamports) as reported by the TradeEvent */
  readonly solAmountLamports: string;
  /**
   * SOL per token — lamports ÷ atoms ÷ 1000, toFixed(15).
   * Matches the convention used by pump.fun / pumpswap adapters.
   * Null when either amount is zero.
   */
  readonly priceEth: string | null;
  /**
   * Unix timestamp (seconds) of the confirming slot from the RPC `blockTime`.
   * Null when the RPC omitted it.
   */
  readonly blockTime: number | null;
}

export type TradeVerifyError =
  | { readonly ok: false; readonly status: 404; readonly error: string }
  | { readonly ok: false; readonly status: 403; readonly error: string }
  | { readonly ok: false; readonly status: 409; readonly error: string }
  | { readonly ok: false; readonly status: 422; readonly error: string }
  | { readonly ok: false; readonly status: 503; readonly error: string };

export type TradeVerifyResult = VerifiedTrade | TradeVerifyError;

// ── Internal RPC shape ────────────────────────────────────────────────────────

interface RpcTransactionResult {
  blockTime?: number | null;
  meta?: {
    err: unknown;
    logMessages?: string[];
  } | null;
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey?: string }>;
    };
  };
}

// ── Anchor event parser ───────────────────────────────────────────────────────

interface PumpFunTradeEvent {
  readonly mint:          string;
  readonly solLamports:   string;
  readonly tokenAmount:   string;
  readonly isBuy:         boolean;
  readonly traderAddress: string;
}

/**
 * Scan `logMessages` for a pump.fun TradeEvent Anchor log line and decode it.
 *
 * Log format: "Program data: <base64>"
 *
 * TradeEvent borsh layout (113 bytes minimum):
 *   discriminator(8)  mint(32)  sol_amount(8)  token_amount(8)
 *   is_buy(1)  user(32)  timestamp(8)  virtual_sol_reserves(8)
 *   virtual_token_reserves(8)
 *
 * Returns null if no valid TradeEvent is found.
 */
function parsePumpFunTradeEvent(logMessages: string[]): PumpFunTradeEvent | null {
  const PREFIX = "Program data: ";
  for (const log of logMessages) {
    if (!log.startsWith(PREFIX)) continue;
    try {
      const raw = Buffer.from(log.slice(PREFIX.length), "base64");
      if (raw.length < TRADE_EVENT_MIN_BYTES) continue;
      if (!raw.subarray(0, 8).equals(TRADE_EVENT_DISC)) continue;

      let off = 8;
      const mint          = bs58Encode(raw.subarray(off, off + 32)); off += 32;
      const solLamports   = raw.readBigUInt64LE(off).toString();     off += 8;
      const tokenAmount   = raw.readBigUInt64LE(off).toString();     off += 8;
      const isBuy         = raw[off] === 1;                          off += 1;
      const traderAddress = bs58Encode(raw.subarray(off, off + 32));

      return { mint, solLamports, tokenAmount, isBuy, traderAddress };
    } catch {
      continue;
    }
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveAccountKey(entry: string | { pubkey?: string }): string {
  return typeof entry === "string" ? entry : (entry.pubkey ?? "");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Verify that `signature` is a finalized Solana transaction containing a
 * pump.fun TradeEvent for `expectedMint` by `claimedTrader`, and return all
 * trade economics as decoded from that event.
 *
 * All amounts (solAmountLamports, tokenAmountAtoms, isBuy) come from the
 * pump.fun program's own event emission — no client-supplied values are trusted
 * and no pre/post balance analysis is performed.
 *
 * Fails closed (503) whenever RPC data is too incomplete to verify.
 */
export async function fetchAndParseTrade(
  signature: string,
  expectedMint: string,
  claimedTrader: string,
): Promise<TradeVerifyResult> {
  const reqBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getTransaction",
    params: [
      signature,
      // "finalized" — cannot be rolled back, unlike "confirmed"
      { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 },
    ],
  });

  const endpoints: string[] = [PUBLICNODE_HTTP, ...FALLBACK_HTTP_RPCS];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: reqBody,
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) continue;

      const json = await res.json() as {
        result?: RpcTransactionResult | null;
        error?: unknown;
      };

      if (json.error) continue; // RPC-level error — try next endpoint

      if (!json.result) {
        return {
          ok: false, status: 404,
          error: "Transaction not found on-chain at finalized commitment — it may not be finalized yet. Retry in 30–60 seconds.",
        };
      }

      const { meta, transaction, blockTime = null } = json.result;

      // ── Fail closed on missing metadata ───────────────────────────────────
      if (!meta) {
        return {
          ok: false, status: 503,
          error: "RPC returned a transaction with no metadata — cannot verify trade. Please retry.",
        };
      }

      // ── Transaction must have succeeded ───────────────────────────────────
      if (meta.err !== null && meta.err !== undefined) {
        return {
          ok: false, status: 422,
          error: "Transaction was reverted on-chain and cannot be recorded as a trade.",
        };
      }

      // ── Fee payer verification ─────────────────────────────────────────────
      // accountKeys[0] is always the fee payer and primary signer.
      const accountKeys = transaction?.message?.accountKeys ?? [];
      if (accountKeys.length === 0) {
        return {
          ok: false, status: 503,
          error: "RPC returned a transaction with no account keys — cannot verify trade. Please retry.",
        };
      }
      const feePayer = resolveAccountKey(accountKeys[0]);
      if (!feePayer) {
        return {
          ok: false, status: 503,
          error: "RPC returned an unresolvable fee-payer — cannot verify trade. Please retry.",
        };
      }
      if (feePayer !== claimedTrader) {
        return {
          ok: false, status: 403,
          error: "Transaction fee payer does not match the provided traderAddress.",
        };
      }

      // ── Parse pump.fun TradeEvent from program log messages ────────────────
      //
      // The TradeEvent is emitted by the pump.fun program itself during execution.
      // It contains the exact mint, trader, SOL amount, token amount, and direction
      // as recorded by the protocol — the caller cannot influence these values.
      //
      // logMessages may be absent from some archive RPCs; this is treated as a
      // malformed response (fail closed) because we cannot verify without it.
      const logMessages = meta.logMessages;
      if (!Array.isArray(logMessages)) {
        return {
          ok: false, status: 503,
          error: "RPC response did not include log messages — cannot verify pump.fun TradeEvent. Please retry with a full-history RPC.",
        };
      }

      const event = parsePumpFunTradeEvent(logMessages);
      if (!event) {
        return {
          ok: false, status: 409,
          error: "No pump.fun TradeEvent found in transaction logs. This endpoint only accepts pump.fun bonding-curve swaps; other platforms are handled by the chain indexer.",
        };
      }

      // ── Verify event fields against the caller's claims ───────────────────
      if (event.mint !== expectedMint) {
        return {
          ok: false, status: 409,
          error: `TradeEvent mint (${event.mint}) does not match the requested token (${expectedMint}).`,
        };
      }
      if (event.traderAddress !== claimedTrader) {
        return {
          ok: false, status: 403,
          error: "TradeEvent user field does not match the provided traderAddress.",
        };
      }

      // ── Derive price ──────────────────────────────────────────────────────
      const solNum   = Number(event.solLamports);
      const tokNum   = Number(event.tokenAmount);
      const priceEth = solNum > 0 && tokNum > 0
        ? (solNum / tokNum / 1000).toFixed(15)
        : null;

      return {
        ok:                true,
        isBuy:             event.isBuy,
        tokenAmountAtoms:  event.tokenAmount,
        solAmountLamports: event.solLamports,
        priceEth,
        blockTime: typeof blockTime === "number" ? blockTime : null,
      };
    } catch {
      continue; // Network / timeout — try next endpoint
    }
  }

  return {
    ok: false, status: 503,
    error: "Unable to verify transaction on-chain — all RPC endpoints are unreachable. Please retry.",
  };
}
