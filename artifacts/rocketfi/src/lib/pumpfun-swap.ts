/**
 * Pump.fun bonding curve on-chain swap builder.
 *
 * Builds buy/sell transactions for pump.fun tokens still on the bonding curve
 * (graduated=false). Graduated tokens (on PumpSwap/Raydium) use Jupiter — task #104.
 *
 * Instruction args:
 *   buy  → amount (token atoms to receive)  + maxSolCost  (max lamports to spend)
 *   sell → amount (token atoms to sell)     + minSolOutput (min lamports to receive)
 *
 * The platform referral fee (PLATFORM_FEE_BPS) is collected as a separate
 * SystemProgram.transfer instruction appended to the same transaction.
 * Configure via VITE_PUMP_FEE_RECIPIENT env var; if not set, fee is skipped.
 */

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** pump.fun bonding curve program (mainnet) */
export const PUMP_FUN_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

/**
 * pump.fun global state PDA.
 * Derivation: sha256("global" || [255] || program_id || "ProgramDerivedAddress")
 * Verified by computing the PDA and matching against a real on-chain transaction.
 */
const PUMP_FUN_GLOBAL = new PublicKey(
  "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"
);

/**
 * Fallback fee recipient (original value).
 * Only used if the live global-state fetch fails.
 * The authoritative value is read from the global account at trade time.
 */
const PUMP_PROTOCOL_FEE_RECIPIENT_FALLBACK = new PublicKey(
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"
);

// ── Global-state cache ────────────────────────────────────────────────────────

interface PumpGlobalState {
  feeRecipient: PublicKey;
  /** Timestamp (ms) when this was fetched — invalidate after 5 minutes */
  fetchedAt: number;
}
let _cachedGlobal: PumpGlobalState | null = null;

/**
 * Read the pump.fun global state account and return the live fee recipient.
 * Caches the result for 5 minutes so repeated trades don't hammer the RPC.
 * Falls back to the hardcoded address if the account can't be fetched.
 */
async function getPumpFeeRecipient(conn: Connection): Promise<PublicKey> {
  const now = Date.now();
  if (_cachedGlobal && now - _cachedGlobal.fetchedAt < 5 * 60_000) {
    return _cachedGlobal.feeRecipient;
  }

  try {
    const info = await conn.getAccountInfo(PUMP_FUN_GLOBAL, "confirmed");
    if (!info || info.data.length < 73) {
      throw new Error("Global state account missing or too short");
    }
    // Layout: 8 discriminator + 1 initialized + 32 authority + 32 fee_recipient
    const feeRecipient = new PublicKey(info.data.slice(41, 73));
    _cachedGlobal = { feeRecipient, fetchedAt: now };
    return feeRecipient;
  } catch (err) {
    console.warn("[pumpfun-swap] Could not fetch global state; using fallback fee recipient.", err);
    return PUMP_PROTOCOL_FEE_RECIPIENT_FALLBACK;
  }
}

/**
 * Anchor event authority PDA for the pump.fun program.
 * Seed: ["__event_authority"], program: PUMP_FUN_PROGRAM_ID
 */
const PUMP_EVENT_AUTHORITY = new PublicKey(
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"
);

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv"
);

/**
 * Anchor discriminator for buy: sha256("global:buy")[0:8]
 * Verified against pump.fun program IDL.
 */
const BUY_DISCRIMINATOR  = new Uint8Array([102,  6, 61,  18,  1, 218, 235, 234]);

/**
 * Anchor discriminator for sell: sha256("global:sell")[0:8]
 * Verified against pump.fun program IDL.
 */
const SELL_DISCRIMINATOR = new Uint8Array([ 51, 230, 133, 164,  1, 127, 131, 173]);

/** Platform referral fee charged on every trade (1% = 100 bps) */
const PLATFORM_FEE_BPS = 100;

/** Free public Solana RPC fallbacks (used when no Alchemy key is set) */
const PUBLIC_RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
  "https://api.mainnet-beta.solana.com",
] as const;

// ── Private helpers ───────────────────────────────────────────────────────────

/** Encode a BigInt as 8-byte little-endian (u64) */
function encodeU64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/** Concatenate Uint8Arrays into one */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

/** Derive the Associated Token Address (ATA) for owner + mint */
function getATA(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Resolve the Solana RPC endpoint to use.
 *  Priority: VITE_ALCHEMY_API_KEY → VITE_SOLANA_RPC_URL → PublicNode free */
function getRpcUrl(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (import.meta as any).env;
  if (env?.VITE_ALCHEMY_API_KEY) return `https://solana-mainnet.g.alchemy.com/v2/${env.VITE_ALCHEMY_API_KEY}`;
  if (env?.VITE_SOLANA_RPC_URL)  return env.VITE_SOLANA_RPC_URL;
  return PUBLIC_RPCS[0];
}

/** Resolve the configured platform fee recipient wallet address, or null */
function getPlatformFeeRecipient(): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addr = (import.meta as any).env?.VITE_PLATFORM_FEE_RECIPIENT;
  if (!addr || typeof addr !== "string" || addr.trim() === "") return null;
  return addr.trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Derive the bonding curve PDA for a mint */
export function getPumpBondingCurve(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN_PROGRAM_ID,
  )[0];
}

export interface BuildPumpSwapTxParams {
  /** Base58 mint address of the pump.fun token */
  mint: string;
  /** Base58 address of the connected user */
  user: string;
  /** Token atoms to buy (for buy) or sell (for sell) — 6-decimal base units */
  tokenAtoms: bigint;
  /**
   * For buy:  max SOL lamports the user will pay (solIn * (1 + slippage/10000))
   * For sell: min SOL lamports the user will accept (solOut * (1 - slippage/10000))
   */
  solLimitLamports: bigint;
  /** Priority fee in micro-lamports per compute unit (from swap settings) */
  priorityFeeMicroLamports: number;
  /**
   * Estimated SOL lamports for platform fee calculation.
   * For buy:  solIn lamports
   * For sell: estimated solOut lamports from AMM math
   */
  solEstimateLamports: bigint;
}

/**
 * Result returned by buildPumpFunBuyTx / buildPumpFunSellTx.
 * The blockhash fields are needed for confirmTransaction — they establish the
 * "freshness window" for the submitted transaction.
 */
export interface BuildPumpSwapTxResult {
  transaction: Transaction;
  /** The recent blockhash embedded in the transaction */
  blockhash: string;
  /** Last slot height at which this blockhash is still valid */
  lastValidBlockHeight: number;
}

/**
 * Build a pump.fun bonding curve BUY transaction.
 * Fetches the latest blockhash from the configured RPC endpoint.
 *
 * Instruction data: buy(amount=tokenAtoms, maxSolCost=solLimitLamports)
 *
 * Returns the transaction together with the blockhash confirmation window so
 * callers can use `confirmTransaction({ signature, blockhash, lastValidBlockHeight })`
 * to wait for on-chain settlement without risking a stale-blockhash expiry.
 */
export async function buildPumpFunBuyTx(params: BuildPumpSwapTxParams): Promise<BuildPumpSwapTxResult> {
  const { mint: mintStr, user: userStr, tokenAtoms, solLimitLamports,
          priorityFeeMicroLamports, solEstimateLamports } = params;

  const mint   = new PublicKey(mintStr);
  const user   = new PublicKey(userStr);
  const bondingCurve           = getPumpBondingCurve(mint);
  const associatedBondingCurve = getATA(bondingCurve, mint);
  const associatedUser         = getATA(user, mint);

  const data = Buffer.from(concat(
    BUY_DISCRIMINATOR,
    encodeU64LE(tokenAtoms),
    encodeU64LE(solLimitLamports),
  ));

  const conn = new Connection(getRpcUrl(), "confirmed");
  // Read fee recipient from chain — pump.fun has updated this address before.
  // Using the live value prevents ConstraintAddress failures after future updates.
  const feeRecipient = await getPumpFeeRecipient(conn);

  const buyIx = new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: PUMP_FUN_GLOBAL,       isSigner: false, isWritable: false },
      { pubkey: feeRecipient,          isSigner: false, isWritable: true  },
      { pubkey: mint,                  isSigner: false, isWritable: false },
      { pubkey: bondingCurve,          isSigner: false, isWritable: true  },
      { pubkey: associatedBondingCurve,isSigner: false, isWritable: true  },
      { pubkey: associatedUser,        isSigner: false, isWritable: true  },
      { pubkey: user,                  isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,    isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY,  isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID,   isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction();

  if (priorityFeeMicroLamports > 0) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFeeMicroLamports,
    }));
  }

  tx.add(buyIx);
  _addPlatformFeeIx(tx, user, solEstimateLamports);

  tx.feePayer = user;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  return { transaction: tx, blockhash, lastValidBlockHeight };
}

/**
 * Build a pump.fun bonding curve SELL transaction.
 * Fetches the latest blockhash from the configured RPC endpoint.
 *
 * Instruction data: sell(amount=tokenAtoms, minSolOutput=solLimitLamports)
 *
 * Returns the transaction together with the blockhash confirmation window.
 */
export async function buildPumpFunSellTx(params: BuildPumpSwapTxParams): Promise<BuildPumpSwapTxResult> {
  const { mint: mintStr, user: userStr, tokenAtoms, solLimitLamports,
          priorityFeeMicroLamports, solEstimateLamports } = params;

  const mint   = new PublicKey(mintStr);
  const user   = new PublicKey(userStr);
  const bondingCurve           = getPumpBondingCurve(mint);
  const associatedBondingCurve = getATA(bondingCurve, mint);
  const associatedUser         = getATA(user, mint);

  const data = Buffer.from(concat(
    SELL_DISCRIMINATOR,
    encodeU64LE(tokenAtoms),
    encodeU64LE(solLimitLamports),
  ));

  const conn = new Connection(getRpcUrl(), "confirmed");
  const feeRecipient = await getPumpFeeRecipient(conn);

  const sellIx = new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: PUMP_FUN_GLOBAL,        isSigner: false, isWritable: false },
      { pubkey: feeRecipient,           isSigner: false, isWritable: true  },
      { pubkey: mint,                   isSigner: false, isWritable: false },
      { pubkey: bondingCurve,           isSigner: false, isWritable: true  },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true  },
      { pubkey: associatedUser,         isSigner: false, isWritable: true  },
      { pubkey: user,                   isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY,   isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID,    isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction();

  if (priorityFeeMicroLamports > 0) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFeeMicroLamports,
    }));
  }

  tx.add(sellIx);
  _addPlatformFeeIx(tx, user, solEstimateLamports);

  tx.feePayer = user;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  return { transaction: tx, blockhash, lastValidBlockHeight };
}

/**
 * Wait for a transaction to reach "confirmed" status.
 *
 * Strategy:
 *  1. Race conn.confirmTransaction() (blockhash strategy) against a 40 s timeout.
 *     Free RPCs often hang here even after the tx has already landed -- their
 *     WebSocket subscription silently drops without notifying the client.
 *  2. On timeout (or any network error), fall back to polling getSignatureStatus
 *     every 3 s for up to 30 s. This catches the common "already confirmed but
 *     confirmTransaction never resolved" scenario.
 *  3. If the poll loop finds the tx confirmed/finalized, return success.
 *  4. Only throw a true error on (a) on-chain instruction failure or
 *     (b) all fallback polls exhausted without seeing confirmation.
 */
export async function waitForTxConfirmation(
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<void> {
  const conn = new Connection(getRpcUrl(), "confirmed");

  // Phase 1: confirmTransaction with 40 s timeout.
  // Free RPCs frequently drop the WebSocket subscription that powers this call,
  // leaving it hanging indefinitely even though the tx confirmed minutes ago.
  const PRIMARY_TIMEOUT_MS = 40_000;

  let phase1Err: unknown = null;
  try {
    const confirmPromise = conn.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), PRIMARY_TIMEOUT_MS),
    );

    const result = await Promise.race([confirmPromise, timeoutPromise]);

    if (result !== null) {
      // confirmTransaction finished within the timeout window.
      if (result.value.err) {
        throw new Error(
          `Transaction failed on-chain: ${JSON.stringify(result.value.err)}`,
        );
      }
      return; // confirmed
    }
    // result === null means we timed out; fall through to polling
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("Transaction failed on-chain")) throw err;
    if (/BlockheightExceeded|expired/i.test(msg)) throw err;
    phase1Err = err;
  }

  // Phase 2: polling fallback via getSignatureStatus.
  // Reliably detects a confirmed tx that confirmTransaction missed.
  const POLL_INTERVAL_MS = 3_000;
  const POLL_ATTEMPTS    = 10;

  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const { value } = await conn.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });
      if (value) {
        if (value.err) {
          throw new Error(
            `Transaction failed on-chain: ${JSON.stringify(value.err)}`,
          );
        }
        if (
          value.confirmationStatus === "confirmed" ||
          value.confirmationStatus === "finalized"
        ) {
          return; // confirmed via polling
        }
      }
    } catch (pollErr) {
      const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
      if (msg.startsWith("Transaction failed on-chain")) throw pollErr;
      // Network error during poll -- keep trying
    }
  }

  // Both phases exhausted without confirmation.
  const cause = phase1Err instanceof Error ? ` (${(phase1Err as Error).message})` : "";
  throw new Error(
    `Confirmation timeout${cause}. The transaction may have already succeeded -- check your wallet history before retrying.`,
  );
}

/** Append the platform referral fee transfer instruction if configured */
function _addPlatformFeeIx(
  tx: Transaction,
  user: PublicKey,
  solEstimateLamports: bigint,
): void {
  const recipient = getPlatformFeeRecipient();
  if (!recipient || solEstimateLamports <= 0n) return;

  const feeLamports = solEstimateLamports * BigInt(PLATFORM_FEE_BPS) / 10_000n;
  if (feeLamports <= 0n) return;

  try {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey:   new PublicKey(recipient),
        lamports:   feeLamports,
      })
    );
  } catch {
    // Invalid fee recipient address — skip fee rather than blocking the trade
    console.warn("[pumpfun-swap] VITE_PUMP_FEE_RECIPIENT is not a valid Solana address; fee skipped.");
  }
}
