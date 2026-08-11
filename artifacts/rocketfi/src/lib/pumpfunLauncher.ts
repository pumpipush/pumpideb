/**
 * pumpfunLauncher.ts — On-chain token creation for pump.fun bonding curve.
 *
 * Flow:
 *   1. uploadToPumpFunIpfs()    → POST image + metadata to pump.fun IPFS → metadataUri
 *   2. buildPumpFunCreateTx()   → derive PDAs, encode create instruction, assemble tx
 *   3. (caller) simulate tx     → connection.simulateTransaction(tx) — sigVerify: false
 *   4. (caller) tx.partialSign(mintKeypair)
 *   5. (caller) signAndSendTransaction(tx) → wallet adds user sig + broadcasts
 *   6. (caller) waitForConfirmation(connection, sig)
 *
 * Cost: ~0.02 SOL for pump.fun fee + ~0.003 SOL rent for mint/metadata accounts
 */

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { getConnection } from "./solanaConnection";

// ── Constants ─────────────────────────────────────────────────────────────────

/** pump.fun bonding curve program (mainnet) */
const PUMP_FUN_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);

/** pump.fun global state account (fixed known address) */
const PUMP_FUN_GLOBAL = new PublicKey(
  "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5zznTJ67bBb2GQZ",
);

/** Anchor event authority PDA — seed: ["__event_authority"] */
const PUMP_EVENT_AUTHORITY = new PublicKey(
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
);

/** Metaplex Token Metadata program */
const MPL_TOKEN_METADATA = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

/** Canonical Associated Token Program ID */
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bSf",
);

/**
 * Anchor discriminator for "create": sha256("global:create")[0:8]
 * = [24, 30, 200, 40, 5, 28, 7, 119]
 */
const CREATE_DISCRIMINATOR = new Uint8Array([24, 30, 200, 40, 5, 28, 7, 119]);

/** Priority fee in micro-lamports — keeps the tx competitive without overpaying */
const CREATE_PRIORITY_MICRO_LAMPORTS = 50_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PumpFunIpfsFields {
  name:        string;
  symbol:      string;
  description: string;
  twitter?:    string;
  telegram?:   string;
  website?:    string;
  image:       File;
}

export interface PumpFunCreateTxResult {
  transaction:         Transaction;
  mintKeypair:         Keypair;
  mintAddress:         string;
  blockhash:           string;
  lastValidBlockHeight: number;
}

// ── Borsh helpers ─────────────────────────────────────────────────────────────

/** Encode a UTF-8 string as Borsh bytes: 4-byte LE length prefix + content */
function borshStr(s: string): Buffer {
  const encoded = Buffer.from(s, "utf8");
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32LE(encoded.length, 0);
  return Buffer.concat([len, encoded]);
}

// ── ATA derivation ────────────────────────────────────────────────────────────

function getATA(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

// ── IPFS Upload ───────────────────────────────────────────────────────────────

/**
 * Upload token metadata + image to our self-hosted metadata endpoint.
 *
 * pump.fun's /api/ipfs endpoint is blocked from Replit datacenter IPs (Cloudflare
 * 530) and rejects cross-origin browser requests. We avoid it entirely by hosting
 * the metadata ourselves via the API server's object storage.
 *
 * Flow:
 *   1. Encode the image as base64 in the browser (no binary/multipart complexity)
 *   2. POST JSON to /api/pump-ipfs-upload
 *   3. Server uploads image + metadata JSON to GCS public path
 *   4. Server returns an absolute HTTPS metadataUri
 *
 * pump.fun's on-chain program only stores the metadataUri string and accepts any
 * publicly reachable HTTPS URL — not exclusively IPFS URIs.
 *
 * Returns the metadataUri to embed in the create instruction.
 * Retries once on transient network failure.
 */
export async function uploadToPumpFunIpfs(fields: PumpFunIpfsFields): Promise<string> {
  // Convert File → base64 using FileReader (browser-native, no Buffer polyfill needed)
  const imageBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // FileReader.readAsDataURL produces "data:<mime>;base64,<data>" — strip prefix
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(fields.image);
  });

  const attempt = async () => {
    const body: Record<string, string> = {
      name:        fields.name,
      symbol:      fields.symbol,
      description: fields.description,
      imageBase64,
      imageType:   fields.image.type || "image/png",
    };
    if (fields.twitter)  body.twitter  = fields.twitter;
    if (fields.telegram) body.telegram = fields.telegram;
    if (fields.website)  body.website  = fields.website;

    const res = await fetch("/api/pump-ipfs-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(`pump.fun metadata upload failed (${res.status}): ${text}`);
    }

    const data = await res.json() as { metadataUri?: string };
    if (!data.metadataUri) {
      throw new Error("Metadata upload response did not include metadataUri");
    }
    return data.metadataUri;
  };

  try {
    return await attempt();
  } catch (firstErr) {
    // One retry on transient errors
    try {
      return await attempt();
    } catch {
      throw firstErr; // throw the original error for better diagnostics
    }
  }
}

// ── Transaction Builder ───────────────────────────────────────────────────────

/**
 * Build a pump.fun token CREATE transaction ready for simulation + signing.
 *
 * Generates a fresh mint Keypair internally — the caller receives it in the
 * result so they can partialSign before handing to the wallet.
 *
 * The returned transaction is UNSIGNED. Call:
 *   tx.partialSign(mintKeypair)           — mint signature
 *   await signAndSendTransaction(tx)      — wallet adds user sig + broadcasts
 */
export async function buildPumpFunCreateTx(
  walletAddress:  string,
  name:           string,
  symbol:         string,
  metadataUri:    string,
): Promise<PumpFunCreateTxResult> {
  const user        = new PublicKey(walletAddress);
  const mintKeypair = Keypair.generate();
  const mint        = mintKeypair.publicKey;

  // ── Derive all required PDAs ───────────────────────────────────────────────
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint-authority")],
    PUMP_FUN_PROGRAM_ID,
  );
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN_PROGRAM_ID,
  );
  const associatedBondingCurve = getATA(bondingCurve, mint);
  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      MPL_TOKEN_METADATA.toBuffer(),
      mint.toBuffer(),
    ],
    MPL_TOKEN_METADATA,
  );

  // ── Encode create instruction data (Borsh) ─────────────────────────────────
  const data = Buffer.concat([
    Buffer.from(CREATE_DISCRIMINATOR),
    borshStr(name),
    borshStr(symbol),
    borshStr(metadataUri),
  ]);

  // ── Build create instruction ───────────────────────────────────────────────
  // Account ordering exactly matches the pump.fun IDL:
  // https://github.com/pump-fun/pump.fun-program-idl
  const createIx = new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: mint,                        isSigner: true,  isWritable: true  },
      { pubkey: mintAuthority,               isSigner: false, isWritable: false },
      { pubkey: bondingCurve,                isSigner: false, isWritable: true  },
      { pubkey: associatedBondingCurve,      isSigner: false, isWritable: true  },
      { pubkey: PUMP_FUN_GLOBAL,             isSigner: false, isWritable: false },
      { pubkey: MPL_TOKEN_METADATA,          isSigner: false, isWritable: false },
      { pubkey: metadataPDA,                 isSigner: false, isWritable: true  },
      { pubkey: user,                        isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,            isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,          isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY,        isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID,         isSigner: false, isWritable: false },
    ],
    data,
  });

  // ── Assemble transaction ───────────────────────────────────────────────────
  const tx = new Transaction();
  // Priority fee — keeps tx from getting dropped under congestion
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: CREATE_PRIORITY_MICRO_LAMPORTS,
  }));
  tx.add(createIx);

  tx.feePayer = user;
  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  return {
    transaction: tx,
    mintKeypair,
    mintAddress: mint.toBase58(),
    blockhash,
    lastValidBlockHeight,
  };
}

/**
 * Simulate a pump.fun create transaction without signature verification.
 *
 * Calling simulateTransaction WITHOUT signers sets sigVerify: false in the
 * RPC call — signatures are not checked, only instruction logic is evaluated.
 * This lets us detect instruction errors (insufficient SOL, bad accounts, etc.)
 * before asking the user to approve in their wallet.
 *
 * @throws Error with a human-readable message extracted from program logs
 */
export async function simulatePumpFunCreate(tx: Transaction): Promise<void> {
  const conn = getConnection();
  // No signers → @solana/web3.js sets sigVerify: false automatically
  const { value: sim } = await conn.simulateTransaction(tx);

  if (sim.err) {
    const logs = sim.logs ?? [];
    const errorLine =
      logs.find(l => /Error:|failed:|AnchorError|InstructionError/i.test(l)) ??
      logs.at(-1) ??
      JSON.stringify(sim.err);
    throw new Error(`Simulation failed: ${errorLine}`);
  }
}

// ── Estimated cost ────────────────────────────────────────────────────────────

/**
 * Approximate SOL cost to launch a pump.fun token:
 *   - pump.fun creation fee: ~0.02 SOL
 *   - Rent for mint account: ~0.0015 SOL
 *   - Rent for metadata account: ~0.006 SOL
 *   - Priority fee + transaction fee: ~0.001 SOL
 */
export const PUMP_FUN_LAUNCH_COST_SOL = 0.03;
