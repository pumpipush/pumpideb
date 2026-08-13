/**
 * AuthContext — manages social / email authentication (separate from wallet).
 *
 * Google login is handled via Privy (privy.io). After Privy authenticates the
 * user, this context exchanges the Privy access token for our own JWT via
 * POST /api/auth/privy, then stores the JWT in localStorage as before.
 *
 * A user can be in any of these states:
 *   - Not signed in (socialUser = null, wallet = null)
 *   - Signed in via Google/email (socialUser set, wallet may be null)
 *   - Wallet connected (WalletContext, socialUser may be null)
 *   - Both (social auth + wallet connected)
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { usePrivy } from "@privy-io/react-auth";

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
  /** Trigger Privy Google login overlay */
  loginWithGoogle: () => void;
  /** Send 6-digit OTP to email */
  sendEmailOTP: (email: string) => Promise<void>;
  /** Verify OTP and sign in */
  verifyEmailOTP: (email: string, code: string) => Promise<void>;
  /** Sign out social auth (wallet remains connected if it was) */
  signOut: () => void;
  /** Returns Authorization header object for API calls */
  authHeaders: () => Record<string, string>;
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
  loginWithGoogle: () => {},
  sendEmailOTP: async () => {},
  verifyEmailOTP: async () => {},
  signOut: () => {},
  authHeaders: () => ({}),
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

  // Privy hooks (AuthProvider is inside PrivyProvider in App.tsx)
  const {
    login: privyLogin,
    logout: privyLogout,
    authenticated,
    user: privyUser,
    getAccessToken,
  } = usePrivy();

  // Tracks which Privy user ID we've already exchanged for our JWT so we
  // don't hit the backend on every re-render or token refresh.
  const privyExchangedRef = useRef<string | null>(null);

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

  // ── Privy → our JWT bridge ─────────────────────────────────────────────────
  // When Privy authenticates a user (e.g. after Google login) and we don't
  // already have our own session, exchange the Privy access token for our JWT.
  useEffect(() => {
    if (isLoading) return;                                  // wait for session restore
    if (!authenticated || !privyUser) {
      privyExchangedRef.current = null;                     // reset on logout
      return;
    }
    if (socialUser) {
      privyExchangedRef.current = privyUser.id;             // already have a session
      return;
    }
    if (privyExchangedRef.current === privyUser.id) return; // already exchanged

    privyExchangedRef.current = privyUser.id;

    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const r = await fetch(apiUrl("/auth/privy"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          console.error("[auth] Privy exchange failed:", err);
          privyExchangedRef.current = null;
          return;
        }
        const data = await r.json();
        handleAuthResponse({ ...data, authType: "google" });
      } catch (e) {
        console.error("[auth] Privy token exchange error:", e);
        privyExchangedRef.current = null;
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, privyUser, socialUser, isLoading]);

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
      authType:     (data.authType ?? "google") as "google" | "email",
      linkedWallet: p.linkedWallet ?? null,
    });
  };

  // ── Google via Privy ───────────────────────────────────────────────────────
  // Privy is configured with loginMethods: ['google'] in PrivyProvider,
  // so calling login() without arguments shows only Google as an option.
  const loginWithGoogle = useCallback(() => {
    privyLogin();
  }, [privyLogin]);

  // ── Email OTP ──────────────────────────────────────────────────────────────
  const sendEmailOTP = useCallback(async (email: string) => {
    const r = await fetch(apiUrl("/auth/email/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error ?? "Failed to send code");
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
      throw new Error(err.error ?? "Invalid code");
    }
    const data = await r.json();
    handleAuthResponse({ ...data, authType: "email" });
  }, []);

  // ── Sign out ───────────────────────────────────────────────────────────────
  const signOut = useCallback(() => {
    clearToken();
    setSocialUser(null);
    privyExchangedRef.current = null;
    // Sign out from Privy (clears their session cookie / storage)
    privyLogout().catch(() => {});
    // Fire-and-forget server logout
    fetch(apiUrl("/auth/logout"), { method: "POST" }).catch(() => {});
  }, [privyLogout]);

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
        loginWithGoogle,
        sendEmailOTP,
        verifyEmailOTP,
        signOut,
        authHeaders,
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
