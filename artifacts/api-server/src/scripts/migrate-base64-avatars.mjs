#!/usr/bin/env node
/**
 * migrate-base64-avatars.mjs
 *
 * One-off migration: moves base64 data-URL avatars stored in profiles.avatar_url
 * into object storage and replaces each row with a /api/storage/objects/... serving URL.
 *
 * Idempotent / safe to re-run: once a row is migrated its avatar_url becomes an
 * /api/storage/objects/... path and no longer matches `LIKE 'data:%'`, so it is
 * skipped automatically on every subsequent run.
 *
 * Run:
 *   DATABASE_URL=postgres://... \
 *   PRIVATE_OBJECT_DIR=/<bucket>/... \
 *   node artifacts/api-server/src/scripts/migrate-base64-avatars.mjs
 *
 * Dry-run (report only, no writes):
 *   DRY_RUN=1 DATABASE_URL=... PRIVATE_OBJECT_DIR=... node migrate-base64-avatars.mjs
 */

import { randomUUID } from "crypto";
import pg from "pg";
import { Storage } from "@google-cloud/storage";

const { Pool } = pg;

// ── Config ────────────────────────────────────────────────────────────────────

const DATABASE_URL      = process.env.DATABASE_URL;
const PRIVATE_OBJECT_DIR = process.env.PRIVATE_OBJECT_DIR;
const DRY_RUN           = process.env.DRY_RUN === "1";
const CONCURRENCY       = 4;

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const ALLOWED_CONTENT_TYPES   = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES         = 5 * 1024 * 1024; // 5 MB — matches the upload endpoint limit

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}
if (!PRIVATE_OBJECT_DIR) {
  console.error("ERROR: PRIVATE_OBJECT_DIR environment variable is required");
  process.exit(1);
}

// ── GCS client (mirrors objectStorage.ts) ────────────────────────────────────

const isStandardGcs = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);

const gcsClient = isStandardGcs
  ? new Storage({ projectId: process.env.GCS_PROJECT_ID ?? "" })
  : new Storage({
      credentials: {
        audience: "replit",
        subject_token_type: "access_token",
        token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
        type: "external_account",
        credential_source: {
          url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
          format: { type: "json", subject_token_field_name: "access_token" },
        },
        universe_domain: "googleapis.com",
      },
      projectId: "",
    });

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a GCS path like "/bucketName/optional/prefix" into { bucketName, objectName }.
 */
function parseObjectPath(path) {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  if (parts.length < 3) throw new Error(`Invalid GCS path: ${path}`);
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

/**
 * Decode a data URL into { contentType, buffer }.
 * Returns null if the URL is not a valid base64 data URL.
 */
function decodeDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  const contentType = match[1].toLowerCase().trim();
  const buffer = Buffer.from(match[2], "base64");
  return { contentType, buffer };
}

/**
 * Upload buffer to GCS private object dir and set the ACL so it is publicly
 * readable via GET /api/storage/objects/... — mirrors what the confirm endpoint does.
 *
 * Returns the serving URL, e.g. /api/storage/objects/uploads/<uuid>
 */
async function uploadToObjectStorage(buffer, contentType) {
  const uuid = randomUUID();

  let dir = PRIVATE_OBJECT_DIR;
  if (!dir.endsWith("/")) dir = `${dir}/`;
  const fullPath = `${dir}uploads/${uuid}`;

  const { bucketName, objectName } = parseObjectPath(fullPath);
  const bucket = gcsClient.bucket(bucketName);
  const file   = bucket.file(objectName);

  // Save the raw buffer
  await file.save(buffer, { contentType, resumable: false });

  // Stamp ACL metadata — same fields the confirm endpoint writes
  await file.setMetadata({
    metadata: {
      "custom:aclPolicy": JSON.stringify({ owner: "system-migration", visibility: "public" }),
      "custom:verifiedContentType": contentType,
    },
  });

  // Path that getObjectEntityFile() understands: /objects/<entityId>
  // entityId = everything after PRIVATE_OBJECT_DIR prefix = "uploads/<uuid>"
  return `/api/storage/objects/uploads/${uuid}`;
}

/**
 * Delete an object from GCS given its serving URL (/api/storage/objects/uploads/<uuid>).
 * Used for cleanup when the conditional DB update is skipped due to a concurrent edit.
 */
async function deleteFromObjectStorage(servingUrl) {
  // servingUrl: /api/storage/objects/uploads/<uuid>
  // entityId  : uploads/<uuid>
  const prefix = "/api/storage/objects/";
  if (!servingUrl.startsWith(prefix)) return;
  const entityId = servingUrl.slice(prefix.length); // "uploads/<uuid>"

  let dir = PRIVATE_OBJECT_DIR;
  if (!dir.endsWith("/")) dir = `${dir}/`;
  const fullPath = `${dir}${entityId}`;

  const { bucketName, objectName } = parseObjectPath(fullPath);
  const file = gcsClient.bucket(bucketName).file(objectName);
  await file.delete({ ignoreNotFound: true });
}

// ── Main migration logic ──────────────────────────────────────────────────────

async function migrateProfile(pool, address, dataUrl) {
  const decoded = decodeDataUrl(dataUrl);
  if (!decoded) {
    console.warn(`  [SKIP] ${address}: not a valid base64 data URL`);
    return "skip";
  }

  const { contentType, buffer } = decoded;

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    console.warn(`  [SKIP] ${address}: unsupported content type "${contentType}"`);
    return "skip";
  }

  if (buffer.length === 0) {
    console.warn(`  [SKIP] ${address}: empty image data`);
    return "skip";
  }

  if (buffer.length > MAX_IMAGE_BYTES) {
    console.warn(`  [SKIP] ${address}: image too large (${buffer.length} bytes > ${MAX_IMAGE_BYTES} limit)`);
    return "skip";
  }

  if (DRY_RUN) {
    console.log(`  [DRY]  ${address}: would upload ${buffer.length} bytes (${contentType})`);
    return "dry";
  }

  const servingUrl = await uploadToObjectStorage(buffer, contentType);

  // Compare-and-set: only update the row if avatar_url still holds the exact
  // data URL we read earlier.  This prevents overwriting a newer avatar the
  // user may have uploaded while the migration was running.
  const client = await pool.connect();
  let updated = false;
  try {
    const result = await client.query(
      "UPDATE profiles SET avatar_url = $1, updated_at = NOW() WHERE address = $2 AND avatar_url = $3",
      [servingUrl, address, dataUrl],
    );
    updated = result.rowCount > 0;
  } finally {
    client.release();
  }

  if (!updated) {
    // The row was changed (or deleted) between our SELECT and this UPDATE.
    // Delete the object we just uploaded so it does not become an orphaned
    // public asset that can never be referenced from the database.
    try {
      await deleteFromObjectStorage(servingUrl);
    } catch (cleanupErr) {
      console.warn(`  [WARN] ${address}: conditional update skipped; orphan cleanup failed: ${cleanupErr.message}`);
    }
    console.log(`  [RACE] ${address}: avatar changed before update — skipped (object cleaned up)`);
    return "skip";
  }

  console.log(`  [OK]   ${address}: ${buffer.length} bytes → ${servingUrl}`);
  return "migrated";
}

async function main() {
  console.log(`=== Base64 avatar migration${DRY_RUN ? " (DRY RUN)" : ""} ===\n`);

  const pool = new Pool({ connectionString: DATABASE_URL, max: CONCURRENCY + 2 });

  // Fetch all profiles that still have a data: URL in avatar_url
  const { rows } = await pool.query(`
    SELECT address, avatar_url
    FROM   profiles
    WHERE  avatar_url LIKE 'data:%'
    ORDER BY address
  `);

  console.log(`Found ${rows.length} profile(s) with base64 avatar_url\n`);

  if (rows.length === 0) {
    console.log("Nothing to do.");
    await pool.end();
    return;
  }

  let migrated = 0, skipped = 0, errors = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(({ address, avatar_url }) =>
        migrateProfile(pool, address, avatar_url),
      ),
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "rejected") {
        console.error(`  [ERR]  ${batch[j].address}: ${r.reason?.message ?? r.reason}`);
        errors++;
      } else if (r.value === "migrated") {
        migrated++;
      } else {
        skipped++;
      }
    }

    const done = Math.min(i + CONCURRENCY, rows.length);
    if (done % 20 === 0 || done === rows.length) {
      console.log(`  … ${done}/${rows.length} processed`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n── Summary ───────────────────────────────────────────────────────────");
  console.log(`  Total:    ${rows.length}`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Errors:   ${errors}`);

  if (!DRY_RUN) {
    // Verify no data: URLs remain
    const { rows: remaining } = await pool.query(`
      SELECT COUNT(*) AS n FROM profiles WHERE avatar_url LIKE 'data:%'
    `);
    const n = parseInt(remaining[0].n, 10);
    if (n > 0) {
      console.error(`\nASSERTION FAILED: ${n} profile(s) still have a base64 avatar_url`);
      process.exitCode = 1;
    } else {
      console.log(`\n✓ All base64 avatars have been migrated to object storage`);
    }
  }

  await pool.end();

  if (errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
