/**
 * profiles.follow.idempotent.test.ts
 *
 * Regression guard: sending the same follow request twice must leave
 * followerCount / followingCount at +1, not +2.
 *
 * Root cause: the INSERT uses ON CONFLICT DO NOTHING, so a duplicate request
 * silently skips the INSERT but the counter UPDATE still fires — incrementing
 * the count a second time even though no new follow row was created.
 *
 * Fix: use INSERT … RETURNING and only update counters when a row was actually
 * inserted (returned.length > 0).
 *
 * Strategy: spin up an in-process Express server against the real dev DB,
 * insert ephemeral test profiles, call the follow endpoint twice, then assert
 * counters are exactly 1.  Cleanup runs in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db, profilesTable, followsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import app from "../app.js";

// DB operations on a shared dev DB can be slow under load
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ── Test identities ────────────────────────────────────────────────────────────
// Unique per test run so parallel runs and stale rows don't collide.
const RUN = Date.now().toString(36);
const CALLER_ADDR = `TstFollowCaller${RUN}`.padEnd(44, "1").slice(0, 44);
const TARGET_ADDR = `TstFollowTarget${RUN}`.padEnd(44, "2").slice(0, 44);

// ── Server lifecycle ───────────────────────────────────────────────────────────
let server: Server;
let base: string;

beforeAll(async () => {
  // Insert ephemeral profiles for caller and target.
  // followerCount / followingCount start at 0 (schema default).
  await db
    .insert(profilesTable)
    .values([
      { address: CALLER_ADDR, username: `caller_${RUN}` },
      { address: TARGET_ADDR, username: `target_${RUN}` },
    ])
    .onConflictDoNothing();

  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  // Clean up follow row and profiles (in dependency order).
  await db
    .delete(followsTable)
    .where(
      and(
        eq(followsTable.followerAddress, CALLER_ADDR),
        eq(followsTable.followingAddress, TARGET_ADDR),
      ),
    );
  await db
    .delete(profilesTable)
    .where(eq(profilesTable.address, CALLER_ADDR));
  await db
    .delete(profilesTable)
    .where(eq(profilesTable.address, TARGET_ADDR));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postFollow(): Promise<Response> {
  return fetch(`${base}/profiles/${TARGET_ADDR}/follow`, {
    method: "POST",
    headers: { Authorization: `Wallet ${CALLER_ADDR}` },
  });
}

async function readCounters() {
  const [callerRow] = await db
    .select({ followingCount: profilesTable.followingCount })
    .from(profilesTable)
    .where(eq(profilesTable.address, CALLER_ADDR))
    .limit(1);

  const [targetRow] = await db
    .select({ followersCount: profilesTable.followersCount })
    .from(profilesTable)
    .where(eq(profilesTable.address, TARGET_ADDR))
    .limit(1);

  return {
    followingCount: callerRow?.followingCount ?? -1,
    followersCount: targetRow?.followersCount ?? -1,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /profiles/:address/follow — duplicate-request idempotency", () => {
  it("returns 200 and isFollowing:true on the first follow", async () => {
    const res = await postFollow();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isFollowing: boolean };
    expect(body.isFollowing).toBe(true);
  });

  it("increments followerCount and followingCount by exactly 1 after the first follow", async () => {
    const { followingCount, followersCount } = await readCounters();
    expect(followingCount).toBe(1);
    expect(followersCount).toBe(1);
  });

  it("returns 200 and isFollowing:true when the same follow is sent again", async () => {
    const res = await postFollow();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isFollowing: boolean };
    expect(body.isFollowing).toBe(true);
  });

  it("does NOT increment counters on the duplicate follow — counts stay at 1", async () => {
    const { followingCount, followersCount } = await readCounters();
    // Without the fix both would be 2; the fix ensures they stay at 1.
    expect(followingCount).toBe(1);
    expect(followersCount).toBe(1);
  });

  it("only one follow row exists in the DB after two follow requests", async () => {
    const rows = await db
      .select({ followerAddress: followsTable.followerAddress })
      .from(followsTable)
      .where(
        and(
          eq(followsTable.followerAddress, CALLER_ADDR),
          eq(followsTable.followingAddress, TARGET_ADDR),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
