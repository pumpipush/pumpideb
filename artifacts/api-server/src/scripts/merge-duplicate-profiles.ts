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
 *   • Each pair is merged inside a single transaction — atomic, no partial state.
 *   • Idempotent: re-running after a partial failure is safe. Already-merged pairs
 *     (wallet row deleted) are simply not found by the query.
 *   • Dry-run mode: set DRY_RUN=1 to preview without writing.
 *
 * Usage
 * ─────
 *   # Preview (no changes):
 *   DRY_RUN=1 pnpm --filter @workspace/api-server exec ts-node --esm src/scripts/merge-duplicate-profiles.ts
 *
 *   # Execute:
 *   pnpm --filter @workspace/api-server exec ts-node --esm src/scripts/merge-duplicate-profiles.ts
 */

import { db } from "@workspace/db";
import { profilesTable, depositsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

const DRY_RUN = process.env.DRY_RUN === "1";

type Profile = typeof profilesTable.$inferSelect;

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

  // Find all duplicate pairs:
  //   social profile has linkedWallet set → wallet profile with that address exists
  const pairs = await db.execute<{
    social_address:       string;
    social_auth_type:     string;
    social_username:      string;
    social_bio:           string | null;
    social_avatar_url:    string | null;
    social_twitter:       string | null;
    social_website:       string | null;
    social_followers:     number;
    social_following:     number;
    social_balance:       string; // bigint → string from pg driver
    social_linked_wallet: string;
    wallet_address:       string;
    wallet_username:      string;
    wallet_bio:           string | null;
    wallet_avatar_url:    string | null;
    wallet_twitter:       string | null;
    wallet_website:       string | null;
    wallet_followers:     number;
    wallet_following:     number;
    wallet_balance:       string;
  }>(sql`
    SELECT
      s.address            AS social_address,
      s.auth_type          AS social_auth_type,
      s.username           AS social_username,
      s.bio                AS social_bio,
      s.avatar_url         AS social_avatar_url,
      s.twitter_handle     AS social_twitter,
      s.website_url        AS social_website,
      s.followers_count    AS social_followers,
      s.following_count    AS social_following,
      s.sol_balance_lamports::text AS social_balance,
      s.linked_wallet      AS social_linked_wallet,
      w.address            AS wallet_address,
      w.username           AS wallet_username,
      w.bio                AS wallet_bio,
      w.avatar_url         AS wallet_avatar_url,
      w.twitter_handle     AS wallet_twitter,
      w.website_url        AS wallet_website,
      w.followers_count    AS wallet_followers,
      w.following_count    AS wallet_following,
      w.sol_balance_lamports::text AS wallet_balance
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
    const socialAddr  = row.social_address;
    const walletAddr  = row.wallet_address;

    log(`\nPair: social=${socialAddr.slice(0, 8)}… (${row.social_auth_type}) ↔ wallet=${walletAddr.slice(0, 8)}…`);
    log(`  social username : ${row.social_username}`);
    log(`  wallet username : ${row.wallet_username}`);
    log(`  social balance  : ${row.social_balance} lamports`);
    log(`  wallet balance  : ${row.wallet_balance} lamports`);

    // Compute merged values
    const mergedBalance   = BigInt(row.social_balance) + BigInt(row.wallet_balance);
    const mergedFollowers = (row.social_followers ?? 0) + (row.wallet_followers ?? 0);
    const mergedFollowing = (row.social_following ?? 0) + (row.wallet_following ?? 0);
    const mergedBio       = pickBest(row.social_bio,       row.wallet_bio);
    const mergedAvatar    = pickBest(row.social_avatar_url, row.wallet_avatar_url);
    const mergedTwitter   = pickBest(row.social_twitter,    row.wallet_twitter);
    const mergedWebsite   = pickBest(row.social_website,    row.wallet_website);

    log(`  merged balance  : ${mergedBalance} lamports`);

    if (DRY_RUN) {
      log(`  [DRY_RUN] would merge wallet row into social row, then delete wallet row`);
      skipped++;
      continue;
    }

    try {
      // Run everything in a single transaction — atomic, no partial state.
      await db.transaction(async (tx) => {

        // 1. Re-attribute deposits from wallet profile → social profile.
        //    MUST happen before deleting wallet row (FK onDelete: cascade would wipe them).
        const depositResult = await tx
          .update(depositsTable)
          .set({ userAddress: socialAddr })
          .where(eq(depositsTable.userAddress, walletAddr))
          .returning({ id: depositsTable.id });

        if (depositResult.length > 0) {
          log(`  Moved ${depositResult.length} deposit(s) from wallet → social profile`);
        }

        // 2. Merge profile fields into social row.
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

        // 3. Delete the orphaned wallet-primary row.
        //    Cascade will delete any remaining FK-linked data (shouldn't be any after step 1).
        await tx
          .delete(profilesTable)
          .where(eq(profilesTable.address, walletAddr));
      });

      log(`  ✓ Merged successfully`);
      merged++;
    } catch (err) {
      log(`  ✗ ERROR merging pair (social=${socialAddr}, wallet=${walletAddr}): ${err}`);
      log(`    Skipping this pair — run script again to retry.`);
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
