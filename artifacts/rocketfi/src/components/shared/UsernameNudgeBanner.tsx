/**
 * UsernameNudgeBanner — one-time prompt to set a real username.
 *
 * Shown after wallet connection OR social sign-in when the profile username is
 * still the auto-generated default (starts with "user_"). Dismissed via an ×
 * button and the dismiss state is persisted to localStorage per address.
 *
 * Rendered at the top of the main content area in AppShell so it pushes
 * content down naturally without overlapping it.
 */

import { useState, useEffect } from "react";
import { useWallet } from "@/contexts/WalletContext";
import { useAuth } from "@/contexts/AuthContext";
import { useGetProfile, getGetProfileQueryKey } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { X, Sparkles } from "lucide-react";

function dismissKey(address: string) {
  return `pumpi_username_nudge_dismissed_${address}`;
}

export function UsernameNudgeBanner() {
  const { wallet } = useWallet();
  const { socialUser } = useAuth();
  const [, setLocation] = useLocation();
  const [dismissed, setDismissed] = useState(false);

  // Use wallet address first, fall back to social user's UUID address
  const effectiveAddress = wallet ?? socialUser?.address ?? null;

  const { data: profile } = useGetProfile(effectiveAddress ?? "", {
    query: {
      enabled: !!effectiveAddress,
      retry: false,
      queryKey: getGetProfileQueryKey(effectiveAddress ?? ""),
    },
  });

  // Re-check localStorage whenever the effective address changes
  useEffect(() => {
    if (!effectiveAddress) { setDismissed(false); return; }
    setDismissed(localStorage.getItem(dismissKey(effectiveAddress)) === "1");
  }, [effectiveAddress]);

  // Nothing to show if nobody is signed in, already dismissed, or username is custom
  if (!effectiveAddress) return null;
  if (dismissed) return null;
  if (!profile) return null;
  if (!profile.username?.startsWith("user_")) return null;

  function handleDismiss() {
    if (effectiveAddress) localStorage.setItem(dismissKey(effectiveAddress), "1");
    setDismissed(true);
  }

  function handleSetUsername() {
    // Navigate to the profile by username (even "user_xxx" slugs are valid routes)
    // rather than the raw wallet address so the URL stays readable.
    setLocation(`/profile/${profile?.username}?editUsername=1`);
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
