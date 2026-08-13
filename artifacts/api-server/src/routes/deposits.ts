/**
 * Solana Pay deposit routes
 *
 * Flow:
 *   1. POST /deposits/create  → generate reference pubkey → Solana Pay URL + QR content
 *   2. GET  /deposits/balance → current in-app SOL balance for the authed user
 *   3. GET  /deposits/:reference/status → poll on-chain; credit balance on first confirmation
 */

import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, depositsTable, profilesTable } from "@workspace/db";
import { asyncWrap } from "../lib/asyncHandler.js";
import { extractBearer, verifyToken, type AuthPayload } from "../lib/auth-jwt.js";
import { getPrimaryHttpRpc } from "../lib/adapters/solanaRpcBase.js";
import { logger as rootLogger } from "../lib/logger.js";

const router = Router();
const logger = rootLogger.child({ module: "deposits" });

// ── Config ────────────────────────────────────────────────────────────────────
const TREASURY_ADDRESS = process.env["PLATFORM_TREASURY_ADDRESS"] ?? "";
const MIN_LAMPORTS = 10_000_000n;      // 0.01 SOL
const MAX_LAMPORTS = 100_000_000_000n; // 100 SOL
const EXPIRY_MS    = 30 * 60 * 1_000; // 30 minutes

// ── Base58 encoder ────────────────────────────────────────────────────────────
// Produces the same output as @solana/web3.js PublicKey.toBase58() for a
// 32-byte buffer.  Used so we don't need @solana/web3.js in the API server.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(buf: Buffer): string {
  let n = BigInt("0x" + buf.toString("hex"));
  let out = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    n /= 58n;
    out = B58[r] + out;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

// ── Solana RPC helper ─────────────────────────────────────────────────────────
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(getPrimaryHttpRpc(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json() as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result as T;
}

// ── Auth helper ───────────────────────────────────────────────────────────────
function requireJwt(req: Request, res: Response): AuthPayload | null {
  const token = extractBearer(req.headers["authorization"]);
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const payload = verifyToken(token);
  if (!payload) { res.status(401).json({ error: "Unauthorized" }); return null; }
  return payload;
}

// ── POST /deposits/create ─────────────────────────────────────────────────────
router.post(
  "/deposits/create",
  asyncWrap(async (req: Request, res: Response) => {
    if (!TREASURY_ADDRESS) {
      res.status(503).json({ error: "Deposits not configured on this server" });
      return;
    }

    const auth = requireJwt(req, res);
    if (!auth) return;

    const { amountSol } = req.body as { amountSol?: number };
    if (typeof amountSol !== "number" || !Number.isFinite(amountSol) || amountSol <= 0) {
      res.status(400).json({ error: "amountSol must be a positive number" });
      return;
    }

    const amountLamports = BigInt(Math.round(amountSol * 1e9));
    if (amountLamports < MIN_LAMPORTS) {
      res.status(400).json({ error: "Minimum deposit is 0.01 SOL" });
      return;
    }
    if (amountLamports > MAX_LAMPORTS) {
      res.status(400).json({ error: "Maximum deposit is 100 SOL" });
      return;
    }

    // Generate a unique 32-byte reference pubkey for this deposit session.
    // This key is embedded in the Solana Pay URL and appears as a read-only
    // account in the on-chain transfer, making the tx discoverable via
    // getSignaturesForAddress.
    const referencePubkey = base58Encode(crypto.randomBytes(32));
    const expiresAt = new Date(Date.now() + EXPIRY_MS);

    await db.insert(depositsTable).values({
      userAddress: auth.sub,
      referencePubkey,
      amountLamports,
      status: "pending",
      expiresAt,
    });

    const solanaPayUrl = [
      `solana:${TREASURY_ADDRESS}`,
      `?amount=${amountSol}`,
      `&reference=${referencePubkey}`,
      `&label=${encodeURIComponent("RocketFi")}`,
      `&message=${encodeURIComponent("Deposit SOL")}`,
    ].join("");

    res.json({ reference: referencePubkey, solanaPayUrl, expiresAt: expiresAt.toISOString() });
  }),
);

// ── GET /deposits/balance ─────────────────────────────────────────────────────
// Must be registered BEFORE /:reference/status so "balance" is not consumed
// as a reference parameter.
router.get(
  "/deposits/balance",
  asyncWrap(async (req: Request, res: Response) => {
    const auth = requireJwt(req, res);
    if (!auth) return;

    const [row] = await db
      .select({ solBalanceLamports: profilesTable.solBalanceLamports })
      .from(profilesTable)
      .where(eq(profilesTable.address, auth.sub))
      .limit(1);

    if (!row) { res.status(404).json({ error: "Profile not found" }); return; }

    const lamports = row.solBalanceLamports ?? 0n;
    res.json({
      solBalanceLamports: lamports.toString(),
      solBalance: (Number(lamports) / 1e9).toFixed(9).replace(/\.?0+$/, "") || "0",
    });
  }),
);

// ── GET /deposits/:reference/status ──────────────────────────────────────────
router.get(
  "/deposits/:reference/status",
  asyncWrap(async (req: Request, res: Response) => {
    const auth = requireJwt(req, res);
    if (!auth) return;

    const { reference } = req.params as { reference: string };

    const [deposit] = await db
      .select()
      .from(depositsTable)
      .where(eq(depositsTable.referencePubkey, reference))
      .limit(1);

    if (!deposit || deposit.userAddress !== auth.sub) {
      res.status(404).json({ error: "Deposit not found" });
      return;
    }

    // Already settled
    if (deposit.status === "confirmed") {
      res.json({
        status: "confirmed",
        txSignature: deposit.txSignature,
        creditedLamports: deposit.amountLamports.toString(),
      });
      return;
    }
    if (deposit.status === "expired" || deposit.expiresAt < new Date()) {
      if (deposit.status !== "expired") {
        await db
          .update(depositsTable)
          .set({ status: "expired" })
          .where(eq(depositsTable.referencePubkey, reference));
      }
      res.json({ status: "expired" });
      return;
    }

    // Poll on-chain for a tx that mentions the reference pubkey
    try {
      type SigInfo = { signature: string; err: unknown };
      const sigs = await rpc<SigInfo[]>("getSignaturesForAddress", [
        reference,
        { limit: 5, commitment: "confirmed" },
      ]);

      if (!sigs || sigs.length === 0) { res.json({ status: "pending" }); return; }

      const validSig = sigs.find((s) => s.err === null);
      if (!validSig) { res.json({ status: "pending" }); return; }

      // Fetch the full transaction to verify SOL arrived at the treasury
      type TxResult = {
        transaction: { message: { accountKeys: Array<{ pubkey: string }> } };
        meta: { preBalances: number[]; postBalances: number[]; err: unknown } | null;
      };
      const tx = await rpc<TxResult | null>("getTransaction", [
        validSig.signature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ]);

      if (!tx || tx.meta?.err) { res.json({ status: "pending" }); return; }

      const keys = tx.transaction.message.accountKeys;
      const idx  = keys.findIndex((k) => k.pubkey === TREASURY_ADDRESS);
      if (idx === -1) { res.json({ status: "pending" }); return; }

      const received =
        BigInt(tx.meta!.postBalances[idx]) - BigInt(tx.meta!.preBalances[idx]);
      if (received <= 0n) { res.json({ status: "pending" }); return; }

      // Atomically claim the pending→confirmed transition.
      //
      // The AND status = 'pending' predicate is the idempotency guard against
      // concurrent polls: PostgreSQL's row-lock semantics mean that when two
      // transactions UPDATE the same row simultaneously, the second one blocks
      // until the first commits, then re-evaluates the WHERE clause and finds
      // status = 'confirmed' — returning 0 rows.  Only the winner (claimed.length > 0)
      // proceeds to credit the balance; all others are no-ops.
      let credited = false;
      await db.transaction(async (trx) => {
        const claimed = await trx
          .update(depositsTable)
          .set({ status: "confirmed", txSignature: validSig.signature, confirmedAt: new Date() })
          .where(
            and(
              eq(depositsTable.referencePubkey, reference),
              eq(depositsTable.status, "pending"),
            ),
          )
          .returning({ id: depositsTable.id });

        if (claimed.length === 0) return; // another concurrent request already confirmed

        await trx
          .update(profilesTable)
          .set({
            solBalanceLamports: sql`${profilesTable.solBalanceLamports} + ${deposit.amountLamports}`,
          })
          .where(eq(profilesTable.address, auth.sub));

        credited = true;
      });

      if (credited) {
        logger.info(
          { reference, txSig: validSig.signature, lamports: deposit.amountLamports.toString() },
          "deposits: confirmed",
        );
      } else {
        logger.debug({ reference }, "deposits: already confirmed by concurrent request — skipping credit");
      }

      // Respond confirmed regardless of which request won the race
      res.json({
        status: "confirmed",
        txSignature: validSig.signature,
        creditedLamports: deposit.amountLamports.toString(),
      });
    } catch (err) {
      logger.warn({ err, reference }, "deposits: RPC error during status check");
      // Return pending rather than error — polling will retry
      res.json({ status: "pending" });
    }
  }),
);

export default router;
