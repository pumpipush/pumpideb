/**
 * tradeOrchestrator.ts — shared post-broadcast confirmation step.
 *
 * All four on-chain trade paths in AppInterface.tsx (Jupiter graduated,
 * LaunchLab bonding curve, pump.fun portal, external Jupiter) follow the
 * same pattern after a transaction is broadcast:
 *
 *   1. Await on-chain confirmation via the path-specific adapter.
 *   2. If confirmed: run the onSuccess callback (clears form, refreshes data).
 *   3. If failed/timed-out: throw — the outer submitTx wrapper catches this
 *      and shows a "Failed" toast; the finally block resets isTradePending.
 *
 * Extracting this into a named, exported function lets tests import and
 * exercise the REAL production logic rather than a replica.
 */

/**
 * The type of a confirmation adapter — either waitForJupiterTxConfirmation
 * or waitForTxConfirmation — both share this signature.
 */
export type ConfirmationAdapter = (
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
) => Promise<void>;

/**
 * Await on-chain confirmation then run the success callback.
 *
 * If the adapter resolves (tx confirmed): `onSuccess()` is called (which
 * typically clears the amount field and triggers data refreshes), then the
 * signature is returned as the trade result.
 *
 * If the adapter throws (timeout, on-chain error, RPC failure): the error
 * propagates immediately — `onSuccess()` is NOT called, preserving the
 * amount field and any pending UI state. The caller's `submitTx` wrapper
 * catches the error and shows a "Failed" toast.
 *
 * @param signature            On-chain transaction signature
 * @param blockhash            Recent blockhash embedded in the transaction
 * @param lastValidBlockHeight Blockhash validity window — passed to the adapter
 * @param adapter              Path-specific confirmation function
 * @param onSuccess            Called only when confirmation succeeds
 *                             (e.g. setAmount("") + data refreshes)
 * @returns The signature, for use as the submitTx promise result
 */
export async function awaitConfirmAndRelease(
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
  adapter: ConfirmationAdapter,
  onSuccess: () => void,
): Promise<string> {
  // Throws on timeout or on-chain failure — never swallowed here.
  await adapter(signature, blockhash, lastValidBlockHeight);

  // Reached only when confirmation succeeded.
  onSuccess();
  return signature;
}
