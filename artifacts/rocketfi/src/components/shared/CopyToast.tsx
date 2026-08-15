/**
 * Global copy notification — a slick floating pill that appears bottom-center
 * when anything is copied to the clipboard.
 *
 * Usage:
 *   import { copyToClipboard } from "@/components/shared/CopyToast";
 *   await copyToClipboard("0xabc…");          // address pill
 *   await copyToClipboard(url, "Link copied"); // custom label
 *
 * Mount <CopyToastProvider /> once in App.tsx.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy } from "lucide-react";

/* ─── Module-level notifier ─────────────────────────────────────── */
type Notif = { label: string; sub?: string; id: number };

let _notify: ((n: Notif) => void) | null = null;
let _uid = 0;

function truncate(s: string, max = 20): string {
  if (s.length <= max) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

/** Copy text and fire the floating notification. */
export async function copyToClipboard(text: string, label?: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* fallback for insecure context */
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  }

  // Detect Solana base58 public keys (32–44 chars) or Ethereum 0x addresses
  const isAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text.trim()) || /^0x[0-9a-fA-F]{40,}$/.test(text.trim());
  const sub = isAddress ? truncate(text) : undefined;
  const resolvedLabel = label ?? (isAddress ? "Address copied" : "Copied to clipboard");

  _notify?.({ label: resolvedLabel, sub, id: ++_uid });
}

/* ─── Provider ───────────────────────────────────────────────────── */
export function CopyToastProvider() {
  const [notif, setNotif] = useState<Notif | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    _notify = (n) => {
      // cancel any pending hide
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (exitTimer.current) clearTimeout(exitTimer.current);

      setNotif(n);
      setVisible(true);

      hideTimer.current = setTimeout(() => {
        setVisible(false);
        exitTimer.current = setTimeout(() => setNotif(null), 300);
      }, 1900);
    };
    // Bug fix: clear both timers on unmount to prevent state updates after unmount
    return () => {
      _notify = null;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (exitTimer.current) clearTimeout(exitTimer.current);
    };
  }, []);

  if (!notif) return null;

  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-20 md:bottom-8 z-[9999] flex justify-center px-4"
      style={{ isolation: "isolate" }}
    >
      <div
        className="relative flex items-center gap-2.5 px-4 py-2.5 rounded-full shadow-2xl
          bg-[#0f1a2e]/95 border border-[#22C55E]/30 backdrop-blur-md
          transition-all duration-300 ease-out
          "
        style={{
          transform: visible ? "translateY(0) scale(1)" : "translateY(12px) scale(0.96)",
          opacity: visible ? 1 : 0,
        }}
      >
        {/* Glow ring */}
        <span className="absolute inset-0 rounded-full ring-1 ring-inset ring-[#22C55E]/10 pointer-events-none" />

        {/* Animated check icon */}
        <span
          className="flex h-5 w-5 items-center justify-center rounded-full bg-[#22C55E]/15 shrink-0"
        >
          <Check
            className="h-3 w-3 text-[#22C55E]"
            strokeWidth={3}
          />
        </span>

        {/* Text */}
        <div className="flex flex-col leading-none">
          <span className="text-xs font-semibold text-white tracking-wide">
            {notif.label}
          </span>
          {notif.sub && (
            <span className="text-[10px] font-mono text-[#666666] mt-0.5">
              {notif.sub}
            </span>
          )}
        </div>

        {/* Subtle copy icon */}
        <Copy className="h-3.5 w-3.5 text-[#3a3a3a] shrink-0 ml-0.5" />
      </div>
    </div>,
    document.body,
  );
}
