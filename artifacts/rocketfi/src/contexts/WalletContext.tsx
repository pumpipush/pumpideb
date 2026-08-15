/**
 * WalletContext — central wallet state for the app.
 *
 * Bridges the window-injected Solana wallet APIs (Phantom, Backpack, Solflare)
 * with React. Consumers get a plain base58 address string and helpers to
 * connect/disconnect without needing to know which wallet is active.
 *
 * Usage:
 *   const { wallet, walletName, connectWallet, disconnect, openWalletModal } = useWallet();
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";

/** Union of legacy and versioned transactions — accepted by all three wallet methods. */
type AnyTransaction = Transaction | VersionedTransaction;
import type { SolanaProvider, WalletName } from "@/lib/solana";
import { WALLET_DESCRIPTORS } from "@/lib/solana";
import { WalletSelectModal } from "@/components/shared/WalletSelectModal";

const STORAGE_KEY = "pumpi_last_wallet";

interface WalletContextValue {
  /** Base58-encoded Solana public key, or null if not connected */
  wallet: string | null;
  /** Human-readable wallet name ("Phantom", "Backpack", "Solflare"), or null */
  walletName: WalletName | null;
  /** True while a wallet is connected */
  connected: boolean;
  /**
   * Connect using a specific provider (returned by WALLET_DESCRIPTORS[n].getProvider()).
   * Resolves with the base58 address on success.
   */
  connectWallet: (provider: SolanaProvider, name: WalletName) => Promise<string>;
  /** Disconnect from the current wallet */
  disconnect: () => Promise<void>;
  /** Open the Connect Wallet modal from anywhere in the app */
  openWalletModal: () => void;
  /**
   * Sign a legacy Transaction WITHOUT sending it.
   *
   * Use when the transaction also needs additional local signers (e.g. a mint
   * Keypair for token creation): sign with the wallet first, then call
   * tx.partialSign(...localSigners), then send via
   * connection.sendRawTransaction(tx.serialize()).
   *
   * Throws if no wallet is connected or the wallet does not support signTransaction.
   * Note: VersionedTransaction uses a different signing model — use signAndSendTransaction
   * for those (e.g. Jupiter swaps that return VersionedTransaction).
   */
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
  /**
   * Sign a VersionedTransaction WITHOUT sending it.
   *
   * Use for pump.fun / pumpportal trades where we want to submit the transaction
   * ourselves via a reliable RPC (Alchemy) with retries, rather than delegating
   * submission to the wallet's own default endpoint.
   *
   * Returns the same VersionedTransaction with the user's signature filled in.
   * Throws if no wallet is connected or the wallet doesn't support signTransaction.
   */
  signVersionedTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
  /**
   * Sign a Transaction or VersionedTransaction and send it via the wallet's RPC
   * node in one step. The transaction must have blockhash + feePayer set.
   *
   * Accepts both legacy Transaction (pump.fun launches) and VersionedTransaction
   * (Jupiter swaps, v0 messages). Throws if no wallet is connected.
   * Returns the base58 transaction signature on success.
   */
  signAndSendTransaction: (transaction: AnyTransaction) => Promise<string>;
  /**
   * Sign an arbitrary message with the connected wallet's private key (Ed25519).
   * Returns the raw 64-byte signature as a Uint8Array.
   * Throws if no wallet is connected or the wallet doesn't support signMessage.
   */
  signMessage: (messageBytes: Uint8Array) => Promise<Uint8Array>;
}

const WalletContext = createContext<WalletContextValue>({
  wallet: null,
  walletName: null,
  connected: false,
  connectWallet: async () => { throw new Error("WalletContext not mounted"); },
  disconnect: async () => {},
  openWalletModal: () => {},
  signTransaction: async () => { throw new Error("WalletContext not mounted"); },
  signVersionedTransaction: async () => { throw new Error("WalletContext not mounted"); },
  signAndSendTransaction: async () => { throw new Error("WalletContext not mounted"); },
  signMessage: async () => { throw new Error("WalletContext not mounted"); },
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet]         = useState<string | null>(null);
  const [walletName, setWalletName] = useState<WalletName | null>(null);
  const [modalOpen, setModalOpen]   = useState(false);
  const providerRef = useRef<SolanaProvider | null>(null);

  // ── Listen for wallet events (disconnect, account change) ─────────────────

  const handleDisconnect = useCallback(() => {
    setWallet(null);
    setWalletName(null);
    providerRef.current = null;
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const handleAccountChanged = useCallback((publicKey: unknown) => {
    if (publicKey && typeof publicKey === "object" && "toBase58" in publicKey) {
      const addr = (publicKey as { toBase58(): string }).toBase58();
      setWallet(addr);
    } else {
      // Wallet locked or account removed
      handleDisconnect();
    }
  }, [handleDisconnect]);

  // ── Connect ───────────────────────────────────────────────────────────────

  const connectWallet = useCallback(async (
    provider: SolanaProvider,
    name: WalletName
  ): Promise<string> => {
    const result = await provider.connect();
    // Solflare returns undefined/void from connect() — public key lives on
    // provider.publicKey directly. Phantom/Backpack return it in the result object.
    const publicKey = (result as { publicKey?: { toBase58(): string } } | undefined)?.publicKey
      ?? provider.publicKey;
    if (!publicKey) throw new Error("Wallet connected but no public key available");
    const address = publicKey.toBase58();

    // Clean up old provider listeners before switching
    if (providerRef.current && providerRef.current !== provider) {
      try {
        providerRef.current.off("disconnect", handleDisconnect);
        providerRef.current.off("accountChanged", handleAccountChanged);
      } catch { /* ignore */ }
    }

    // Attach listeners on the new provider
    try {
      provider.on("disconnect", handleDisconnect);
      provider.on("accountChanged", handleAccountChanged);
    } catch { /* some wallets may not support all events */ }

    providerRef.current = provider;
    setWallet(address);
    setWalletName(name);

    // Persist wallet choice so we can silently reconnect on next load
    localStorage.setItem(STORAGE_KEY, name);

    return address;
  }, [handleDisconnect, handleAccountChanged]);

  // ── Disconnect ────────────────────────────────────────────────────────────

  const disconnect = useCallback(async () => {
    if (providerRef.current) {
      try {
        providerRef.current.off("disconnect", handleDisconnect);
        providerRef.current.off("accountChanged", handleAccountChanged);
        await providerRef.current.disconnect();
      } catch { /* ignore errors on disconnect */ }
    }
    setWallet(null);
    setWalletName(null);
    providerRef.current = null;
    localStorage.removeItem(STORAGE_KEY);
  }, [handleDisconnect, handleAccountChanged]);

  // ── Auto-reconnect on mount ───────────────────────────────────────────────
  // If the user previously connected a wallet, silently reconnect without
  // showing any popup.
  //
  // Strategy:
  //   1. If provider.publicKey is already set the wallet is unlocked and the
  //      site is trusted — grab the address directly, no connect() call needed.
  //   2. Otherwise call connect({ onlyIfTrusted: true }) ONLY for
  //      Phantom/Backpack, which handle this silently (reject without popup).
  //      Solflare opens a password dialog instead of rejecting silently, so we
  //      skip the call for Solflare when publicKey is not already present.
  //      The user can connect manually once they unlock their wallet.

  useEffect(() => {
    const savedName = localStorage.getItem(STORAGE_KEY) as WalletName | null;
    if (!savedName) return;

    const descriptor = WALLET_DESCRIPTORS.find(d => d.name === savedName);
    if (!descriptor) return;

    const provider = descriptor.getProvider();
    if (!provider) return;

    const attachAndSet = (address: string) => {
      try {
        provider.on("disconnect", handleDisconnect);
        provider.on("accountChanged", handleAccountChanged);
      } catch { /* some wallets may not support all events */ }
      providerRef.current = provider;
      setWallet(address);
      setWalletName(savedName);
    };

    // Fast path: wallet already unlocked — publicKey is available immediately.
    if (provider.publicKey) {
      const address = provider.publicKey.toBase58();
      if (address) { attachAndSet(address); return; }
    }

    // Solflare shows a password popup instead of silently rejecting when the
    // wallet is locked. Skip the connect() call to avoid the unwanted popup.
    if (savedName === "Solflare") return;

    // Phantom / Backpack: onlyIfTrusted silently rejects when locked — safe.
    provider.connect({ onlyIfTrusted: true })
      .then(result => {
        const publicKey =
          (result as { publicKey?: { toBase58(): string } } | undefined)?.publicKey
          ?? provider.publicKey;
        if (!publicKey) return;
        const address = publicKey.toBase58();
        if (address) attachAndSet(address);
      })
      .catch(() => {
        // Silent failure — wallet locked or permission revoked.
        // Keep localStorage so we retry on next page load.
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openWalletModal = useCallback(() => setModalOpen(true), []);

  /**
   * Sign a transaction WITHOUT broadcasting it.
   * Use this when the tx also needs local signers (e.g. a mint Keypair):
   *   const signed = await signTransaction(tx);
   *   signed.partialSign(mintKeypair);
   *   await connection.sendRawTransaction(signed.serialize());
   */
  const signTransaction = useCallback(async (transaction: Transaction): Promise<Transaction> => {
    const provider = providerRef.current;
    if (!provider) throw new Error("No wallet connected. Please connect your wallet first.");
    if (typeof provider.signTransaction !== "function") {
      throw new Error("Your wallet does not support signTransaction. Please update your wallet extension.");
    }
    return provider.signTransaction(transaction) as Promise<Transaction>;
  }, []);

  /**
   * Sign a VersionedTransaction without sending it.
   * Phantom, Backpack, and Solflare all support signTransaction for VersionedTransaction;
   * they detect the type at runtime and handle it correctly.
   */
  const signVersionedTransaction = useCallback(async (transaction: VersionedTransaction): Promise<VersionedTransaction> => {
    const provider = providerRef.current;
    if (!provider) throw new Error("No wallet connected. Please connect your wallet first.");
    if (typeof provider.signTransaction !== "function") {
      throw new Error("Your wallet does not support signTransaction. Please update your wallet extension.");
    }
    // provider.signTransaction accepts VersionedTransaction at runtime even though the
    // TypeScript overload resolves to Transaction. Cast to bypass the type mismatch.
    return provider.signTransaction(transaction as unknown as Transaction) as unknown as Promise<VersionedTransaction>;
  }, []);

  /**
   * Sign and broadcast a transaction in one step via the wallet's RPC node.
   * Delegates to provider.signAndSendTransaction — supported by Phantom,
   * Backpack, and Solflare. The transaction must have blockhash + feePayer set.
   */
  const signAndSendTransaction = useCallback(async (transaction: AnyTransaction): Promise<string> => {
    const provider = providerRef.current;
    if (!provider) throw new Error("No wallet connected. Please connect your wallet first.");
    if (typeof provider.signAndSendTransaction !== "function") {
      throw new Error("Your wallet does not support signAndSendTransaction. Please update your wallet extension.");
    }
    const result = await provider.signAndSendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    return result.signature;
  }, []);

  /**
   * Sign an arbitrary message with the connected wallet's Ed25519 private key.
   * Returns the raw 64-byte signature as a Uint8Array.
   */
  const signMessage = useCallback(async (messageBytes: Uint8Array): Promise<Uint8Array> => {
    const provider = providerRef.current;
    if (!provider) throw new Error("No wallet connected. Please connect your wallet first.");
    if (typeof provider.signMessage !== "function") {
      throw new Error("Your wallet does not support signMessage. Please update your wallet extension.");
    }
    const result = await provider.signMessage(messageBytes);
    // Normalize across wallet adapters:
    //   Phantom / Backpack → { signature: Uint8Array }
    //   Solflare           → Uint8Array directly
    if (result instanceof Uint8Array) return result;
    return (result as { signature: Uint8Array }).signature;
  }, []);

  return (
    <WalletContext.Provider value={{
      wallet,
      walletName,
      connected: wallet !== null,
      connectWallet,
      disconnect,
      openWalletModal,
      signTransaction,
      signVersionedTransaction,
      signAndSendTransaction,
      signMessage,
    }}>
      {children}
      {/* Global wallet modal — accessible from any component via openWalletModal() */}
      <WalletSelectModal open={modalOpen} onOpenChange={setModalOpen} />
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
