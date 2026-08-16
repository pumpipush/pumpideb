/**
 * useTxToast — transaction lifecycle toast hook.
 *
 * Usage:
 *   const { submitTx } = useTxToast();
 *   await submitTx(sendOnChainTx(), "Buy");
 *
 * Behaviour:
 * - Shows "Pending…" (blue) immediately — no auto-dismiss while waiting.
 * - On success: "Confirmed ✓" (green) with Solscan link — auto-dismisses after 6 s.
 * - On failure: "Failed" (red) with a friendly error message — auto-dismisses after 8 s.
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

/**
 * Map raw RPC/program errors to readable messages.
 *
 * Covers the most common failures a pump.fun / pumpportal trader will see:
 *  - 0x1772 (6002) — SlippageExceeded: price moved past the encoded tolerance
 *  - 0x1771 (6001) — NotEnoughSOL: wallet balance too low
 *  - 0x1770 (6000) — NotEnoughTokens: token balance too low for sell
 *  - block height exceeded — tx not included before blockhash expired
 *  - Simulation failed — preflight caught a bad tx before broadcast
 */
function friendlyTxError(raw: string): string {
  if (/block.?height exceeded|blockheight exceeded/i.test(raw)) {
    return "Transaction timed out — it was not executed. Please try again (network was congested).";
  }
  if (/0x1772|custom program error.*6002/i.test(raw)) {
    return "Slippage exceeded — price moved too fast. Try increasing your slippage tolerance in settings and retry.";
  }
  if (/0x1771|custom program error.*6001/i.test(raw)) {
    return "Not enough SOL in your wallet to cover this trade plus fees.";
  }
  if (/0x1770|custom program error.*6000/i.test(raw)) {
    return "Not enough tokens in your wallet for this sell.";
  }
  if (/simulation failed/i.test(raw)) {
    // Strip the verbose preamble and keep only the useful inner message
    const inner = raw.replace(/^.*simulation failed[^:]*:\s*/i, "");
    return `Simulation failed: ${inner}` ;
  }
  return raw;
}

export function useTxToast() {
  const submitTx = async (
    txPromise: Promise<string>,
    label?: string,
  ): Promise<string | null> => {
    const title = label ?? "Trade";

    // Pending — blue accent (neutral informational)
    const { id, update, dismiss } = toast({
      title: `${title} Pending…`,
      description: "Broadcasting & confirming on-chain — please wait",
      variant: "default",
    });

    try {
      const signature = await txPromise;

      if (isRealSignature(signature)) {
        // Confirmed — green accent
        update({
          id,
          variant: "success" as never,
          title: `${title} Confirmed`,
          description: (
            <a
              href={`${SOLSCAN_TX}${signature}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: "hsl(152 76% 60%)",
                textDecoration: "underline",
                fontSize: 12,
                fontFamily: "monospace",
              }}
            >
              {signature.slice(0, 16)}…{signature.slice(-8)} ↗
            </a>
          ),
          open: true,
        });
      } else {
        update({
          id,
          variant: "success" as never,
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
        msg = friendlyTxError(msg);
        msg = msg.slice(0, 200);
      }

      // Failed — red accent
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
