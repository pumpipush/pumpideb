/**
 * AuthContext — session management for Pumpi Mobile.
 *
 * Token is persisted in expo-secure-store (encrypted on-device storage).
 * On mount, restores the session by reading the stored token and verifying
 * it against /api/auth/me. If the token is expired or invalid, it is cleared
 * and the user is sent to the sign-in screen.
 *
 * Exposed methods:
 *   sendEmailOTP(email)            — request a 6-digit code via email
 *   verifyEmailOTP(email, code)    — verify code → receive JWT + profile
 *   signInWithGoogle(accessToken)  — exchange a Google access_token for JWT
 *   signOut()                      — clear stored token and reset state
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';

// ── Constants ──────────────────────────────────────────────────────────────

const TOKEN_KEY = 'pumpi_auth_token';
const API_BASE = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

// ── Types ──────────────────────────────────────────────────────────────────

export interface UserProfile {
  address: string;
  username: string;
  email?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  authType?: string | null;
}

interface AuthContextValue {
  user: UserProfile | null;
  token: string | null;
  isLoading: boolean;
  sendEmailOTP: (email: string) => Promise<void>;
  verifyEmailOTP: (email: string, code: string) => Promise<{ isNewAccount: boolean }>;
  signInWithGoogle: (accessToken: string) => Promise<{ isNewAccount: boolean; wasLinked: boolean }>;
  signOut: () => Promise<void>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function apiFetch(
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error((data as Record<string, string>).error ?? `HTTP ${res.status}`);
  return data;
}

// ── Context ────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue>({
  user: null,
  token: null,
  isLoading: true,
  sendEmailOTP: async () => {},
  verifyEmailOTP: async () => ({ isNewAccount: false }),
  signInWithGoogle: async () => ({ isNewAccount: false, wasLinked: false }),
  signOut: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

// ── Provider ───────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  /** Persist token + update state. */
  const saveSession = useCallback(async (newToken: string, profile: UserProfile) => {
    await SecureStore.setItemAsync(TOKEN_KEY, newToken);
    setToken(newToken);
    setUser(profile);
  }, []);

  /** Restore session from SecureStore on app launch. */
  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(TOKEN_KEY);
        if (stored) {
          const profile = await apiFetch('/api/auth/me', {}, stored) as UserProfile;
          setToken(stored);
          setUser(profile);
        }
      } catch {
        // Token invalid or expired — delete it so the user sees the sign-in screen.
        await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const sendEmailOTP = useCallback(async (email: string) => {
    await apiFetch('/api/auth/email/send', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }, []);

  const verifyEmailOTP = useCallback(async (email: string, code: string) => {
    const data = await apiFetch('/api/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }) as { token: string; profile: UserProfile; isNewAccount: boolean };
    await saveSession(data.token, data.profile);
    return { isNewAccount: data.isNewAccount };
  }, [saveSession]);

  const signInWithGoogle = useCallback(async (accessToken: string) => {
    const data = await apiFetch('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ access_token: accessToken }),
    }) as { token: string; profile: UserProfile; isNewAccount: boolean; wasLinked: boolean };
    await saveSession(data.token, data.profile);
    return { isNewAccount: data.isNewAccount, wasLinked: data.wasLinked ?? false };
  }, [saveSession]);

  const signOut = useCallback(async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, sendEmailOTP, verifyEmailOTP, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
