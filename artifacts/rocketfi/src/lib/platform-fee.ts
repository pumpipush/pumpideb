/**
 * platform-fee.ts — Platform fee collection for all trade paths.
 *
 * Charges 1% (100 bps) on every trade. The fee recipient wallet is configured
 * via the VITE_PLATFORM_FEE_RECIPIENT environment variable.
 *
 * Fee amounts:
 *   Buy  → 1% of SOL spent (lamports)
 *   Sell → 1% of SOL received (lamports); skipped when SOL-out is unknown at tx-build time
 *
 * Works with both Legacy Transaction and VersionedTransaction (v0 with ALTs).
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from "@solana/web3.js";

// ── Config ────────────────────────────────────────────────────────────────────

/** Platform fee in basis points (100 = 1%) */
export const PLATFORM_FEE_BPS = 100;

/**
 * Flat creation fee charged when a user creates a new token on pump.fun.
 * Pump.fun creates do not include an initial buy (amount = 0), so there is
 * no percentage base to calculate from — we charge a fixed amount instead.
 * 0.001 SOL = 1_000_000 lamports.
 */
export const PLATFORM_CREATE_FEE_LAMPORTS = 1_000_000n;

/** Read the fee recipient address from the env var, returning null if not set or invalid. */
export function getPlatformFeeRecipient(): PublicKey | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addr = (import.meta as any).env?.VITE_PLATFORM_FEE_RECIPIENT;
  if (!addr || typeof addr !== "string" || addr.trim() === "") return null;
  try {
    return new PublicKey(addr.trim());
  } catch {
    console.warn("[platform-fee] VITE_PLATFORM_FEE_RECIPIENT is not a valid Solana address; fee skipped.");
    return null;
  }
}

/** Calculate fee in lamports from a SOL amount in lamports. */
export function calcFeeLamports(solLamports: bigint): bigint {
  if (solLamports <= 0n) return 0n;
  return (solLamports * BigInt(PLATFORM_FEE_BPS)) / 10_000n;
}

// ── Legacy Transaction ────────────────────────────────────────────────────────

/**
 * Append a platform fee SOL transfer instruction to a Legacy Transaction.
 *
 * Call this AFTER building the trade transaction but BEFORE the user signs it.
 * The fee is included in the same atomic transaction as the trade — if the trade
 * fails, the fee is never collected.
 *
 * @param tx          Unsigned legacy Transaction to modify in place.
 * @param user        Trader's wallet address (base58 string).
 * @param solLamports SOL amount the trade moves, in lamports (buy: SOL in; sell: SOL out).
 */
export function addFeeToLegacyTx(
  tx: Transaction,
  user: string,
  solLamports: bigint,
): void {
  const recipient = getPlatformFeeRecipient();
  if (!recipient) return;
  const feeLamports = calcFeeLamports(solLamports);
  if (feeLamports <= 0n) return;

  try {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(user),
        toPubkey:   recipient,
        lamports:   feeLamports,
      }),
    );
  } catch (err) {
    // Malformed user pubkey — skip fee rather than blocking the trade.
    console.warn("[platform-fee] addFeeToLegacyTx skipped:", err);
  }
}

// ── VersionedTransaction (v0 + ALTs) ─────────────────────────────────────────

/**
 * Return a NEW VersionedTransaction that includes a platform fee SOL transfer.
 *
 * Works for both v0 transactions with Address Lookup Tables (e.g. Jupiter, pumpportal)
 * and v0 transactions without ALTs. If the fee recipient is not configured, the
 * original transaction is returned unchanged.
 *
 * Implementation: decompiles the message (fetching ALT account data if required),
 * appends a SystemProgram.transfer instruction, then recompiles to v0.
 *
 * IMPORTANT: The returned transaction is UNSIGNED. The caller must pass it to
 * `signAndSendTransaction()` or `signVersionedTransaction()`.
 *
 * @param tx          Unsigned VersionedTransaction from Jupiter / pumpportal / etc.
 * @param user        Trader's wallet address (base58 string).
 * @param solLamports SOL amount in lamports (buy: SOL in; sell: SOL out).
 * @param connection  Solana connection (for fetching ALT accounts if needed).
 */
export async function addFeeToVersionedTx(
  tx: VersionedTransaction,
  user: string,
  solLamports: bigint,
  connection: Connection,
): Promise<VersionedTransaction> {
  const recipient = getPlatformFeeRecipient();
  if (!recipient) return tx;
  const feeLamports = calcFeeLamports(solLamports);
  if (feeLamports <= 0n) return tx;

  // Fetch Address Lookup Tables referenced in the transaction (needed for decompile).
  const lookups = tx.message.addressTableLookups ?? [];
  let altAccounts: AddressLookupTableAccount[] = [];
  if (lookups.length > 0) {
    const results = await Promise.all(
      lookups.map(l => connection.getAddressLookupTable(l.accountKey)),
    );
    altAccounts = results
      .map(r => r.value)
      .filter((v): v is AddressLookupTableAccount => v !== null);
  }

  // Decompile → append fee transfer → recompile to v0.
  const decompiledMsg = TransactionMessage.decompile(tx.message, {
    addressLookupTableAccounts: altAccounts,
  });

  decompiledMsg.instructions.push(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(user),
      toPubkey:   recipient,
      lamports:   feeLamports,
    }),
  );

  const newMessage = decompiledMsg.compileToV0Message(altAccounts);
  return new VersionedTransaction(newMessage);
}
