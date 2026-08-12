/**
 * useTxToast — transaction lifecycle toast hook.
 *
 * Usage:
 *   const { submitTx } = useTxToast();
 *   await submitTx(sendOnChainTx(), "Buy");
 *
 * Behaviour:
 * - Shows "Pending…" immediately (no auto-dismiss while waiting).
 * - On success: "Confirmed ✓" with Solscan link — auto-dismisses after 6 s.
 * - On failure: "Failed" with error message — auto-dismisses after 8 s.
 * - The X button always works immediately.
 */

import { toast } from "@/hooks/use-toast";

const SOLSCAN_TX = "https://solscan.io/tx/";

/** Auto-dismiss delays in ms */
const DISMISS_SUCCESS_MS = 6_000;
const DISMISS_FAILURE_MS = 8_000;

/** A real Solana transaction signature is base58, 87-88 chars, no 0x prefix. */
function isRealSignature(sig: string): boolean {
  return sig.length >= 60 && !sig.startsWith("0x") && !sig.startsWith("sim_");
}

export function useTxToast() {
  const submitTx = async (
    txPromise: Promise<string>,
    label?: string,
  ): Promise<string | null> => {
    const title = label ?? "Trade";

    const { id, update, dismiss } = toast({
      title: `${title} Pending…`,
      description: "Waiting for Solana network confirmation",
    });

    try {
      const signature = await txPromise;

      if (isRealSignature(signature)) {
        update({
          id,
          title: `${title} Confirmed ✓`,
          description: (
            <a
              href={`${SOLSCAN_TX}${signature}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "hsl(var(--primary))", textDecoration: "underline", fontSize: 13 }}
            >
              View on Solscan ↗
            </a>
          ),
          open: true,
        });
      } else {
        update({
          id,
          title: `${title} Order Filled`,
          description: "Trade recorded. On-chain execution enabled in the next update.",
          open: true,
        });
      }

      setTimeout(dismiss, DISMISS_SUCCESS_MS);
      return signature || null;
    } catch (err) {
      // Wallet providers (Phantom, Backpack, Solflare) bury the real program
      // error in err.data — e.g. { data: { message, logs: [...] } }.
      // Prefer that over the generic top-level message ("Internal error").
      let msg = "Something went wrong. Please try again.";
      if (err instanceof Error) {
        msg = err.message;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const errData = (err as any).data;
        if (errData?.message && typeof errData.message === "string") {
          msg = errData.message;
        } else if (Array.isArray(errData?.logs) && errData.logs.length > 0) {
          const logs: string[] = errData.logs;
          const detail =
            logs.find(l => /AnchorError|Error:|failed:|Program log:/i.test(l)) ??
            logs.at(-1);
          if (detail) msg = detail;
        }
        console.error("[useTxToast] tx failed:", err);
        // Replace the raw "block height exceeded" RPC error with a user-friendly hint.
        if (/block height exceeded|blockheight exceeded/i.test(msg)) {
          msg = "Transaction timed out — it was not executed. Please try again (network was congested).";
        }
        msg = msg.slice(0, 200);
      }

      update({
        id,
        title: `${title} Failed`,
        description: msg,
        variant: "destructive",
        open: true,
      });

      setTimeout(dismiss, DISMISS_FAILURE_MS);
      return null;
    }
  };

  return { submitTx };
}
