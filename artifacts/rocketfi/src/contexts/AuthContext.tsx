/**
 * AuthContext — manages social / email authentication (separate from wallet).
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
}

interface AuthContextValue {
  socialUser: SocialUser | null;
  isLoading: boolean;
  /** Sign in with Google credential (ID token from GSI) */
  signInWithGoogle: (credential: string) => Promise<void>;
  /** Send 6-digit OTP to email */
  sendEmailOTP: (email: string) => Promise<void>;
  /** Verify OTP and sign in */
  verifyEmailOTP: (email: string, code: string) => Promise<void>;
  /** Sign out social auth (wallet remains connected if it was) */
  signOut: () => void;
  /** Returns Authorization header object for API calls */
  authHeaders: () => Record<string, string>;
}

const AuthContext = createContext<AuthContextValue>({
  socialUser: null,
  isLoading: true,
  signInWithGoogle: async () => {},
  sendEmailOTP: async () => {},
  verifyEmailOTP: async () => {},
  signOut: () => {},
  authHeaders: () => ({}),
});

const STORAGE_KEY = "pumpi_auth_token";

function apiUrl(path: string) {
  return `${API_BASE}/api${path}`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [socialUser, setSocialUser] = useState<SocialUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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
          address:  p.address,
          username: p.username,
          avatarUrl: p.avatarUrl ?? null,
          email:    p.email ?? null,
          authType: data.authType,
        });
      })
      .catch(() => clearToken())
      .finally(() => setIsLoading(false));
  }, []);

  const handleAuthResponse = (data: { token: string; profile: { address: string; username: string; avatarUrl?: string | null; email?: string | null }; authType?: string }) => {
    storeToken(data.token);
    const p = data.profile;
    setSocialUser({
      address:  p.address,
      username: p.username,
      avatarUrl: p.avatarUrl ?? null,
      email:    p.email ?? null,
      authType: (data.authType ?? "google") as "google" | "email",
    });
  };

  const signInWithGoogle = useCallback(async (credential: string) => {
    const r = await fetch(apiUrl("/auth/google"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error ?? "Google sign-in failed");
    }
    const data = await r.json();
    handleAuthResponse({ ...data, authType: "google" });
  }, []);

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

  const signOut = useCallback(() => {
    clearToken();
    setSocialUser(null);
    // Fire-and-forget server logout
    fetch(apiUrl("/auth/logout"), { method: "POST" }).catch(() => {});
  }, []);

  return (
    <AuthContext.Provider
      value={{ socialUser, isLoading, signInWithGoogle, sendEmailOTP, verifyEmailOTP, signOut, authHeaders }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
