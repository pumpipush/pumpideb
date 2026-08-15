/**
 * merge-duplicate-profiles.ts — one-time cleanup of duplicate profile rows.
 *
 * Background
 * ──────────
 * Before the wallet-link fix (2026-08-15), a user who signed in with Google
 * and then connected a wallet extension ended up with two separate profile rows:
 *
 *   1. Social row  — address = UUID, authType = 'google'|'email',
 *                    linkedWallet = <wallet address>
 *   2. Wallet row  — address = <wallet address>, authType = 'wallet'
 *
 * Duplicate pairs are identified by:
 *   social_profile.linkedWallet = wallet_profile.address
 *
 * Merge strategy (per pair)
 * ─────────────────────────
 *   • solBalanceLamports   — SUM (can't lose funds)
 *   • followersCount       — SUM
 *   • followingCount       — SUM
 *   • username             — keep social profile's username (already set by user)
 *   • bio/twitterHandle/websiteUrl/avatarUrl — prefer social's value; fall back to wallet's
 *   • deposits             — re-attributed to social profile BEFORE wallet row is deleted
 *                            (FK has onDelete: cascade — would wipe deposits otherwise)
 *   • trades.traderAddress — plain text, stores on-chain wallet address, NOT a profile PK;
 *                            no migration needed — these remain correct as-is
 *
 * Safety
 * ──────
 *   • Each pair is merged inside a single transaction with SELECT … FOR UPDATE on both
 *     profile rows. This serialises any concurrent balance credits or profile updates
 *     for the duration of the merge — the final balance is computed from the locked,
 *     fresh rows, never from a stale outer read.
 *   • Idempotent: re-running after a partial failure is safe. Already-merged pairs
 *     (wallet row deleted) are simply not found by the initial query; any pair where
 *     one row has disappeared mid-run is detected inside the transaction and skipped.
 *   • Dry-run mode: set DRY_RUN=1 to preview without writing.
 *   • Note on concurrent deposit confirmations: the deposit confirmation path credits
 *     the balance with an UPDATE on the profile identified by deposits.user_address.
 *     Because we re-attribute deposits (step 1 inside the locked transaction) BEFORE
 *     updating the social balance and BEFORE deleting the wallet row, any confirmation
 *     that races in will either: (a) land before our transaction — its credit is
 *     reflected in the locked wallet-row balance we sum, or (b) land after our
 *     transaction — the deposit row now points to the social profile so the credit goes
 *     to the correct row. There is no window where a credit is silently lost.
 *
 * Usage
 * ─────
 *   # Preview (no changes):
 *   DRY_RUN=1 pnpm --filter @workspace/api-server run migrate:merge-duplicate-profiles
 *
 *   # Execute:
 *   pnpm --filter @workspace/api-server run migrate:merge-duplicate-profiles
 */

import { db } from "@workspace/db";
import { profilesTable, depositsTable } from "@workspace/db/schema";
import { eq, sql, inArray } from "drizzle-orm";

const DRY_RUN = process.env.DRY_RUN === "1";

// ── helpers ────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function pickBest(social: string | null | undefined, wallet: string | null | undefined): string | null {
  return social || wallet || null;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  log(`merge-duplicate-profiles starting (DRY_RUN=${DRY_RUN})`);

  // Identify all duplicate pairs.
  // A pair is: social profile with linkedWallet pointing to an existing wallet-primary row.
  // We only fetch addresses here — all field reads happen inside the locked transaction
  // so they are never stale.
  const pairs = await db.execute<{
    social_address: string;
    wallet_address: string;
  }>(sql`
    SELECT
      s.address       AS social_address,
      w.address       AS wallet_address
    FROM profiles s
    JOIN profiles w ON s.linked_wallet = w.address
    WHERE s.auth_type IN ('google', 'email')
      AND w.auth_type = 'wallet'
    ORDER BY s.created_at
  `);

  const rows = pairs.rows;
  log(`Found ${rows.length} duplicate pair(s) to merge`);

  if (rows.length === 0) {
    log("Nothing to do — database is already clean.");
    process.exit(0);
  }

  let merged = 0;
  let skipped = 0;

  for (const row of rows) {
    const socialAddr = row.social_address;
    const walletAddr = row.wallet_address;

    log(`\nPair: social=${socialAddr.slice(0, 8)}… ↔ wallet=${walletAddr.slice(0, 8)}…`);

    if (DRY_RUN) {
      log(`  [DRY_RUN] would merge wallet row into social row, then delete wallet row`);
      skipped++;
      continue;
    }

    try {
      let depositsMoved = 0;

      await db.transaction(async (tx) => {
        // ── Step 0: Lock both rows atomically ────────────────────────────
        // SELECT … FOR UPDATE serialises any concurrent balance credits or
        // profile updates for the duration of this transaction.
        // If either row has disappeared (concurrent merge run), we skip.
        const locked = await tx.execute<{
          address:              string;
          username:             string;
          bio:                  string | null;
          avatar_url:           string | null;
          twitter_handle:       string | null;
          website_url:          string | null;
          followers_count:      number;
          following_count:      number;
          sol_balance_lamports: string; // bigint → string from pg driver
        }>(sql`
          SELECT
            address,
            username,
            bio,
            avatar_url,
            twitter_handle,
            website_url,
            followers_count,
            following_count,
            sol_balance_lamports::text
          FROM profiles
          WHERE address IN (${socialAddr}, ${walletAddr})
          FOR UPDATE
        `);

        const lockedSocial = locked.rows.find(r => r.address === socialAddr);
        const lockedWallet = locked.rows.find(r => r.address === walletAddr);

        if (!lockedSocial || !lockedWallet) {
          log(`  Skipping — one or both rows disappeared (already merged by a concurrent run)`);
          return; // rolls back, but there was nothing to do anyway
        }

        log(`  social username : ${lockedSocial.username}`);
        log(`  wallet username : ${lockedWallet.username}`);
        log(`  social balance  : ${lockedSocial.sol_balance_lamports} lamports`);
        log(`  wallet balance  : ${lockedWallet.sol_balance_lamports} lamports`);

        // Compute merged values from the freshly-locked rows.
        const mergedBalance   = BigInt(lockedSocial.sol_balance_lamports) + BigInt(lockedWallet.sol_balance_lamports);
        const mergedFollowers = (lockedSocial.followers_count ?? 0) + (lockedWallet.followers_count ?? 0);
        const mergedFollowing = (lockedSocial.following_count ?? 0) + (lockedWallet.following_count ?? 0);
        const mergedBio       = pickBest(lockedSocial.bio,          lockedWallet.bio);
        const mergedAvatar    = pickBest(lockedSocial.avatar_url,   lockedWallet.avatar_url);
        const mergedTwitter   = pickBest(lockedSocial.twitter_handle, lockedWallet.twitter_handle);
        const mergedWebsite   = pickBest(lockedSocial.website_url,  lockedWallet.website_url);

        log(`  merged balance  : ${mergedBalance} lamports`);

        // ── Step 1: Re-attribute deposits wallet → social ─────────────
        // MUST happen before deleting wallet row; FK onDelete:cascade
        // would silently wipe any pending deposits otherwise.
        const depositResult = await tx
          .update(depositsTable)
          .set({ userAddress: socialAddr })
          .where(eq(depositsTable.userAddress, walletAddr))
          .returning({ id: depositsTable.id });

        depositsMoved = depositResult.length;
        if (depositsMoved > 0) {
          log(`  Moved ${depositsMoved} deposit(s): wallet → social profile`);
        }

        // ── Step 2: Merge fields into social row ──────────────────────
        await tx
          .update(profilesTable)
          .set({
            solBalanceLamports: mergedBalance,
            followersCount:     mergedFollowers,
            followingCount:     mergedFollowing,
            bio:                mergedBio,
            avatarUrl:          mergedAvatar,
            twitterHandle:      mergedTwitter,
            websiteUrl:         mergedWebsite,
            updatedAt:          new Date(),
          })
          .where(eq(profilesTable.address, socialAddr));

        // ── Step 3: Delete orphaned wallet-primary row ────────────────
        // Deposits have already been re-attributed in step 1, so the
        // cascade will find nothing left to delete.
        await tx
          .delete(profilesTable)
          .where(eq(profilesTable.address, walletAddr));
      });

      log(`  ✓ Merged successfully`);
      merged++;
    } catch (err) {
      log(`  ✗ ERROR merging pair (social=${socialAddr}, wallet=${walletAddr}): ${err}`);
      log(`    Skipping this pair — re-run the script to retry.`);
      skipped++;
    }
  }

  log(`\n── Summary ─────────────────────────────────────`);
  log(`  Total pairs found : ${rows.length}`);
  log(`  Merged            : ${merged}`);
  log(`  Skipped/errors    : ${skipped}`);
  if (DRY_RUN) {
    log(`  (DRY_RUN=1 — no changes were written)`);
  }
  log(`merge-duplicate-profiles complete`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
