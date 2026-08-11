/**
 * Jupiter Aggregator v6 — swap routing for pump.fun graduated tokens.
 *
 * When a pump.fun token graduates its bonding curve, it moves to Raydium/PumpSwap.
 * Jupiter auto-routes through the best available pool (Raydium, Orca, PumpSwap, etc.)
 * so traders always get the best price without knowing which pool holds the liquidity.
 *
 * Swap flow:
 *   1. getJupiterQuote()      → fetch best-route quote (for UI preview + submission)
 *   2. buildJupiterSwapTx()   → get VersionedTransaction from Jupiter
 *   3. wallet.signAndSendTx() → user signs + broadcasts (via WalletContext)
 *   4. waitForJupiterConfirm()→ confirm on-chain settlement
 *
 * Slippage is passed as `slippageBps` from the app's swap settings store.
 * Priority fee uses Jupiter's "auto" mode — the quote + swap APIs handle CU estimation.
 */

import { Connection, VersionedTransaction } from "@solana/web3.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Native SOL wrapped mint — used as the SOL leg in all Jupiter token↔SOL routes */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Jupiter moved the free tier from quote-api.jup.ag/v6 (deprecated) to lite.jup.ag/v6
const JUP_QUOTE_API = "https://lite.jup.ag/v6/quote";
const JUP_SWAP_API  = "https://lite.jup.ag/v6/swap";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Single hop in a Jupiter route (one AMM pool traversed) */
export interface JupiterRoutePlanStep {
  swapInfo: {
    ammKey:      string;
    /** Human-readable DEX name, e.g. "Raydium", "Orca", "PumpSwap" */
    label:       string;
    inputMint:   string;
    outputMint:  string;
    inAmount:    string;
    outAmount:   string;
    feeAmount:   string;
    feeMint:     string;
  };
  percent: number;
}

/**
 * Full response from Jupiter v6 /quote.
 * Extends Record so the object can be forwarded as-is to /swap.
 */
export interface JupiterQuoteResponse extends Record<string, unknown> {
  inputMint:         string;
  outputMint:        string;
  /** Input amount in base units (lamports for SOL, atoms for tokens) */
  inAmount:          string;
  /** Best-route output amount in base units */
  outAmount:         string;
  /** Other-routes output amount accounting for slippage */
  otherAmountThreshold: string;
  priceImpactPct:    string;
  routePlan:         JupiterRoutePlanStep[];
}

export interface BuildJupiterSwapTxResult {
  transaction:          VersionedTransaction;
  /** From the /swap response — used for confirmTransaction */
  lastValidBlockHeight: number;
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Priority: VITE_ALCHEMY_API_KEY → VITE_SOLANA_RPC_URL → PublicNode free */
function getRpcUrl(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (import.meta as any).env;
  if (env?.VITE_ALCHEMY_API_KEY) return `https://solana-mainnet.g.alchemy.com/v2/${env.VITE_ALCHEMY_API_KEY}`;
  if (env?.VITE_SOLANA_RPC_URL)  return env.VITE_SOLANA_RPC_URL;
  return "https://solana-rpc.publicnode.com";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch the best-price quote from Jupiter v6.
 *
 * @param inputMint    Mint of the token being sold (WSOL_MINT for buy, token address for sell)
 * @param outputMint   Mint of the token being bought
 * @param amountBaseUnits  Input amount in base units (lamports or token atoms)
 * @param slippageBps  Slippage tolerance in basis points (from swap settings store)
 */
export async function getJupiterQuote(
  inputMint:       string,
  outputMint:      string,
  amountBaseUnits: bigint,
  slippageBps:     number,
): Promise<JupiterQuoteResponse> {
  const url = new URL(JUP_QUOTE_API);
  url.searchParams.set("inputMint",   inputMint);
  url.searchParams.set("outputMint",  outputMint);
  url.searchParams.set("amount",      amountBaseUnits.toString());
  url.searchParams.set("slippageBps", slippageBps.toString());
  // Allow multi-hop routes — Jupiter finds the optimal path automatically
  url.searchParams.set("onlyDirectRoutes", "false");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, string>;
    throw new Error(body.error ?? body.message ?? `Jupiter quote failed (${res.status})`);
  }
  return res.json() as Promise<JupiterQuoteResponse>;
}

/**
 * Build a swap VersionedTransaction via Jupiter v6 /swap.
 *
 * Jupiter handles:
 *   - Route selection and instruction building
 *   - wrapSol/unwrapSol for native SOL↔WSOL conversion
 *   - Dynamic compute-unit estimation
 *   - Priority fee ("auto" mode adapts to current network conditions)
 *
 * The returned `lastValidBlockHeight` is paired with the transaction's
 * embedded blockhash for on-chain confirmation.
 */
export async function buildJupiterSwapTx(
  quoteResponse:  JupiterQuoteResponse,
  userPublicKey:  string,
): Promise<BuildJupiterSwapTxResult> {
  const res = await fetch(JUP_SWAP_API, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol:        true,  // auto-wrap native SOL for token swaps
      dynamicComputeUnitLimit: true,  // estimate CUs precisely — avoids over-allocation
      prioritizationFeeLamports: "auto",  // Jupiter auto-selects based on network congestion
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, string>;
    throw new Error(err.error ?? err.message ?? `Jupiter swap TX build failed (${res.status})`);
  }

  const { swapTransaction, lastValidBlockHeight } = await res.json() as {
    swapTransaction:      string;
    lastValidBlockHeight: number;
  };

  // Decode base64-encoded VersionedTransaction from Jupiter
  const txBytes = Buffer.from(swapTransaction, "base64");
  const transaction = VersionedTransaction.deserialize(txBytes);

  return { transaction, lastValidBlockHeight };
}

/**
 * Wait for a Jupiter swap to reach "confirmed" commitment on-chain.
 *
 * Uses the blockhash-strategy: the RPC can precisely detect expiry (blockhash
 * slot window passed) vs genuine network errors, and terminates without an
 * open-ended poll.
 *
 * Throws on ALL non-success outcomes:
 *  - On-chain instruction failure  → "Jupiter swap failed on-chain: …"
 *  - Blockhash expired / timeout   → TransactionExpiredBlockheightExceededError
 *  - Network / RPC error           → RPC error
 *
 * Callers must propagate errors so the toast shows "Failed", never "Confirmed",
 * for an unresolved submission.
 */
export async function waitForJupiterTxConfirmation(
  signature:            string,
  blockhash:            string,
  lastValidBlockHeight: number,
): Promise<void> {
  const conn   = new Connection(getRpcUrl(), "confirmed");
  const result = await conn.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (result.value.err) {
    throw new Error(`Jupiter swap failed on-chain: ${JSON.stringify(result.value.err)}`);
  }
}

// ── Display helpers ───────────────────────────────────────────────────────────

/**
 * Extract a human-readable route label from a quote.
 * Returns the unique DEX names joined, e.g. "Raydium", "Raydium → Orca".
 */
export function getRouteLabel(quote: JupiterQuoteResponse): string {
  const labels = quote.routePlan
    .map((r) => r.swapInfo?.label)
    .filter((l): l is string => Boolean(l))
    .filter((v, i, a) => a.indexOf(v) === i);   // deduplicate

  return labels.length > 0 ? labels.join(" → ") : "Jupiter";
}

/**
 * Format the Jupiter quote output for display in the UI.
 *
 * For buy  (SOL → TOKEN): outAmount is in token atoms → "X.XX TOKEN"
 * For sell (TOKEN → SOL): outAmount is in lamports (9 decimals) → "0.XXX SOL"
 *
 * @param decimals  Token's SPL decimal count.  Defaults to 6 (pump.fun standard).
 *                  Pass the actual value for external / non-pump.fun tokens.
 */
export function formatJupiterOutput(
  quote:     JupiterQuoteResponse,
  tradeMode: "buy" | "sell",
  symbol:    string,
  decimals   = 6,
): string {
  const raw = BigInt(quote.outAmount);
  if (tradeMode === "buy") {
    const divisor = Math.pow(10, decimals);
    const display = Number(raw) / divisor;
    const formatted = display >= 1_000_000
      ? `${(display / 1_000_000).toFixed(2)}M`
      : display >= 1_000
        ? `${(display / 1_000).toFixed(2)}K`
        : display.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return `${formatted} ${symbol}`;
  } else {
    // outAmount = lamports → SOL
    const sol = Number(raw) / 1_000_000_000;
    return `${sol.toFixed(4)} SOL`;
  }
}
