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
import { useAuth } from "@/contexts/AuthContext";
import {
  useGetProfile,
  getGetProfileQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { diceBearUrl, formatAddress } from "@/lib/utils";
import { performPostSave } from "@/lib/profileDisplayUtils";
import { generateUsername } from "@/lib/username";
import { useToast } from "@/hooks/use-toast";
import {
  X,
  Camera,
  Check,
  Loader2,
  Globe,
  Wallet,
  Unlink,
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
  /** When true, focuses the username input as soon as the form initialises. */
  focusUsername?: boolean;
}

export function ProfileEditModal({ open, onOpenChange, onSaved, focusUsername }: ProfileEditModalProps) {
  const { wallet, signMessage, openWalletModal } = useWallet();
  const { socialUser, authHeaders, refreshSocialUser, getWalletLinkChallenge, linkWallet, unlinkWallet } = useAuth();
  const { toast } = useToast();
  const [walletLinking, setWalletLinking] = useState(false);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  // Social users always use their social profile address.
  // The wallet is used only as a signer for wallet-linking — it never becomes
  // the profile identity when a social user is active.
  const effectiveAddress = socialUser?.address ?? wallet ?? "";

  const { data: profile, isLoading: profileLoading } = useGetProfile(effectiveAddress, {
    query: { enabled: !!effectiveAddress, retry: false, queryKey: getGetProfileQueryKey(effectiveAddress) },
  });

  const address = profile?.address ?? effectiveAddress;

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
  const usernameInputRef = useRef<HTMLInputElement>(null);

  // Initialize form reactively: wait for the profile query to settle before
  // populating fields so we never open with stale/blank data.
  useEffect(() => {
    if (!open) {
      // Reset when modal closes so next open gets a fresh init
      setForm(null);
      return;
    }
    if (!effectiveAddress) return;
    if (profileLoading) return; // query still in flight — keep form null (spinner shown)

    // Query settled (profile row exists or address has no row yet)
    const addr = profile?.address ?? effectiveAddress;
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

    // Focus the username field after it renders (e.g. when coming from the nudge banner)
    if (focusUsername) {
      setTimeout(() => usernameInputRef.current?.focus(), 50);
    }
    // Only re-init when the modal first opens or identity changes.
    // Intentionally omit `profile` fields from deps so typing doesn't reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, effectiveAddress, profileLoading]);

  const close = () => {
    onOpenChange(false);
    // form will be reset by the useEffect above when open → false
  };

  // ── Avatar handling ─────────────────────────────────────────────────────────
  // Crops the selected file to a 256×256 JPEG Blob.
  const cropToBlob = (file: File): Promise<Blob> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = () => reject(new Error("Failed to decode image"));
        img.onload = () => {
          const SIZE = 256;
          const canvas = document.createElement("canvas");
          canvas.width = SIZE; canvas.height = SIZE;
          const ctx = canvas.getContext("2d");
          if (!ctx) { reject(new Error("Canvas unavailable")); return; }
          const minDim = Math.min(img.width, img.height);
          const sx = (img.width - minDim) / 2;
          const sy = (img.height - minDim) / 2;
          ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, SIZE, SIZE);
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("Failed to encode image"))),
            "image/jpeg",
            0.82,
          );
        };
        img.src = e.target!.result as string;
      };
      reader.readAsDataURL(file);
    });

  const handleAvatarFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    setAvatarUploading(true);
    try {
      // 1. Crop to 256×256 JPEG Blob
      const blob = await cropToBlob(file);

      // Show a local preview immediately while the upload is in progress
      const previewUrl = URL.createObjectURL(blob);
      setForm((f) => f && { ...f, avatarPreview: previewUrl });

      const jwtHeaders = authHeaders();

      if (jwtHeaders.Authorization) {
        // ── Social auth user: GCS presigned-URL flow ──────────────────────
        // Step 2: get a presigned PUT URL
        const reqRes = await fetch("/api/storage/uploads/request-url", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...jwtHeaders },
          body: JSON.stringify({ name: "avatar.jpg", size: blob.size, contentType: "image/jpeg" }),
        });
        if (!reqRes.ok) {
          const err = await reqRes.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error ?? "Failed to get upload URL");
        }
        const { uploadURL, objectPath } = await reqRes.json() as { uploadURL: string; objectPath: string };

        // Step 3: PUT blob directly to GCS
        const putRes = await fetch(uploadURL, {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          body: blob,
        });
        if (!putRes.ok) throw new Error("Image upload to storage failed");

        // Step 4: confirm — makes object accessible and returns the serving URL
        const confirmRes = await fetch("/api/storage/uploads/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...jwtHeaders },
          body: JSON.stringify({ objectPath }),
        });
        if (!confirmRes.ok) {
          const err = await confirmRes.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error ?? "Failed to confirm upload");
        }
        const { servingUrl } = await confirmRes.json() as { servingUrl: string };

        // Store the serving URL — not a data URL — so the DB column stays lean
        setForm((f) => f && { ...f, avatarUrl: servingUrl });
      } else {
        // ── Wallet-only user: fall back to data URL (no JWT for storage API) ──
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = reject;
          reader.onload = (e) => resolve(e.target!.result as string);
          reader.readAsDataURL(blob);
        });
        setForm((f) => f && { ...f, avatarUrl: dataUrl });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Image upload failed";
      toast({ title: "Upload failed", description: msg, variant: "destructive" });
      // Reset preview to what it was before the failed upload
      setForm((f) => f && { ...f, avatarPreview: f.avatarUrl });
    } finally {
      setAvatarUploading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authHeaders, toast]);

  // ── Save ────────────────────────────────────────────────────────────────────
  const saveProfile = async () => {
    if (!form || !address) return;
    setSaving(true);
    try {
      let patchHeaders: Record<string, string> = { "Content-Type": "application/json" };
      let patchBody: Record<string, string | undefined>;

      const profileFields = {
        username:      form.username || undefined,
        bio:           form.bio || undefined,
        twitterHandle: form.twitterHandle.replace(/^@+/, "").trim() || undefined,
        websiteUrl:    sanitizeUrl(form.websiteUrl),
        avatarUrl:     form.avatarUrl || undefined,
      };

      if (wallet && !socialUser) {
        // ── Wallet-only path: sign a challenge (no social session) ─────────
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
        patchBody = { walletAddress: wallet, signature, message, ...profileFields };
      } else {
        // ── Social auth path: JWT Bearer token ────────────────────────────
        // Used for both: social-only users AND social users who also have a
        // wallet connected (wallet is only used for linking, not for signing
        // profile edits while a social session is active).
        patchHeaders = { ...patchHeaders, ...authHeaders() };
        patchBody = profileFields;
      }

      const res = await fetch(`/api/profiles/${address}`, {
        method: "PATCH",
        headers: patchHeaders,
        body: JSON.stringify(patchBody),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }

      const saved = await res.json() as { username?: string };
      const newUsername = saved.username ?? (profile?.username ?? "");

      // Invalidate profile queries and sync AuthContext so the navbar
      // reflects the new values immediately — delegated to performPostSave.
      await performPostSave({
        address,
        oldUsername:        profile?.username,
        hasSocialUser:      !!socialUser,
        invalidateQuery:    (key) => queryClient.invalidateQueries({ queryKey: key as string[] }),
        getQueryKey:        getGetProfileQueryKey,
        refreshSocialUser:  socialUser ? refreshSocialUser : undefined,
      });

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

  if (!open || !effectiveAddress) return null;

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
            ref={usernameInputRef}
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

        {/* Linked Wallet — only shown for social (Google/email) users */}
        {socialUser && (
          <div className="mb-6 p-3 rounded-sm border border-border/50 bg-background/50">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-2">
              <Wallet className="w-3 h-3" /> Linked Wallet
            </label>
            {socialUser.linkedWallet ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-foreground font-mono truncate">
                  {socialUser.linkedWallet.slice(0, 6)}…{socialUser.linkedWallet.slice(-4)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-muted-foreground hover:text-destructive rounded-sm shrink-0"
                  disabled={walletLinking}
                  onClick={async () => {
                    setWalletLinking(true);
                    try {
                      await unlinkWallet();
                      toast({ title: "Wallet unlinked", description: "Your wallet has been removed from your profile." });
                    } catch (e) {
                      const msg = e instanceof Error ? e.message : "Failed to unlink";
                      toast({ title: "Unlink failed", description: msg, variant: "destructive" });
                    } finally {
                      setWalletLinking(false);
                    }
                  }}
                >
                  {walletLinking
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <><Unlink className="w-3 h-3 mr-1" /> Disconnect</>}
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">No wallet linked</span>
                {wallet ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs rounded-sm shrink-0"
                    disabled={walletLinking}
                    onClick={async () => {
                      if (!wallet) return;
                      setWalletLinking(true);
                      try {
                        // 1. Get a server-issued challenge nonce
                        const { message: challengeMsg } = await getWalletLinkChallenge(wallet);
                        // 2. Sign the challenge with the connected wallet (proves ownership)
                        const msgBytes = new TextEncoder().encode(challengeMsg);
                        const sigRaw = await signMessage(msgBytes);
                        if (!(sigRaw instanceof Uint8Array) || sigRaw.length !== 64) {
                          throw new Error("Wallet returned an invalid signature — please try again");
                        }
                        const signature = bs58Encode(sigRaw);
                        // 3. Submit to server for verification and persistence
                        await linkWallet(wallet, signature, challengeMsg);
                        toast({ title: "Wallet linked", description: "Your wallet is now linked to your profile." });
                      } catch (e) {
                        const msg = e instanceof Error ? e.message : "Failed to link wallet";
                        toast({ title: "Link failed", description: msg, variant: "destructive" });
                      } finally {
                        setWalletLinking(false);
                      }
                    }}
                  >
                    {walletLinking
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <><Wallet className="w-3 h-3 mr-1" /> Link connected wallet</>}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs rounded-sm shrink-0"
                    onClick={openWalletModal}
                  >
                    <Wallet className="w-3 h-3 mr-1" /> Connect wallet
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

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
