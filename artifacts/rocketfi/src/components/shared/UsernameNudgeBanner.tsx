/**
 * UsernameNudgeBanner — one-time prompt to set a real username.
 *
 * Shown after wallet connection when the profile username is still the
 * auto-generated default (starts with "user_"). Dismissed via an ×
 * button and the dismiss state is persisted to localStorage per wallet.
 *
 * Rendered at the top of the main content area in AppShell so it pushes
 * content down naturally without overlapping it.
 */

import { useState, useEffect } from "react";
import { useWallet } from "@/contexts/WalletContext";
import { useGetProfile, getGetProfileQueryKey } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { X, Sparkles } from "lucide-react";

function dismissKey(wallet: string) {
  return `pumpi_username_nudge_dismissed_${wallet}`;
}

export function UsernameNudgeBanner() {
  const { wallet } = useWallet();
  const [, setLocation] = useLocation();
  const [dismissed, setDismissed] = useState(false);

  const { data: profile } = useGetProfile(wallet ?? "", {
    query: {
      enabled: !!wallet,
      retry: false,
      queryKey: getGetProfileQueryKey(wallet ?? ""),
    },
  });

  // Re-check localStorage whenever the wallet changes
  useEffect(() => {
    if (!wallet) {
      setDismissed(false);
      return;
    }
    setDismissed(localStorage.getItem(dismissKey(wallet)) === "1");
  }, [wallet]);

  // Nothing to show: no wallet, dismissed, or already has a custom username
  if (!wallet) return null;
  if (dismissed) return null;
  if (!profile) return null;
  if (!profile.username?.startsWith("user_")) return null;

  function handleDismiss() {
    if (wallet) localStorage.setItem(dismissKey(wallet), "1");
    setDismissed(true);
  }

  function handleSetUsername() {
    setLocation(`/profile/${wallet}?editUsername=1`);
  }

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-primary/10 border-b border-primary/20">
      <div className="flex items-center gap-2 min-w-0">
        <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
        <p className="text-xs text-foreground/80">
          Your profile URL uses a placeholder name.{" "}
          <button
            onClick={handleSetUsername}
            className="font-semibold text-primary hover:text-primary/80 underline underline-offset-2 transition-colors"
          >
            Set a real username
          </button>{" "}
          so your link looks great.
        </p>
      </div>
      <button
        onClick={handleDismiss}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
