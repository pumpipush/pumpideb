/**
 * launchlabSwap.ts — Raydium LaunchLab on-chain buy/sell for bonding-curve tokens
 *
 * Builds buy/sell transactions for Raydium LaunchLab tokens that are still on the
 * bonding curve (graduated = false). Graduated LaunchLab tokens route through
 * Jupiter just like other graduated tokens.
 *
 * Uses the Raydium SDK's `raydium.launchpad.buyToken()` / `sellToken()` methods,
 * which handle all account derivation, pool-info fetching, and instruction building
 * internally — we only need to pass the mint, amount, slippage, and priority fee.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * SDK VERSION NOTES (same SDK as raydiumLauncher.ts, pinned to 0.2.60-alpha)
 * ────────────────────────────────────────────────────────────────────────────────
 * • SDK does NOT set recentBlockhash on LEGACY transactions — we fetch and stamp it.
 * • SLIPPAGE_UNIT inside SDK = 10 000 (BPS scale), so slippage BPS → new BN(bps).
 * • buyToken({ buyAmount }) = SOL lamports to spend (not token atoms).
 * • sellToken({ sellAmount }) = token atoms to sell (6-decimal base units, same as pump.fun).
 * • Return shape for TxVersion.LEGACY: { transaction: Transaction, signers: Signer[], extInfo }
 *   — there is only ONE transaction (unlike createLaunchpad which can return multiple).
 * ────────────────────────────────────────────────────────────────────────────────
 */

import { PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { getConnection } from "./solanaConnection";
export { waitForTxConfirmation } from "./pumpfun-swap";

// ── SDK cache ─────────────────────────────────────────────────────────────────
// Dynamic import so the ~10 MB SDK chunk is only fetched when the user first
// tries to trade a LaunchLab token. Module resolution dedups with raydiumLauncher.ts
// because both import the same specifier — the browser's ES module cache ensures
// the download happens at most once per session.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _cachedSdk: any | null = null;

async function _getSdk(): Promise<any> {
  if (_cachedSdk) return _cachedSdk;
  _cachedSdk = await import("@raydium-io/raydium-sdk-v2");
  return _cachedSdk;
}

/**
 * Initialise a Raydium SDK instance scoped to the connected user.
 * disableLoadToken skips the ~30 MB token-list download.
 */
async function _initRaydium(walletPublicKey: string) {
  const sdk = await _getSdk();
  const { Raydium } = sdk;
  const conn = getConnection();
  const owner = new PublicKey(walletPublicKey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (Raydium as any).load({
    connection:       conn,
    owner,
    cluster:          "mainnet" as const,
    disableLoadToken: true,
  });
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface LaunchLabSwapResult {
  transaction:          Transaction;
  /** Blockhash embedded in the transaction — for waitForTxConfirmation */
  blockhash:            string;
  /** Slot window for the blockhash — for waitForTxConfirmation */
  lastValidBlockHeight: number;
}

export interface BuildLaunchLabBuyParams {
  /** Base58 mint address of the LaunchLab token (mintA in SDK terms) */
  mint:                      string;
  /** Base58 public key of the connected wallet */
  user:                      string;
  /** SOL lamports the user will spend (= buyAmount in SDK) */
  solLamports:               bigint;
  /** Slippage tolerance in basis points (e.g. 100 = 1%) */
  slippageBps:               number;
  /** Compute-unit priority fee in micro-lamports (0 = no priority fee) */
  priorityFeeMicroLamports?: number;
}

export interface BuildLaunchLabSellParams {
  /** Base58 mint address of the LaunchLab token */
  mint:                      string;
  /** Base58 public key of the connected wallet */
  user:                      string;
  /** Token atoms to sell (6-decimal base units — 1 display token = 1_000_000 atoms) */
  tokenAtoms:                bigint;
  /** Slippage tolerance in basis points */
  slippageBps:               number;
  /** Compute-unit priority fee in micro-lamports */
  priorityFeeMicroLamports?: number;
}

// ── Swap builders ─────────────────────────────────────────────────────────────

/**
 * Build a Raydium LaunchLab BUY transaction.
 *
 * buyAmount = SOL lamports to spend.
 * The SDK internally derives the pool PDA, fetches live pool state from the RPC
 * to calculate the expected token output, creates the user's ATA if needed, and
 * emits the `buyExactIn` instruction.
 *
 * Returns the unsigned LEGACY transaction + blockhash confirmation window.
 * The caller must pass this to `signAndSendTransaction()` (user wallet signs + broadcasts),
 * then await `waitForTxConfirmation()`.
 */
export async function buildLaunchLabBuyTx(
  params: BuildLaunchLabBuyParams,
): Promise<LaunchLabSwapResult> {
  const { mint, user, solLamports, slippageBps, priorityFeeMicroLamports } = params;

  const sdk = await _getSdk();
  const { TxVersion } = sdk;
  const raydium = await _initRaydium(user);

  const mintA     = new PublicKey(mint);
  const buyAmount = new BN(solLamports.toString());
  // SLIPPAGE_UNIT in SDK = 10 000 (BPS scale): pass raw BPS value directly.
  const slippage  = new BN(slippageBps);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await raydium.launchpad.buyToken({
    mintA,
    buyAmount,
    slippage,
    txVersion:           TxVersion.LEGACY,
    feePayer:            new PublicKey(user),
    computeBudgetConfig: priorityFeeMicroLamports
      ? { units: 400_000, microLamports: priorityFeeMicroLamports }
      : undefined,
  });

  return _finaliseTx(result, user);
}

/**
 * Build a Raydium LaunchLab SELL transaction.
 *
 * sellAmount = token atoms (6-decimal base units; 1 display token = 1_000_000 atoms).
 * The SDK fetches live pool state, calculates the SOL output, creates a temporary
 * WSOL account if needed, and emits the `sellExactIn` instruction.
 *
 * Returns the unsigned LEGACY transaction + blockhash confirmation window.
 */
export async function buildLaunchLabSellTx(
  params: BuildLaunchLabSellParams,
): Promise<LaunchLabSwapResult> {
  const { mint, user, tokenAtoms, slippageBps, priorityFeeMicroLamports } = params;

  const sdk = await _getSdk();
  const { TxVersion } = sdk;
  const raydium = await _initRaydium(user);

  const mintA      = new PublicKey(mint);
  const sellAmount = new BN(tokenAtoms.toString());
  const slippage   = new BN(slippageBps);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await raydium.launchpad.sellToken({
    mintA,
    sellAmount,
    slippage,
    txVersion:           TxVersion.LEGACY,
    feePayer:            new PublicKey(user),
    computeBudgetConfig: priorityFeeMicroLamports
      ? { units: 400_000, microLamports: priorityFeeMicroLamports }
      : undefined,
  });

  return _finaliseTx(result, user);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Extracts the Transaction from the SDK result, stamps it with a fresh blockhash
 * (the SDK does not set recentBlockhash for LEGACY txs as of 0.2.60-alpha),
 * and returns the confirmation window values.
 */
async function _finaliseTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdkResult: any,
  user: string,
): Promise<LaunchLabSwapResult> {
  // buy/sell always return a single transaction (unlike createLaunchpad MultiTxBuildData)
  const tx: Transaction | undefined = sdkResult?.transaction ?? sdkResult?.transactions?.[0];
  if (!tx) {
    throw new Error(
      "Raydium LaunchLab SDK did not return a transaction — pool may not exist on-chain yet",
    );
  }

  // SDK does not set recentBlockhash on LEGACY txs; fetch + stamp before returning.
  // Use server-cached blockhash (/api/blockhash) — shared across all users,
  // saves one Alchemy Compute Unit call per LaunchLab trade.
  const _blockhashRes = await fetch("/api/blockhash");
  if (!_blockhashRes.ok) throw new Error(`Failed to fetch blockhash: ${_blockhashRes.status}`);
  const { blockhash, lastValidBlockHeight } = await _blockhashRes.json() as { blockhash: string; lastValidBlockHeight: number };
  if (!tx.recentBlockhash) tx.recentBlockhash = blockhash;
  if (!tx.feePayer) tx.feePayer = new PublicKey(user);

  return { transaction: tx, blockhash, lastValidBlockHeight };
}
