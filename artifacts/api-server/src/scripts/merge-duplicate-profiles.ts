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
 *   • followersCount       — SUM
 *   • followingCount       — SUM
 *   • username             — keep social profile's username (already set by user)
 *   • bio/twitterHandle/websiteUrl/avatarUrl — prefer social's value; fall back to wallet's
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
import { profilesTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

const DRY_RUN = process.env.DRY_RUN === "1";

// ── pure helpers (exported so they can be unit-tested) ─────────────────────

/**
 * Deterministic adjective+noun username from a wallet address.
 * Must stay in sync with generateWalletUsername() in routes/auth.ts.
 */
export function generateWalletUsername(address: string): string {
  const ADJECTIVES = ["Swift","Neon","Cyber","Lunar","Solar","Cosmic","Dark","Hyper","Turbo","Iron","Laser","Void","Sonic","Alpha","Omega","Nova","Quantum","Pixel","Atomic","Prism","Shadow","Blazing","Golden","Silver","Stealth","Nitro","Rapid","Apex","Ultra","Infra"];
  const NOUNS = ["Ape","Doge","Wolf","Fox","Bear","Eagle","Shark","Tiger","Panda","Hawk","Bull","Lynx","Viper","Cobra","Raven","Drake","Sphinx","Phoenix","Dragon","Jaguar","Falcon","Rhino","Manta","Bison","Badger","Gecko","Mantis","Panther","Raptor","Titan"];
  const s1 = (parseInt(address.slice(2, 10), 16) || 0) >>> 0;
  const s2 = (parseInt(address.slice(-8), 16) || 0) >>> 0;
  const combined = (s1 ^ s2) >>> 0;
  const adj  = ADJECTIVES[combined % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(combined / ADJECTIVES.length) % NOUNS.length];
  const num  = (s1 % 90) + (s2 % 910);
  return `${adj}${noun}${num}`;
}

/** Slugify a display name the same way auth.ts does before storing it. */
export function slugifyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 20);
}

/**
 * Returns true when `username` is the auto-generated default for `walletAddress`
 * (i.e. the user never customised it).
 *
 * The default base is `slugifyName(generateWalletUsername(addr))`, e.g. "swiftape123".
 * uniqueUsername() may have appended a "_NNNN" suffix if the base was already taken,
 * so we also accept "swiftape123_4567" as a default.
 */
export function isDefaultWalletUsername(username: string, walletAddress: string): boolean {
  const base = slugifyName(generateWalletUsername(walletAddress));
  return username === base || username.startsWith(base + "_");
}

/**
 * Returns true when `username` looks like a system-generated social default.
 *
 * The only pattern we can detect reliably at merge time is the full-UUID fallback
 * written by uniqueUsername() when all 10 slug-based attempts are taken:
 *   "user_" + 32 lowercase hex chars
 *
 * Usernames derived from the user's Google display name (e.g. "john_smith") are
 * indistinguishable from a custom choice, so we conservatively treat them as custom.
 */
export function isDefaultSocialUsername(username: string): boolean {
  return /^user_[0-9a-f]{32}$/.test(username);
}

/**
 * Pick the best username to keep on the merged social profile.
 *
 * Rules (in priority order):
 *   1. Wallet username is custom AND social username is the UUID fallback default
 *      → use wallet username (the user actually chose it).
 *   2. Any other combination → keep social username (the canonical profile going forward).
 *
 * We don't try to detect whether a Google-name-derived slug (e.g. "john_smith") is
 * "custom" — it could have been set by the user or auto-generated.  Keeping the social
 * side is the safer default; users can always edit it afterwards.
 */
export function pickBestUsername(
  socialUsername: string,
  walletUsername: string,
  walletAddress: string,
): string {
  const walletIsDefault = isDefaultWalletUsername(walletUsername, walletAddress);
  const socialIsDefault = isDefaultSocialUsername(socialUsername);

  if (!walletIsDefault && socialIsDefault) {
    // Wallet username was customised; social is the UUID fallback → use wallet's
    return walletUsername;
  }
  return socialUsername;
}

// ── private log helper ─────────────────────────────────────────────────────

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
        }>(sql`
          SELECT
            address,
            username,
            bio,
            avatar_url,
            twitter_handle,
            website_url,
            followers_count,
            following_count
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

        // Compute merged values from the freshly-locked rows.
        const mergedFollowers = (lockedSocial.followers_count ?? 0) + (lockedWallet.followers_count ?? 0);
        const mergedFollowing = (lockedSocial.following_count ?? 0) + (lockedWallet.following_count ?? 0);
        const mergedBio       = pickBest(lockedSocial.bio,          lockedWallet.bio);
        const mergedAvatar    = pickBest(lockedSocial.avatar_url,   lockedWallet.avatar_url);
        const mergedTwitter   = pickBest(lockedSocial.twitter_handle, lockedWallet.twitter_handle);
        const mergedWebsite   = pickBest(lockedSocial.website_url,  lockedWallet.website_url);

        // Username: prefer wallet's custom name when social has the UUID fallback default.
        const mergedUsername  = pickBestUsername(lockedSocial.username, lockedWallet.username, walletAddr);
        const usernameSource  = mergedUsername === lockedWallet.username ? "wallet" : "social";

        log(`  merged username : ${mergedUsername} (kept from ${usernameSource})`);

        // ── Step 1: Merge fields into social row ─────────────────────
        await tx
          .update(profilesTable)
          .set({
            username:       mergedUsername,
            followersCount: mergedFollowers,
            followingCount: mergedFollowing,
            bio:            mergedBio,
            avatarUrl:      mergedAvatar,
            twitterHandle:  mergedTwitter,
            websiteUrl:     mergedWebsite,
            updatedAt:      new Date(),
          })
          .where(eq(profilesTable.address, socialAddr));

        // ── Step 2: Delete orphaned wallet-primary row ────────────────
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
