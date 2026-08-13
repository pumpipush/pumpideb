/**
 * Pump.fun creator fee claiming — on-chain implementation.
 *
 * Token creators on pump.fun automatically earn a share of every trade fee on
 * their tokens. The accrued SOL sits in a per-creator PDA ("creator vault").
 * This module lets users check their claimable balance and build the
 * `collect_creator_fee` transaction to sweep it back to their wallet.
 *
 * Instruction: collect_creator_fee
 *   Discriminator: sha256("global:collect_creator_fee")[0:8]
 *               = [20, 22, 86, 123, 198, 28, 219, 132]
 *
 * Accounts (in order):
 *   1. creator        — signer, writable (fee recipient)
 *   2. creatorVault   — writable PDA (seeds: ["creator-vault", creator])
 *   3. systemProgram  — read-only
 *   4. eventAuthority — read-only  (Anchor event emission PDA)
 *   5. program        — read-only  (self-CPI for event emission)
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { PUMP_FUN_PROGRAM_ID, PUMP_EVENT_AUTHORITY, getRpcUrl } from "./pumpfun-swap";

// ── PDA ───────────────────────────────────────────────────────────────────────

/**
 * Derive the creator vault PDA for a given creator wallet.
 * Seeds: ["creator-vault", creator.toBuffer()]
 */
export function getCreatorVaultPda(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creator.toBuffer()],
    PUMP_FUN_PROGRAM_ID,
  )[0];
}

// ── Discriminator ─────────────────────────────────────────────────────────────

/** sha256("global:collect_creator_fee")[0:8] */
const COLLECT_CREATOR_FEE_DISC = new Uint8Array([20, 22, 86, 123, 198, 28, 219, 132]);

// ── Balance check ─────────────────────────────────────────────────────────────

/**
 * Return the lamports sitting in the creator's vault PDA.
 * Returns 0n if the account doesn't exist yet (no fees earned).
 */
export async function fetchClaimableLamports(creatorAddress: string): Promise<bigint> {
  try {
    const creator = new PublicKey(creatorAddress);
    const vault   = getCreatorVaultPda(creator);
    const conn    = new Connection(getRpcUrl(), "confirmed");
    const info    = await conn.getAccountInfo(vault, "confirmed");
    if (!info) return 0n;
    return BigInt(info.lamports);
  } catch {
    return 0n;
  }
}

// ── Transaction builder ───────────────────────────────────────────────────────

export interface BuildCollectFeeTxResult {
  transaction: Transaction;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Build a `collect_creator_fee` transaction for the given creator wallet.
 * The caller must sign and send the transaction.
 */
export async function buildCollectCreatorFeeTx(
  creatorAddress: string,
  priorityFeeMicroLamports = 150_000,
): Promise<BuildCollectFeeTxResult> {
  const creator = new PublicKey(creatorAddress);
  const vault   = getCreatorVaultPda(creator);
  const conn    = new Connection(getRpcUrl(), "confirmed");

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  const claimIx = new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: creator,                 isSigner: true,  isWritable: true  },
      { pubkey: vault,                   isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY,    isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID,     isSigner: false, isWritable: false },
    ],
    data: Buffer.from(COLLECT_CREATOR_FEE_DISC),
  });

  const tx = new Transaction();
  tx.feePayer       = creator;
  tx.recentBlockhash = blockhash;

  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
  tx.add(claimIx);

  return { transaction: tx, blockhash, lastValidBlockHeight };
}
