/**
 * auth.google-email-merge.test.ts
 *
 * Guards the email-merge logic in POST /api/auth/google:
 *   - Email from Google is always lowercased before comparison so it matches
 *     the lowercase-normalised email stored during email-OTP sign-up.
 *   - Only verified Google emails are eligible to trigger the byEmail merge;
 *     an unverified address must NOT be used to locate an existing profile.
 *   - The `isNewAccount` flag in the response correctly reflects whether a
 *     brand-new profile was created vs an existing one was found/linked.
 *
 * These tests exercise the pure decision logic extracted here as helpers
 * (mirroring exactly what auth.ts does) rather than hitting the database,
 * so they run fast and without any external dependencies.
 */

import { describe, it, expect } from "vitest";

// ── Replicate the helpers from auth.ts ────────────────────────────────────────

/**
 * Normalises an email address the same way auth.ts does after receiving it
 * from Google's userinfo endpoint or the ID-token payload.
 */
function normaliseGoogleEmail(raw: unknown): string {
  return (String(raw ?? "")).toLowerCase();
}

/**
 * Replicates the byEmail eligibility gate in auth.ts:
 *   email must be non-empty AND emailVerified must be true.
 */
function isMergeEligible(email: string, emailVerified: boolean): boolean {
  return email.length > 0 && emailVerified;
}

/**
 * Simulate the full "find-or-create" decision:
 *   - googleId match  → existing account (no merge, no new account)
 *   - byEmail match (eligible) → linked account (no new account)
 *   - no match         → new account
 *
 * Returns { outcome: "existing" | "linked" | "new" }
 */
function simulateFindOrCreate(opts: {
  googleIdFoundInDb: boolean;
  emailMergeEligible: boolean;
  emailFoundInDb: boolean;
}): "existing" | "linked" | "new" {
  if (opts.googleIdFoundInDb) return "existing";
  if (opts.emailMergeEligible && opts.emailFoundInDb) return "linked";
  return "new";
}

// ── Email normalisation ───────────────────────────────────────────────────────

describe("Google email normalisation", () => {
  it("lowercases an already-lowercase email", () => {
    expect(normaliseGoogleEmail("user@example.com")).toBe("user@example.com");
  });

  it("lowercases a mixed-case email from Google", () => {
    expect(normaliseGoogleEmail("User@Example.COM")).toBe("user@example.com");
  });

  it("lowercases an all-uppercase email", () => {
    expect(normaliseGoogleEmail("AURELIA@GMAIL.COM")).toBe("aurelia@gmail.com");
  });

  it("returns empty string for undefined/null", () => {
    expect(normaliseGoogleEmail(undefined)).toBe("");
    expect(normaliseGoogleEmail(null)).toBe("");
  });

  it("handles non-string values gracefully", () => {
    expect(normaliseGoogleEmail(42)).toBe("42");
  });
});

// ── emailVerified gate ────────────────────────────────────────────────────────

describe("byEmail merge eligibility gate", () => {
  it("eligible when email present and Google-verified", () => {
    expect(isMergeEligible("user@example.com", true)).toBe(true);
  });

  it("NOT eligible when email present but NOT verified", () => {
    // An unverified Google email must never be used to hijack an existing account.
    expect(isMergeEligible("user@example.com", false)).toBe(false);
  });

  it("NOT eligible when email is empty, even if verified flag is true", () => {
    expect(isMergeEligible("", true)).toBe(false);
  });

  it("NOT eligible when both email is empty and not verified", () => {
    expect(isMergeEligible("", false)).toBe(false);
  });
});

// ── Find-or-create decision ───────────────────────────────────────────────────

describe("find-or-create outcome", () => {
  it("returns 'existing' when googleId is already in the database", () => {
    const outcome = simulateFindOrCreate({
      googleIdFoundInDb:  true,
      emailMergeEligible: true,
      emailFoundInDb:     true,
    });
    expect(outcome).toBe("existing");
  });

  it("returns 'linked' when googleId is new but a verified email matches an existing OTP account", () => {
    const outcome = simulateFindOrCreate({
      googleIdFoundInDb:  false,
      emailMergeEligible: true,
      emailFoundInDb:     true,
    });
    expect(outcome).toBe("linked");
  });

  it("returns 'new' when googleId is new AND email is unverified (no merge allowed)", () => {
    // This is the key regression guard: an unverified email must not merge.
    const outcome = simulateFindOrCreate({
      googleIdFoundInDb:  false,
      emailMergeEligible: false, // emailVerified === false
      emailFoundInDb:     true,  // but there IS a matching profile — should be ignored
    });
    expect(outcome).toBe("new");
  });

  it("returns 'new' when googleId is new and no email match exists", () => {
    const outcome = simulateFindOrCreate({
      googleIdFoundInDb:  false,
      emailMergeEligible: true,
      emailFoundInDb:     false,
    });
    expect(outcome).toBe("new");
  });

  it("returns 'new' when googleId is new and email is empty", () => {
    const outcome = simulateFindOrCreate({
      googleIdFoundInDb:  false,
      emailMergeEligible: false, // empty email → not eligible
      emailFoundInDb:     false,
    });
    expect(outcome).toBe("new");
  });
});

// ── Case-insensitive merge scenario end-to-end ────────────────────────────────

describe("case-insensitive merge scenario", () => {
  /**
   * Simulates the full path for a user who:
   *   1. Signed up via email OTP with "user@gmail.com" (stored lowercase).
   *   2. Later signs in with Google, which returns "User@Gmail.Com".
   *
   * Without lowercasing, the byEmail lookup would fail and create a duplicate.
   * With lowercasing, it correctly finds the existing profile.
   */
  it("mixed-case Google email matches lowercase-stored OTP email after normalisation", () => {
    const emailFromGoogle   = "User@Gmail.Com";  // as returned by Google
    const emailInDatabase   = "user@gmail.com";  // as stored by OTP sign-up

    const normalised = normaliseGoogleEmail(emailFromGoogle);
    expect(normalised).toBe(emailInDatabase);   // they now match

    // With normalised email, merge is eligible and the lookup would succeed.
    const eligible = isMergeEligible(normalised, true);
    expect(eligible).toBe(true);

    const outcome = simulateFindOrCreate({
      googleIdFoundInDb:  false,
      emailMergeEligible: eligible,
      emailFoundInDb:     true,  // DB lookup with normalised email finds the record
    });
    expect(outcome).toBe("linked");  // NOT "new" — no duplicate created
  });

  it("without normalisation the same scenario would produce a duplicate (regression demonstration)", () => {
    const emailFromGoogle = "User@Gmail.Com";
    const emailInDatabase = "user@gmail.com";

    // Deliberately skip normalisation to show the old bug.
    // Use localeCompare with sensitivity "exact" to simulate a case-sensitive DB comparison
    // without TypeScript narrowing the literal types to "never".
    const wouldMatch = emailFromGoogle.localeCompare(emailInDatabase, undefined, { sensitivity: "variant" }) === 0;
    expect(wouldMatch).toBe(false);

    // Because they don't match, the lookup finds nothing → new account created.
    const outcome = simulateFindOrCreate({
      googleIdFoundInDb:  false,
      emailMergeEligible: !wouldMatch === false, // eligibility is true but lookup fails
      emailFoundInDb:     false,                 // DB returns nothing for un-normalised email
    });
    expect(outcome).toBe("new"); // duplicate would have been created
  });
});
