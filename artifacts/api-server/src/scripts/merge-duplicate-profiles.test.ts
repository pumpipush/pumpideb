/**
 * Unit tests for the pure username-selection helpers in merge-duplicate-profiles.ts.
 *
 * No database is touched — the helpers are pure functions.
 */

import { describe, it, expect } from "vitest";
import {
  generateWalletUsername,
  slugifyName,
  isDefaultWalletUsername,
  isDefaultSocialUsername,
  pickBestUsername,
} from "./merge-duplicate-profiles.js";

// A real-ish wallet address (base58, 44 chars) used across tests
const WALLET_ADDR = "BLJtu1AWs6qkFWPJ3UMXgK2RgQSzHBpEuLNFzXt7Yqme";

// Pre-compute the default username this wallet generates so tests stay DRY
const DEFAULT_BASE = slugifyName(generateWalletUsername(WALLET_ADDR));

// ── generateWalletUsername / slugifyName ──────────────────────────────────

describe("generateWalletUsername", () => {
  it("returns a non-empty CamelCase string", () => {
    const raw = generateWalletUsername(WALLET_ADDR);
    expect(raw).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d+$/);
  });

  it("is deterministic — same input always gives same output", () => {
    expect(generateWalletUsername(WALLET_ADDR)).toBe(generateWalletUsername(WALLET_ADDR));
  });

  it("differs for different wallet addresses", () => {
    const other = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    expect(generateWalletUsername(WALLET_ADDR)).not.toBe(generateWalletUsername(other));
  });
});

describe("slugifyName", () => {
  it("lowercases CamelCase without adding underscores for pure alphanumeric input", () => {
    expect(slugifyName("SwiftApe123")).toBe("swiftape123");
  });

  it("converts spaces and punctuation to underscores, deduplicates, and trims them", () => {
    // "John  Smith!" → lowercase "john  smith!" → replace non-alnum with "_" → "john__smith_"
    //   → deduplicate underscores → "john_smith_" → trim trailing "_" → "john_smith"
    expect(slugifyName("John  Smith!")).toBe("john_smith");
  });

  it("trims leading and trailing underscores", () => {
    expect(slugifyName("!hello!")).toBe("hello");
  });

  it("truncates to 20 characters", () => {
    expect(slugifyName("a".repeat(30))).toBe("a".repeat(20));
  });
});

// ── isDefaultWalletUsername ───────────────────────────────────────────────

describe("isDefaultWalletUsername", () => {
  it("returns true for the exact default base", () => {
    expect(isDefaultWalletUsername(DEFAULT_BASE, WALLET_ADDR)).toBe(true);
  });

  it("returns true for the default base with a uniqueness suffix (_NNNN)", () => {
    expect(isDefaultWalletUsername(`${DEFAULT_BASE}_4567`, WALLET_ADDR)).toBe(true);
  });

  it("returns false for a clearly customised username", () => {
    expect(isDefaultWalletUsername("myname", WALLET_ADDR)).toBe(false);
    expect(isDefaultWalletUsername("crypto_wizard", WALLET_ADDR)).toBe(false);
  });

  it("returns false when the username matches another wallet's default", () => {
    const other = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const otherDefault = slugifyName(generateWalletUsername(other));
    // otherDefault is a default for `other`, not for WALLET_ADDR
    expect(isDefaultWalletUsername(otherDefault, WALLET_ADDR)).toBe(false);
  });
});

// ── isDefaultSocialUsername ───────────────────────────────────────────────

describe("isDefaultSocialUsername", () => {
  it("returns true for the UUID fallback pattern", () => {
    expect(isDefaultSocialUsername("user_" + "a".repeat(32))).toBe(true);
    expect(isDefaultSocialUsername("user_1234567890abcdef1234567890abcdef")).toBe(true);
  });

  it("returns false for a name-derived slug", () => {
    expect(isDefaultSocialUsername("john_smith")).toBe(false);
    expect(isDefaultSocialUsername("alice")).toBe(false);
  });

  it("returns false for the wallet-style default (those are handled separately)", () => {
    expect(isDefaultSocialUsername(DEFAULT_BASE)).toBe(false);
  });

  it("returns false for user_ with wrong length", () => {
    expect(isDefaultSocialUsername("user_abc")).toBe(false);
    expect(isDefaultSocialUsername("user_" + "a".repeat(31))).toBe(false);
    expect(isDefaultSocialUsername("user_" + "a".repeat(33))).toBe(false);
  });
});

// ── pickBestUsername ──────────────────────────────────────────────────────

describe("pickBestUsername", () => {
  const UUID_DEFAULT = "user_" + "b".repeat(32); // social UUID fallback

  it("case 1 — wallet custom, social is UUID default → keeps wallet username", () => {
    const result = pickBestUsername(UUID_DEFAULT, "myname", WALLET_ADDR);
    expect(result).toBe("myname");
  });

  it("case 2 — both custom → keeps social username (canonical profile wins)", () => {
    const result = pickBestUsername("john_smith", "myname", WALLET_ADDR);
    expect(result).toBe("john_smith");
  });

  it("case 3 — wallet is default, social is custom → keeps social username", () => {
    const result = pickBestUsername("john_smith", DEFAULT_BASE, WALLET_ADDR);
    expect(result).toBe("john_smith");
  });

  it("case 4 — both default → keeps social username", () => {
    const result = pickBestUsername(UUID_DEFAULT, DEFAULT_BASE, WALLET_ADDR);
    // wallet default + social UUID default → social wins (both were auto-generated)
    expect(result).toBe(UUID_DEFAULT);
  });

  it("wallet default with uniqueness suffix is still treated as default", () => {
    const result = pickBestUsername(UUID_DEFAULT, `${DEFAULT_BASE}_9999`, WALLET_ADDR);
    expect(result).toBe(UUID_DEFAULT);
  });
});
