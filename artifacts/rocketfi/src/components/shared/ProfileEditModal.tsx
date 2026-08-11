/**
 * ProfileEditModal — standalone "Edit Profile" sheet.
 *
 * Self-contained: reads wallet + profile from context/hooks, owns all form
 * state and the authenticated PATCH flow. Drop it anywhere with just two
 * props: `open` / `onOpenChange`.
 *
 * Optional `onSaved(newUsername)` lets the parent react to a successful save
 * (e.g. redirect to the new profile URL).
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useLocation } from "wouter";
import { useWallet } from "@/contexts/WalletContext";
import {
  useGetProfile,
  getGetProfileQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { diceBearUrl, formatAddress } from "@/lib/utils";
import { generateUsername } from "@/lib/username";
import { useToast } from "@/hooks/use-toast";
import {
  X,
  Camera,
  Check,
  Loader2,
  Globe,
} from "lucide-react";

// ─── X icon (Twitter/X) ───────────────────────────────────────────────────────
const XIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.91-5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

// ─── Base58 encoder ───────────────────────────────────────────────────────────
const BS58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  const chars: string[] = [];
  while (n > 0n) { chars.unshift(BS58_ALPHA[Number(n % 58n)]); n /= 58n; }
  let leading = 0;
  for (const b of bytes) { if (b !== 0) break; leading++; }
  return "1".repeat(leading) + chars.join("");
}

// ─── URL sanitiser ────────────────────────────────────────────────────────────
function sanitizeUrl(url: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
interface ProfileEditModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save with the (potentially new) username. */
  onSaved?: (username: string) => void;
}

export function ProfileEditModal({ open, onOpenChange, onSaved }: ProfileEditModalProps) {
  const { wallet, signMessage } = useWallet();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data: profile, isLoading: profileLoading } = useGetProfile(wallet ?? "", {
    query: { enabled: !!wallet, retry: false, queryKey: getGetProfileQueryKey(wallet ?? "") },
  });

  const address = profile?.address ?? wallet ?? "";

  // ── Form state ──────────────────────────────────────────────────────────────
  const [form, setForm] = useState<{
    username: string;
    bio: string;
    twitterHandle: string;
    websiteUrl: string;
    avatarUrl: string;
    avatarPreview: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize form reactively: wait for the profile query to settle before
  // populating fields so we never open with stale/blank data.
  useEffect(() => {
    if (!open) {
      // Reset when modal closes so next open gets a fresh init
      setForm(null);
      return;
    }
    if (!wallet) return;
    if (profileLoading) return; // query still in flight — keep form null (spinner shown)

    // Query settled (profile row exists or wallet has no row yet)
    const addr = profile?.address ?? wallet;
    const uname = profile?.username ?? "";
    const autoName = uname.startsWith("user_")
      ? generateUsername(addr)
      : (uname || generateUsername(addr));
    setForm({
      username: autoName,
      bio: profile?.bio ?? "",
      twitterHandle: profile?.twitterHandle ?? "",
      websiteUrl: profile?.websiteUrl ?? "",
      avatarUrl: profile?.avatarUrl ?? "",
      avatarPreview: profile?.avatarUrl ?? "",
    });
    // Only re-init when the modal first opens or profile identity changes.
    // Intentionally omit `profile` fields from deps so typing doesn't reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wallet, profileLoading]);

  const close = () => {
    onOpenChange(false);
    // form will be reset by the useEffect above when open → false
  };

  // ── Avatar handling ─────────────────────────────────────────────────────────
  const handleAvatarFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    setAvatarUploading(true);
    const reader = new FileReader();
    reader.onerror = () => { setAvatarUploading(false); };
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => { setAvatarUploading(false); };
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const SIZE = 256;
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) { setAvatarUploading(false); return; }
        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;
        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, SIZE, SIZE);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        setForm((f) => f && { ...f, avatarUrl: dataUrl, avatarPreview: dataUrl });
        setAvatarUploading(false);
      };
      img.src = e.target!.result as string;
    };
    reader.readAsDataURL(file);
  }, []);

  // ── Save ────────────────────────────────────────────────────────────────────
  const saveProfile = async () => {
    if (!form || !wallet || !address) return;
    setSaving(true);
    try {
      const challengeRes = await fetch("/api/profiles/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", address }),
      });
      if (!challengeRes.ok) throw new Error("Failed to obtain signing challenge");
      const { nonce } = await challengeRes.json() as { nonce: string };

      const message = `RocketFi:update:${address}:${nonce}`;
      const messageBytes = new TextEncoder().encode(message);
      const sigBytes = await signMessage(messageBytes);
      if (!(sigBytes instanceof Uint8Array) || sigBytes.length !== 64) {
        throw new Error("Wallet returned an invalid signature — please try again");
      }
      const signature = bs58Encode(sigBytes);

      const res = await fetch(`/api/profiles/${address}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: wallet,
          signature,
          message,
          username: form.username || undefined,
          bio: form.bio || undefined,
          twitterHandle: form.twitterHandle.replace(/^@+/, "").trim() || undefined,
          websiteUrl: sanitizeUrl(form.websiteUrl),
          avatarUrl: form.avatarUrl || undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }

      const saved = await res.json() as { username?: string };
      const newUsername = saved.username ?? (profile?.username ?? "");

      // Invalidate all profile-related queries so callers re-fetch
      await queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey(wallet) });
      if (profile?.username && profile.username !== wallet) {
        await queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey(profile.username) });
      }

      close();
      toast({ title: "Profile saved", description: "Your profile has been updated." });

      if (onSaved) {
        onSaved(newUsername);
      } else if (newUsername && newUsername !== profile?.username) {
        // Default: redirect to new username URL when called from outside profile page
        setLocation(`/profile/${newUsername}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save profile";
      toast({ title: "Save failed", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (!open || !wallet) return null;

  // Show a loading shell while the profile query is still in flight
  if (!form) {
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={close} />
        <div className="relative w-full sm:max-w-lg bg-card border border-border rounded-t-2xl sm:rounded-sm shadow-2xl p-5 sm:p-6 z-10">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-bold text-foreground">Edit Profile</h2>
            <button onClick={close} className="text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={close} />

      <div className="relative w-full sm:max-w-lg bg-card border border-border rounded-t-2xl sm:rounded-sm shadow-2xl p-5 sm:p-6 z-10 max-h-[90dvh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-bold text-foreground">Edit Profile</h2>
          <button onClick={close} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Avatar upload */}
        <div className="flex items-center gap-4 mb-6">
          <div className="relative w-20 h-20 rounded-full overflow-hidden border-2 border-border bg-muted shrink-0">
            <img
              src={form.avatarPreview || diceBearUrl(address)}
              alt="avatar"
              className="w-full h-full object-cover"
              style={{ imageRendering: form.avatarPreview ? "auto" : "pixelated" }}
            />
            {avatarUploading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                <Loader2 className="w-5 h-5 animate-spin text-white" />
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Button
              type="button" size="sm" variant="outline"
              className="rounded-sm h-8 text-xs"
              onClick={() => fileInputRef.current?.click()}
              disabled={avatarUploading}
            >
              <Camera className="w-3.5 h-3.5 mr-1.5" />
              {form.avatarPreview ? "Change photo" : "Upload photo"}
            </Button>
            {form.avatarPreview && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-destructive transition-colors text-left"
                onClick={() => setForm((f) => f && { ...f, avatarUrl: "", avatarPreview: "" })}
              >
                Remove photo
              </button>
            )}
            <p className="text-[10px] text-muted-foreground leading-tight">JPG, PNG, GIF — max 2 MB</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleAvatarFile(file);
              e.target.value = "";
            }}
          />
        </div>

        {/* Username */}
        <div className="space-y-1 mb-4">
          <label className="text-xs font-medium text-muted-foreground">Username</label>
          <Input
            value={form.username}
            onChange={(e) => setForm((f) => f && { ...f, username: e.target.value })}
            className="h-9 text-sm rounded-sm bg-background border-border/50"
            placeholder={generateUsername(address)}
            maxLength={32}
          />
          <p className="text-[10px] text-muted-foreground">
            Auto-generated: <span className="text-foreground/60">{generateUsername(address)}</span>
          </p>
        </div>

        {/* Bio */}
        <div className="space-y-1 mb-4">
          <label className="text-xs font-medium text-muted-foreground">Bio</label>
          <Textarea
            value={form.bio}
            onChange={(e) => setForm((f) => f && { ...f, bio: e.target.value })}
            className="text-sm rounded-sm bg-background border-border/50 resize-none"
            placeholder="Tell the community about yourself..."
            rows={3}
            maxLength={200}
          />
          <p className="text-[10px] text-muted-foreground text-right">{form.bio.length}/200</p>
        </div>

        {/* Social links */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <XIcon className="w-3 h-3" /> X (Twitter)
            </label>
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">@</span>
              <Input
                value={form.twitterHandle}
                onChange={(e) => setForm((f) => f && { ...f, twitterHandle: e.target.value.replace("@", "") })}
                className="h-9 text-sm rounded-sm bg-background border-border/50 pl-7"
                placeholder="username"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Globe className="w-3 h-3" /> Website
            </label>
            <Input
              value={form.websiteUrl}
              onChange={(e) => setForm((f) => f && { ...f, websiteUrl: e.target.value })}
              className="h-9 text-sm rounded-sm bg-background border-border/50"
              placeholder="https://..."
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button
            className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-sm font-bold h-9 px-6 flex-1 sm:flex-none"
            onClick={saveProfile}
            disabled={saving || avatarUploading}
          >
            {saving
              ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Saving…</>
              : <><Check className="w-3.5 h-3.5 mr-1.5" /> Save changes</>}
          </Button>
          <Button
            variant="ghost"
            className="rounded-sm h-9 text-muted-foreground hover:text-foreground"
            onClick={close}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
