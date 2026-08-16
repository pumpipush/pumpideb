/**
 * Classify what a confirmation timeout actually means for a launch transaction.
 *
 * After `waitForTxConfirmation` times out, the outcome is NOT automatically
 * "failed" — free RPCs frequently just miss the confirmation. Building a fresh
 * mint (or telling the user "your coin was NOT launched") is only safe when we
 * have conclusive on-chain evidence that this signed transaction cannot have
 * created a coin.
 *
 * Conclusive evidence is exactly one of:
 *  - the signature landed WITH an on-chain error (`status.err`), or
 *  - the signature is definitively absent (`status === null` from a successful
 *    lookup with searchTransactionHistory) AND the current block height has
 *    passed `lastValidBlockHeight` — the blockhash validity window is closed,
 *    so the transaction can never be included anymore.
 *
 * Everything else — RPC lookup failure, `processed` (in a block, may still
 * confirm), unconfirmed status, or an open validity window — is "unknown":
 * do not retry with a fresh mint and do not show the definitive copy.
 */

export type SigStatusValue = {
  err: unknown;
  confirmationStatus?: string | null;
} | null;

export type LaunchConfirmOutcome = "confirmed" | "not_landed" | "unknown";

export function classifyLaunchConfirmOutcome(opts: {
  /** Result of getSignatureStatus().value — `undefined` when the lookup itself failed. */
  status: SigStatusValue | undefined;
  /** Current block height — `null` when the lookup failed. */
  currentBlockHeight: number | null;
  /** lastValidBlockHeight of the blockhash the tx was built with. */
  lastValidBlockHeight: number;
}): LaunchConfirmOutcome {
  const { status, currentBlockHeight, lastValidBlockHeight } = opts;

  if (status === undefined) return "unknown"; // status lookup failed — no evidence

  if (status) {
    if (status.err) return "not_landed"; // landed but failed on-chain — no coin was created
    if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
      return "confirmed";
    }
    // "processed" (or missing confirmationStatus): in a block, may still confirm.
    return "unknown";
  }

  // status === null — the signature has not been observed. Only conclusive when
  // the validity window has provably closed.
  if (currentBlockHeight !== null && currentBlockHeight > lastValidBlockHeight) {
    return "not_landed";
  }
  return "unknown";
}
