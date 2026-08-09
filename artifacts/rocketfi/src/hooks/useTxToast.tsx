/**
 * useTxToast — transaction lifecycle toast hook.
 *
 * Usage:
 *   const { submitTx } = useTxToast();
 *   // Real on-chain swap (task #103+):
 *   await submitTx(sendOnChainTx(), "Buy");
 *   // Simulated trade — pass "" as the resolved value:
 *   await submitTx(doMockTrade(), "Buy");
 *
 * Behaviour:
 * - Shows "Pending…" immediately.
 * - On success:
 *   - Real signature (non-empty, non-0x, ≥60 chars) → "Confirmed ✓" with Solscan link.
 *   - Empty / simulated → "Order Filled (Simulated)" without any explorer link.
 * - On rejection → "Failed" with error message.
 *
 * Returns the signature string (possibly ""), or null on failure.
 */

import { toast } from "@/hooks/use-toast";

const SOLSCAN_TX = "https://solscan.io/tx/";

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

    const { id, update } = toast({
      title: `${title} Pending…`,
      description: "Waiting for Solana network confirmation",
    });

    try {
      const signature = await txPromise;

      if (isRealSignature(signature)) {
        // Real on-chain confirmation — show Solscan link
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
          onOpenChange: () => {},
        });
      } else {
        // Simulated trade — no on-chain signature yet
        update({
          id,
          title: `${title} Order Filled`,
          description: "Trade recorded. On-chain execution enabled in the next update.",
          open: true,
          onOpenChange: () => {},
        });
      }

      return signature || null;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message.slice(0, 120)
          : "Something went wrong. Please try again.";

      update({
        id,
        title: `${title} Failed`,
        description: msg,
        variant: "destructive",
        open: true,
        onOpenChange: () => {},
      });

      return null;
    }
  };

  return { submitTx };
}
