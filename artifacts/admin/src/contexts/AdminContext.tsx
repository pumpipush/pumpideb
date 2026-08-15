import React, { createContext, useContext, useEffect, useState } from 'react';
import { useLocation } from 'wouter';

interface AdminContextType {
  secret: string | null;
  setSecret: (s: string) => void;
  clearSecret: () => void;
  apiFetch: <T = any>(path: string, options?: RequestInit) => Promise<T>;
}

const AdminContext = createContext<AdminContextType | null>(null);

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const [secret, setSecretState] = useState<string | null>(() => {
    return localStorage.getItem('admin_secret');
  });
  const [, setLocation] = useLocation();

  const setSecret = (s: string) => {
    localStorage.setItem('admin_secret', s);
    setSecretState(s);
  };

  const clearSecret = () => {
    localStorage.removeItem('admin_secret');
    setSecretState(null);
    setLocation('/login');
  };

  const apiFetch = async <T = any,>(path: string, options: RequestInit = {}): Promise<T> => {
    if (!secret) {
      clearSecret();
      throw new Error('No admin secret');
    }

    const res = await fetch(`/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
        'X-Admin-Secret': secret,
      },
    });

    if (res.status === 401) {
      clearSecret();
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown Error');
      throw new Error(`API Error ${res.status}: ${errText}`);
    }

    return res.json() as Promise<T>;
  };

  return (
    <AdminContext.Provider value={{ secret, setSecret, clearSecret, apiFetch }}>
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin() {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('useAdmin must be used within AdminProvider');
  return ctx;
}
