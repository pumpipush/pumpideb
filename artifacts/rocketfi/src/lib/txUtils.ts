/**
 * txUtils.ts — safe transaction simulation + submission utilities.
 *
 * Always simulate before sending so SOL is never wasted on transactions
 * that would fail. On simulation failure, throw a human-readable error
 * extracted from the program logs.
 */

import type { Connection, Transaction, Keypair } from "@solana/web3.js";

// ── Error type ────────────────────────────────────────────────────────────────

/** Thrown when simulation predicts the transaction will fail on-chain. */
export class TransactionSimulationError extends Error {
  /** Raw program logs from the simulation — useful for debugging. */
  public readonly logs: string[];

  constructor(message: string, logs: string[]) {
    super(message);
    this.name = "TransactionSimulationError";
    this.logs = logs;
  }
}

// ── simulateAndSend ───────────────────────────────────────────────────────────

/**
 * Simulate `transaction` against the current chain state and, only if
 * simulation succeeds, send it to the network.
 *
 * @param connection  A Solana Connection (from getConnection())
 * @param transaction Pre-built Transaction with blockhash + feePayer set
 * @param signers     Local Keypair signers (e.g. the mint keypair for token creation).
 *                    The wallet's signature is added separately via WalletContext.
 * @returns Base58-encoded transaction signature
 * @throws TransactionSimulationError if simulation predicts failure
 * @throws Error on network failures or confirmed on-chain failure
 */
export async function simulateAndSend(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
): Promise<string> {
  // ── Step 1: Simulate ─────────────────────────────────────────────────────
  const { value: simValue } = await connection.simulateTransaction(
    transaction,
    signers,
  );

  if (simValue.err) {
    const logs = simValue.logs ?? [];

    // Extract the most descriptive error line from program logs.
    // Anchor programs emit "AnchorError", others emit "Error:" or "failed:".
    const errorLine =
      logs.find(l => /AnchorError|Error:|failed:|InstructionError/i.test(l)) ??
      logs.at(-1) ??
      JSON.stringify(simValue.err);

    throw new TransactionSimulationError(
      `Transaction would fail: ${errorLine}`,
      logs,
    );
  }

  // ── Step 2: Send (simulation passed) ─────────────────────────────────────
  return connection.sendTransaction(transaction, signers);
}

// ── waitForConfirmation ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS   = 2_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Poll for transaction confirmation until confirmed/finalized or timeout.
 *
 * @param connection  Solana Connection
 * @param signature   Base58 transaction signature returned by send
 * @param timeoutMs   How long to wait before giving up (default 60 s)
 * @throws Error if the transaction fails on-chain or times out
 */
export async function waitForConfirmation(
  connection: Connection,
  signature: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });

    if (
      value?.confirmationStatus === "confirmed" ||
      value?.confirmationStatus === "finalized"
    ) {
      return;
    }

    if (value?.err) {
      throw new Error(
        `Transaction failed on-chain: ${JSON.stringify(value.err)}`,
      );
    }

    await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Transaction not confirmed within ${timeoutMs / 1_000} s. Signature: ${signature}`,
  );
}
