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

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface SocialUser {
  address: string;
  username: string;
  avatarUrl: string | null;
  email: string | null;
  authType: "google" | "email";
  linkedWallet: string | null;
}

interface AuthContextValue {
  socialUser: SocialUser | null;
  isLoading: boolean;
  /** Send 6-digit OTP to email */
  sendEmailOTP: (email: string) => Promise<void>;
  /** Verify OTP and sign in */
  verifyEmailOTP: (email: string, code: string) => Promise<void>;
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
  linkWallet: (walletAddress: string, signature: string, message: string) => Promise<void>;
  /** Remove the linked wallet from this social account */
  unlinkWallet: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  socialUser: null,
  isLoading: true,
  sendEmailOTP: async () => {},
  verifyEmailOTP: async () => {},
  handleGoogleToken: async () => ({ isNewAccount: false, wasLinked: false }),
  signOut: () => {},
  authHeaders: () => ({}),
  refreshSocialUser: async () => {},
  getWalletLinkChallenge: async () => ({ nonce: "", message: "" }),
  linkWallet: async () => {},
  unlinkWallet: async () => {},
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

  // On mount: restore session from localStorage
  useEffect(() => {
    const token = getToken();
    if (!token) { setIsLoading(false); return; }

    fetch(apiUrl("/auth/me"), {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => {
        const p = data.profile;
        setSocialUser({
          address:      p.address,
          username:     p.username,
          avatarUrl:    p.avatarUrl ?? null,
          email:        p.email ?? null,
          authType:     data.authType,
          linkedWallet: p.linkedWallet ?? null,
        });
      })
      .catch(() => clearToken())
      .finally(() => setIsLoading(false));
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
      authType:     (data.authType ?? "email") as "google" | "email",
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

  // ── Email OTP ──────────────────────────────────────────────────────────────
  const sendEmailOTP = useCallback(async (email: string) => {
    const r = await fetch(apiUrl("/auth/email/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error ?? "Failed to send code");
    }
  }, []);

  const verifyEmailOTP = useCallback(async (email: string, code: string) => {
    const r = await fetch(apiUrl("/auth/email/verify"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error ?? "Invalid code");
    }
    const data = await r.json();
    handleAuthResponse({ ...data, authType: "email" });
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
      if (!r.ok) return;
      const data = await r.json() as { profile: { address: string; username: string; avatarUrl?: string | null; email?: string | null; linkedWallet?: string | null }; authType: string };
      const p = data.profile;
      setSocialUser((u) => u ? {
        ...u,
        username:     p.username,
        avatarUrl:    p.avatarUrl ?? null,
        linkedWallet: p.linkedWallet ?? null,
      } : u);
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

  const linkWallet = useCallback(async (walletAddress: string, signature: string, message: string) => {
    const headers = authHeaders();
    if (!headers.Authorization) throw new Error("Not signed in");
    const r = await fetch(apiUrl("/auth/wallet/link"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ walletAddress, signature, message }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? "Failed to link wallet");
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

  return (
    <AuthContext.Provider
      value={{
        socialUser,
        isLoading,
        sendEmailOTP,
        verifyEmailOTP,
        handleGoogleToken,
        signOut,
        authHeaders,
        refreshSocialUser,
        getWalletLinkChallenge,
        linkWallet,
        unlinkWallet,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
