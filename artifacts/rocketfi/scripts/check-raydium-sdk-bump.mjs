#!/usr/bin/env node
/**
 * check-raydium-sdk-bump.mjs  (#137)
 *
 * Detects when @raydium-io/raydium-sdk-v2 version changes and automatically
 * runs the Raydium LaunchLab smoke test to verify the new SDK still works.
 *
 * Usage
 * ─────
 *   node scripts/check-raydium-sdk-bump.mjs
 *
 * On version match  → exits 0  (skip; already tested)
 * On version change → runs "pnpm test:smoke"; exits 0 on pass, 1 on fail
 * On pass           → writes the new version to .raydium-sdk-tested-version
 *
 * Integrate into your workflow:
 *   • Run after every `pnpm install` (add to postinstall or a pre-push hook)
 *   • Run in CI whenever package.json changes
 *
 * The .raydium-sdk-tested-version file should be committed so the last-known-
 * good version is shared across the team. If the file is missing, the script
 * treats it as "never tested" and runs the smoke test unconditionally.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ── Read current SDK version from package.json ────────────────────────────────
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const currentVersion =
  pkg.dependencies?.["@raydium-io/raydium-sdk-v2"] ??
  pkg.devDependencies?.["@raydium-io/raydium-sdk-v2"];

if (!currentVersion) {
  console.log("ℹ️  @raydium-io/raydium-sdk-v2 not found in package.json — nothing to check.");
  process.exit(0);
}

// ── Compare with last tested version ─────────────────────────────────────────
const versionFile = resolve(root, ".raydium-sdk-tested-version");
const lastTested = existsSync(versionFile)
  ? readFileSync(versionFile, "utf8").trim()
  : null;

if (currentVersion === lastTested) {
  console.log(`✅  Raydium SDK ${currentVersion} — smoke test already passed. Nothing to do.`);
  process.exit(0);
}

console.log(
  `⚡  Raydium SDK version changed: ${lastTested ?? "(none)"} → ${currentVersion}`,
);
console.log("Running LaunchLab smoke test against the new SDK version…\n");

// ── Run the smoke test ────────────────────────────────────────────────────────
try {
  execSync("pnpm test:smoke", {
    cwd:   root,
    stdio: "inherit",
  });
} catch {
  console.error(
    "\n❌  Smoke test FAILED for SDK",
    currentVersion,
    "\n    Do not ship this SDK version until all smoke tests pass.",
    "\n    Fix the issues in raydiumLauncher.ts and re-run this script.",
  );
  process.exit(1);
}

// ── Record the new tested version ────────────────────────────────────────────
writeFileSync(versionFile, currentVersion + "\n", "utf8");
console.log(
  `\n✅  Smoke test PASSED for SDK ${currentVersion}.`,
  "\n    .raydium-sdk-tested-version updated — commit this file.",
);
