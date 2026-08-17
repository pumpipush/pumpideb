/**
 * AuthContext — manages social / email authentication (separate from wallet).
 *
 * Google login will be added later via a separate integration.
 *
 * A user can be in any of these states:
 *   - Not signed in (socialUser = null, wallet = null)
 *   - Signed in via email OTP (socialUser set, wallet may be null)
 *   - Wallet connected (WalletContext, socialUser may be null)
 *   - Both (social auth + wallet connected)
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { applyMeResponse } from "@/lib/profileDisplayUtils";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface SocialUser {
  address: string;
  username: string;
  avatarUrl: string | null;
  email: string | null;
  authType: "google" | "email" | "wallet";
  linkedWallet: string | null;
}

interface AuthContextValue {
  socialUser: SocialUser | null;
  isLoading: boolean;
  /**
   * Exchange a Google OAuth access_token (from useGoogleLogin implicit flow) for our own JWT.
   * Returns outcome flags so callers can show appropriate messaging.
   */
  handleGoogleToken: (accessToken: string) => Promise<{ isNewAccount: boolean; wasLinked: boolean }>;
  /** Sign out social auth (wallet remains connected if it was) */
  signOut: () => void;
  /** Returns Authorization header object for API calls */
  authHeaders: () => Record<string, string>;
  /**
   * Re-fetch the current user's profile from /api/auth/me and sync socialUser
   * state. Call this after any profile edit so that username/avatarUrl shown
   * in the navbar and elsewhere are immediately up-to-date.
   */
  refreshSocialUser: () => Promise<void>;
  /**
   * Issue a server nonce the wallet must sign before linking.
   * Returns { nonce, message } — client signs `message` with the wallet, then
   * passes the result to linkWallet().
   */
  getWalletLinkChallenge: (walletAddress: string) => Promise<{ nonce: string; message: string }>;
  /**
   * Persist a linked wallet after the user has signed the challenge.
   * Requires proof-of-ownership: walletAddress + Ed25519 signature + original message.
   */
  /** Returns { mergeNonce } when the wallet is already a primary account — call mergeWallet to finish. */
  linkWallet: (walletAddress: string, signature: string, message: string) => Promise<{ mergeNonce: string } | undefined>;
  /** Remove the linked wallet from this social account */
  unlinkWallet: () => Promise<void>;
  /** Merge a wallet-primary account into this social account using the nonce from linkWallet. */
  mergeWallet: (mergeNonce: string) => Promise<void>;
  /**
   * Authenticate a wallet-only user: fetches a challenge, signs it with the
   * wallet's private key, and exchanges the signature for a JWT.
   * signMessage must be the wallet adapter's `signMessage` method.
   */
  loginWithWallet: (
    walletAddress: string,
    signMessage: (msg: Uint8Array) => Promise<Uint8Array>,
  ) => Promise<void>;
  /**
   * (Wallet-auth only) Send an OTP to the given email address so the user can
   * link it to their wallet profile. Throws if the email is already taken.
   */
  linkEmailSend: (email: string) => Promise<void>;
  /**
   * (Wallet-auth only) Verify the OTP sent by linkEmailSend and save the email
   * to the profile. Resolves on success, throws on wrong/expired code.
   */
  linkEmailVerify: (email: string, code: string) => Promise<void>;
  /**
   * (Wallet-auth only) Exchange a Google access_token for a linked Google
   * identity on the current wallet profile. Throws if the Google account is
   * already claimed by another profile.
   */
  linkGoogle: (accessToken: string) => Promise<void>;
  /**
   * Smart wallet connect — call this after the wallet extension approves
   * the connection.  Automatically decides:
   *   • Already signed in (Google JWT present) → links the wallet to the
   *     existing social profile via /auth/wallet/link (no new row created).
   *     Returns { mergeNonce } if the wallet already has its own primary account
   *     — the caller must show a merge confirmation and call mergeWallet().
   *   • Not signed in → creates / retrieves a wallet-primary profile and issues
   *     a JWT via /auth/wallet/login.
   * This prevents the duplicate-profile scenario where one person ends up with
   * both a UUID-addressed Google row and a separate wallet-address row.
   */
  loginOrLinkWallet: (
    walletAddress: string,
    signMessage: (msg: Uint8Array) => Promise<Uint8Array>,
  ) => Promise<{ mergeNonce: string } | undefined>;
}

const AuthContext = createContext<AuthContextValue>({
  socialUser: null,
  isLoading: true,
  handleGoogleToken: async () => ({ isNewAccount: false, wasLinked: false }),
  signOut: () => {},
  authHeaders: () => ({}),
  refreshSocialUser: async () => {},
  getWalletLinkChallenge: async () => ({ nonce: "", message: "" }),
  linkWallet: async () => undefined,
  unlinkWallet: async () => {},
  mergeWallet: async () => {},
  loginWithWallet: async () => {},
  loginOrLinkWallet: async () => undefined,
  linkEmailSend: async () => {},
  linkEmailVerify: async () => {},
  linkGoogle: async () => {},
});

const STORAGE_KEY = "pumpi_auth_token";

function apiUrl(path: string) {
  return `${API_BASE}/api${path}`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [socialUser, setSocialUser] = useState<SocialUser | null>(null);
  const [isLoading, setIsLoading]   = useState(true);

  const storeToken = (token: string) => localStorage.setItem(STORAGE_KEY, token);
  const getToken   = ()             => localStorage.getItem(STORAGE_KEY);
  const clearToken = ()             => localStorage.removeItem(STORAGE_KEY);

  const authHeaders = useCallback((): Record<string, string> => {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }, []);

  // Listen for wallet account changes dispatched by WalletContext.
  // When the user switches accounts in their wallet extension, any wallet-based
  // JWT is now invalid for the new address. Clear the session so they re-auth.
  useEffect(() => {
    const handleWalletAccountChanged = () => {
      const token = getToken();
      if (!token) return;

      // Snapshot the token value at event time.  If the token changes before
      // the response arrives (user logged in with a new account) we must not
      // clear the new valid session — compare on response arrival.
      const tokenAtEventTime = token;

      fetch(apiUrl("/auth/me"), { headers: { Authorization: `Bearer ${token}` } })
        .then(r => {
          // Bail out if a newer auth event has already replaced the token.
          if (getToken() !== tokenAtEventTime) return;

          if (r.status === 401) {
            clearToken();
            setSocialUser(null);
          } else if (!r.ok) {
            // Non-401 server or network failure — log a warning but leave the
            // session intact; a transient 5xx should not silently sign the user out.
            console.warn(`[AuthContext] wallet-change validation got ${r.status} — keeping session`);
          }
        })
        .catch((err) => {
          // Network failure: log but preserve session — do not silently swallow.
          console.warn("[AuthContext] wallet-change validation failed (network):", err);
        });
    };
    window.addEventListener("walletAccountChanged", handleWalletAccountChanged);
    return () => window.removeEventListener("walletAccountChanged", handleWalletAccountChanged);
  }, []);

  // On mount: restore session from localStorage.
  // An AbortController cancels the in-flight request if the component unmounts
  // before it completes, preventing stale responses from updating auth state.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const token = getToken();
    if (!token) { setIsLoading(false); return; }

    fetch(apiUrl("/auth/me"), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => {
        if (cancelled) return; // superseded by unmount or a newer auth event
        const p = data.profile;
        setSocialUser({
          address:      p.address,
          username:     p.username,
          avatarUrl:    p.avatarUrl ?? null,
          email:        p.email ?? null,
          authType:     data.authType as "google" | "email" | "wallet",
          linkedWallet: p.linkedWallet ?? null,
        });
      })
      .catch((err) => {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
        clearToken();
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const handleAuthResponse = (data: {
    token: string;
    profile: {
      address: string;
      username: string;
      avatarUrl?: string | null;
      email?: string | null;
      linkedWallet?: string | null;
    };
    authType?: string;
  }) => {
    storeToken(data.token);
    const p = data.profile;
    setSocialUser({
      address:      p.address,
      username:     p.username,
      avatarUrl:    p.avatarUrl ?? null,
      email:        p.email ?? null,
      authType:     (data.authType ?? "email") as "google" | "email" | "wallet",
      linkedWallet: p.linkedWallet ?? null,
    });
  };

  // ── Google OAuth ──────────────────────────────────────────────────────────
  // Accepts a Google OAuth access_token from useGoogleLogin (implicit flow).
  // Backend calls Google's userinfo endpoint to verify it and issues our JWT.
  const handleGoogleToken = useCallback(async (accessToken: string): Promise<{ isNewAccount: boolean; wasLinked: boolean }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000); // 15 s timeout
    try {
      const r = await fetch(apiUrl("/auth/google"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: accessToken }),
        signal: controller.signal,
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Google sign-in failed");
      }
      const data = await r.json() as {
        token: string;
        profile: { address: string; username: string; avatarUrl?: string | null; email?: string | null; linkedWallet?: string | null };
        isNewAccount?: boolean;
        wasLinked?: boolean;
      };
      handleAuthResponse({ ...data, authType: "google" });
      return {
        isNewAccount: data.isNewAccount ?? false,
        wasLinked:    data.wasLinked    ?? false,
      };
    } catch (e) {
      if ((e as Error).name === "AbortError") throw new Error("Google sign-in timed out — please try again");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }, []);

  // ── Sign out ───────────────────────────────────────────────────────────────
  const signOut = useCallback(() => {
    clearToken();
    setSocialUser(null);
    // Fire-and-forget server logout
    fetch(apiUrl("/auth/logout"), { method: "POST" }).catch(() => {});
  }, []);

  // ── Refresh social user ───────────────────────────────────────────────────
  // Re-fetches the current user's profile from /api/auth/me and syncs the
  // socialUser state. Call after any profile edit to keep username/avatarUrl
  // in sync without requiring a full page reload.
  const refreshSocialUser = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const r = await fetch(apiUrl("/auth/me"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      // Fix #5 — JWT expired: clear session instead of silently keeping stale state.
      // Without this, the app looks authenticated but every action fails with 401
      // until the user manually reloads or signs out.
      if (r.status === 401) {
        clearToken();
        setSocialUser(null);
        return;
      }
      if (!r.ok) return;
      const data = await r.json() as { profile: { address: string; username: string; avatarUrl?: string | null; email?: string | null; linkedWallet?: string | null }; authType: string };
      setSocialUser((u) => u ? applyMeResponse(u, data) : u);
    } catch {
      // Ignore network errors — UI will remain on stale data until next load
    }
  }, []);

  // ── Wallet linking ─────────────────────────────────────────────────────────
  const getWalletLinkChallenge = useCallback(async (walletAddress: string): Promise<{ nonce: string; message: string }> => {
    const headers = authHeaders();
    if (!headers.Authorization) throw new Error("Not signed in");
    const r = await fetch(apiUrl(`/auth/wallet/link/challenge?wallet=${encodeURIComponent(walletAddress)}`), {
      headers,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? "Failed to get wallet link challenge");
    }
    return r.json() as Promise<{ nonce: string; message: string }>;
  }, [authHeaders]);

  /** Returns { mergeNonce } when the wallet is already a primary account (user must confirm merge). */
  const linkWallet = useCallback(async (
    walletAddress: string, signature: string, message: string,
  ): Promise<{ mergeNonce: string } | undefined> => {
    const headers = authHeaders();
    if (!headers.Authorization) throw new Error("Not signed in");
    const r = await fetch(apiUrl("/auth/wallet/link"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ walletAddress, signature, message }),
    });
    if (r.status === 409) {
      const body = await r.json().catch(() => ({})) as { error?: string; mergeNonce?: string };
      if (body.error === "wallet_is_primary_account" && body.mergeNonce) {
        return { mergeNonce: body.mergeNonce };
      }
      throw new Error(body.error ?? "Wallet already in use");
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? "Failed to link wallet");
    }
    const data = await r.json() as { profile: { linkedWallet?: string | null } };
    setSocialUser((u) => u ? { ...u, linkedWallet: data.profile.linkedWallet ?? null } : u);
    return undefined;
  }, [authHeaders]);

  const mergeWallet = useCallback(async (mergeNonce: string) => {
    const headers = authHeaders();
    if (!headers.Authorization) throw new Error("Not signed in");
    const r = await fetch(apiUrl("/auth/wallet/merge"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ mergeNonce }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? "Failed to merge accounts");
    }
    const data = await r.json() as { profile: { linkedWallet?: string | null } };
    setSocialUser((u) => u ? { ...u, linkedWallet: data.profile.linkedWallet ?? null } : u);
  }, [authHeaders]);

  const unlinkWallet = useCallback(async () => {
    const headers = authHeaders();
    if (!headers.Authorization) throw new Error("Not signed in");
    const r = await fetch(apiUrl("/auth/wallet/link"), {
      method: "DELETE",
      headers,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? "Failed to unlink wallet");
    }
    setSocialUser((u) => u ? { ...u, linkedWallet: null } : u);
  }, [authHeaders]);

  // ── Wallet → email/Google linking ────────────────────────────────────────

  const linkEmailSend = useCallback(async (email: string) => {
    const headers = authHeaders();
    if (!headers.Authorization) throw new Error("Not signed in");
    const r = await fetch(apiUrl("/auth/link/email/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ email }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? "Failed to send verification code");
    }
  }, [authHeaders]);

  const linkEmailVerify = useCallback(async (email: string, code: string) => {
    const headers = authHeaders();
    if (!headers.Authorization) throw new Error("Not signed in");
    const r = await fetch(apiUrl("/auth/link/email/verify"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ email, code }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? "Invalid or expired code");
    }
    // Sync the new email into local state so the UI updates immediately
    setSocialUser((u) => u ? { ...u, email: email.toLowerCase() } : u);
  }, [authHeaders]);

  const linkGoogle = useCallback(async (accessToken: string) => {
    const headers = authHeaders();
    if (!headers.Authorization) throw new Error("Not signed in");
    const r = await fetch(apiUrl("/auth/link/google"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? "Failed to link Google account");
    }
    const data = await r.json() as { profile: { email?: string | null; avatarUrl?: string | null } };
    setSocialUser((u) => u
      ? { ...u, email: data.profile.email ?? u.email, avatarUrl: data.profile.avatarUrl ?? u.avatarUrl }
      : u);
  }, [authHeaders]);

  // ── Shared base58 encoder (used by both login and link flows) ─────────────
  function encodeBase58(sigBytes: Uint8Array): string {
    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n;
    for (const byte of sigBytes) n = n * 256n + BigInt(byte);
    const chars: string[] = [];
    while (n > 0n) { chars.unshift(B58[Number(n % 58n)]); n /= 58n; }
    let leading = 0;
    for (const byte of sigBytes) { if (byte !== 0) break; leading++; }
    return "1".repeat(leading) + chars.join("");
  }

  // ── Wallet-only login ─────────────────────────────────────────────────────
  // Fetches a one-time challenge, has the wallet sign it, then exchanges the
  // signature for a JWT — giving wallet-only users the same auth capabilities
  // (deposits, balance, etc.) as social users without requiring Google/email.
  const loginWithWallet = useCallback(async (
    walletAddress: string,
    signMessage: (msg: Uint8Array) => Promise<Uint8Array>,
  ) => {
    // 1. Get challenge
    const cr = await fetch(apiUrl(`/auth/wallet/login/challenge?wallet=${encodeURIComponent(walletAddress)}`));
    if (!cr.ok) {
      const e = await cr.json().catch(() => ({})) as { error?: string };
      throw new Error(e.error ?? "Failed to get login challenge");
    }
    const { message } = await cr.json() as { nonce: string; message: string };

    // 2. Sign with the wallet (Ed25519 over UTF-8 encoded message)
    const sigBytes = await signMessage(new TextEncoder().encode(message));

    // 3. Base58-encode the raw 64-byte signature
    const signature = encodeBase58(sigBytes);

    // 4. Exchange for JWT
    const lr = await fetch(apiUrl("/auth/wallet/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress, signature, message }),
    });
    if (!lr.ok) {
      const e = await lr.json().catch(() => ({})) as { error?: string };
      throw new Error(e.error ?? "Wallet login failed");
    }
    const data = await lr.json() as {
      token: string;
      profile: { address: string; username: string; avatarUrl?: string | null; email?: string | null; linkedWallet?: string | null };
      authType?: "google" | "email" | "wallet";
    };
    storeToken(data.token);
    const p = data.profile;
    // The server may resolve this wallet to a social profile (post-merge case:
    // wallet-primary row was deleted but identity lives under a Google/email row).
    // Use the authType from the JWT's sub claim via /auth/me rather than hardcoding
    // "wallet" — decode it from the response if present, otherwise default to "wallet".
    const resolvedAuthType = (data.authType ?? "wallet") as "google" | "email" | "wallet";
    setSocialUser({
      address:      p.address,
      username:     p.username,
      avatarUrl:    p.avatarUrl ?? null,
      email:        p.email ?? null,
      authType:     resolvedAuthType,
      linkedWallet: p.linkedWallet ?? null,
    });
  }, []);

  /**
   * Smart connect: if a social JWT is already present, link the wallet to the
   * existing profile. Otherwise, create / retrieve a wallet-primary profile.
   * This prevents duplicate profile rows when a Google/email user also connects
   * a wallet extension.
   */
  const loginOrLinkWallet = useCallback(async (
    walletAddress: string,
    signMessage: (msg: Uint8Array) => Promise<Uint8Array>,
  ): Promise<{ mergeNonce: string } | undefined> => {
    const token = getToken();

    if (token) {
      // ── Already signed in → link wallet to existing social profile ──────
      // Uses /auth/wallet/link/challenge + /auth/wallet/link (no new row).
      // Returns { mergeNonce } if the wallet already has its own primary account.
      const cr = await fetch(apiUrl(`/auth/wallet/link/challenge?wallet=${encodeURIComponent(walletAddress)}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!cr.ok) {
        const e = await cr.json().catch(() => ({})) as { error?: string };
        throw new Error(e.error ?? "Failed to get wallet link challenge");
      }
      const { message } = await cr.json() as { nonce: string; message: string };
      const sigBytes  = await signMessage(new TextEncoder().encode(message));
      const signature = encodeBase58(sigBytes);
      return await linkWallet(walletAddress, signature, message);
    } else {
      // ── Not signed in → create / retrieve wallet profile and issue JWT ──
      await loginWithWallet(walletAddress, signMessage);
      return undefined;
    }
  }, [linkWallet, loginWithWallet]);

  return (
    <AuthContext.Provider
      value={{
        socialUser,
        isLoading,
        handleGoogleToken,
        signOut,
        authHeaders,
        refreshSocialUser,
        getWalletLinkChallenge,
        linkWallet,
        unlinkWallet,
        mergeWallet,
        loginWithWallet,
        loginOrLinkWallet,
        linkEmailSend,
        linkEmailVerify,
        linkGoogle,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
