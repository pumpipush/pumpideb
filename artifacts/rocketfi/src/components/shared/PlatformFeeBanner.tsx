/**
 * PlatformFeeBanner — dev-only warning banner shown when VITE_PLATFORM_FEE_RECIPIENT is not set.
 *
 * Renders nothing in production or when the fee recipient is correctly configured.
 */

import { isPlatformFeeConfigured } from "@/lib/platform-fee";

export function PlatformFeeBanner() {
  // Only show in development mode
  if (import.meta.env.PROD) return null;
  // Only show when fee recipient is not configured
  if (isPlatformFeeConfigured()) return null;

  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: "#b45309",
        color: "#fff",
        fontSize: "13px",
        fontWeight: 600,
        textAlign: "center",
        padding: "6px 16px",
        letterSpacing: "0.01em",
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      ⚠️ DEV: <code style={{ fontWeight: 700 }}>VITE_PLATFORM_FEE_RECIPIENT</code> is not set — all platform fees will be skipped
    </div>
  );
}
