import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { useCreateProfile } from "@workspace/api-client-react";

interface WalletContextValue {
  wallet: string | null;
  connect: (address: string) => void;
  disconnect: () => void;
}

const WalletContext = createContext<WalletContextValue>({
  wallet: null,
  connect: () => {},
  disconnect: () => {},
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<string | null>(null);
  const createProfile = useCreateProfile();

  const connect = useCallback(
    (address: string) => {
      setWallet(address);
      // Auto-create profile when wallet connects (idempotent — backend upserts)
      // Bug fix: profile creation failure is non-blocking; wallet is still connected
      createProfile.mutate({ data: { address } }, {
        onError: (err) => {
          console.warn("[WalletContext] profile upsert failed (non-fatal):", err);
        },
      });
    },
    [createProfile]
  );

  const disconnect = useCallback(() => setWallet(null), []);

  return (
    <WalletContext.Provider value={{ wallet, connect, disconnect }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
