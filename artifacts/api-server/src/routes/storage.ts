import { Readable } from 'stream';
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from '@workspace/api-zod';
import { Router, type IRouter, type Request, type Response } from 'express';
import { asyncWrap } from '../lib/asyncHandler.js';

import { extractBearer, verifyToken } from '../lib/auth-jwt';
import { ObjectPermission } from '../lib/objectAcl';
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from '../lib/objectStorage';

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// ── Token-image upload constraints ───────────────────────────────────────────
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB — enforced server-side; client check is UX only
// SVG intentionally excluded: it can contain inline scripts executable when rendered in a browser.
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// ── Pending-upload registry ───────────────────────────────────────────────────
// Records which authenticated user requested each object path so that the
// confirm step can enforce same-user ownership.  Node.js is single-threaded,
// so Map operations are atomic.  Entries are single-use (consumed on confirm)
// and expire after 15 minutes to match the presigned URL TTL.
const PENDING_UPLOAD_TTL_MS = 15 * 60 * 1_000; // 15 min

interface PendingUploadEntry {
  sub: string;       // authPayload.sub of the user who requested the URL
  expiresAt: number; // ms epoch
}

const _pendingUploads = new Map<string, PendingUploadEntry>();

// Prune expired entries periodically so the Map doesn't grow unboundedly.
setInterval(() => {
  const now = Date.now();
  for (const [path, entry] of _pendingUploads) {
    if (now > entry.expiresAt) _pendingUploads.delete(path);
  }
}, 60_000).unref();

/** Record a pending upload; must be called immediately after the presigned URL is issued. */
function registerPendingUpload(objectPath: string, sub: string): void {
  _pendingUploads.set(objectPath, { sub, expiresAt: Date.now() + PENDING_UPLOAD_TTL_MS });
}

/**
 * Atomically consume a pending-upload record.
 * Returns true only if the record exists, has not expired, and the confirming
 * user's `sub` matches.  The entry is always deleted on first call
 * (single-use guarantee — prevents re-confirmation by another user).
 */
function consumePendingUpload(objectPath: string, sub: string): boolean {
  const entry = _pendingUploads.get(objectPath);
  _pendingUploads.delete(objectPath); // always remove — single-use
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) return false;
  return entry.sub === sub;
}

// ── Simple in-memory rate limiter ────────────────────────────────────────────
// Max 10 upload URL requests per socket IP per minute.
// Uses socket.remoteAddress only — X-Forwarded-For is not trusted because it
// is trivially spoofable and cannot be relied on for rate-limit enforcement.
const _uploadRateMap = new Map<string, { count: number; windowStart: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 10;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = _uploadRateMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    _uploadRateMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_MAX_REQUESTS) return false;
  entry.count += 1;
  return true;
}

/**
 * POST /storage/uploads/request-url
 *
 * Step 1 of the two-step upload flow: request a presigned GCS PUT URL.
 * Server-side guards:
 *   - Requires a valid JWT (authenticated users only)
 *   - Rate limited to 10 requests per socket IP per minute (not spoofable via headers)
 *   - contentType must be an allowed image MIME type (no SVG)
 *   - Declared size must be ≤ 5 MB
 *
 * The presigned URL expires in 15 minutes. After uploading to GCS, the client
 * MUST call POST /storage/uploads/confirm to verify the object and make it accessible.
 */
router.post(
  '/storage/uploads/request-url',
  asyncWrap(async (req: Request, res: Response) => {
    // Authentication — require a valid JWT
    const token = extractBearer(req.headers.authorization);
    const authPayload = token ? verifyToken(token) : null;
    if (!authPayload) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Rate limiting — use socket IP only; do NOT trust X-Forwarded-For
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!checkRateLimit(ip)) {
      res.status(429).json({ error: 'Too many upload requests — please wait a moment and try again' });
      return;
    }

    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Missing or invalid required fields' });
      return;
    }

    const { name, size, contentType } = parsed.data;

    // Server-side MIME type validation
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      res.status(400).json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed' });
      return;
    }

    // Server-side size validation (client declared; enforced again on confirm)
    if (size > MAX_IMAGE_BYTES) {
      res.status(400).json({ error: `Image must be 5 MB or smaller` });
      return;
    }

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    // Bind this object path to the requesting user before returning the URL.
    // The confirm step will verify and consume this record.
    registerPendingUpload(objectPath, authPayload.sub);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  }),
);

/**
 * POST /storage/uploads/confirm
 *
 * Step 2 of the upload flow: verify the object was actually uploaded to GCS,
 * that its stored content-type is an allowed image type (not a spoofed value),
 * enforce the 5 MB size limit from GCS metadata, then mark it publicly readable.
 *
 * Until this endpoint is called, the object is inaccessible through
 * GET /storage/objects/* (no ACL policy → 403).
 *
 * Returns { objectPath, servingUrl } on success.
 */
router.post(
  '/storage/uploads/confirm',
  asyncWrap(async (req: Request, res: Response) => {
    // Authentication — require a valid JWT
    const token = extractBearer(req.headers.authorization);
    const authPayload = token ? verifyToken(token) : null;
    if (!authPayload) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { objectPath } = req.body as { objectPath?: unknown };

    if (typeof objectPath !== 'string' || !objectPath.startsWith('/objects/')) {
      res.status(400).json({ error: 'Invalid objectPath' });
      return;
    }

    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    // Verify the object actually exists in GCS (upload must have succeeded)
    const [exists] = await objectFile.exists();
    if (!exists) {
      res.status(404).json({ error: 'Upload not found — the file may not have been uploaded yet' });
      return;
    }

    // Read actual GCS-stored metadata — not what the client claims
    const [metadata] = await objectFile.getMetadata();

    // Verify the ACTUAL stored content-type (set by the GCS client from the PUT headers)
    // This catches attackers who PUT text/html but claim image/png in the request body.
    const storedContentType = String(metadata.contentType ?? '');
    if (!ALLOWED_IMAGE_TYPES.has(storedContentType)) {
      // Delete the invalid object to prevent storage waste
      await objectFile.delete().catch(() => {});
      res.status(400).json({ error: 'Uploaded file is not an allowed image type (checked against GCS metadata)' });
      return;
    }

    // Verify actual size ≤ 5 MB from GCS metadata (not client-declared)
    const actualSize = Number(metadata.size ?? 0);
    if (actualSize > MAX_IMAGE_BYTES) {
      await objectFile.delete().catch(() => {});
      res.status(400).json({ error: 'Uploaded file exceeds the 5 MB limit' });
      return;
    }

    // Enforce uploader ownership: consume the pending-upload record and verify
    // the confirming user is the same one who requested the presigned URL.
    // The record is always deleted on this call (single-use) — subsequent
    // confirm attempts for the same path from any user will fail.
    if (!consumePendingUpload(objectPath, authPayload.sub)) {
      res.status(403).json({
        error: 'Upload not authorized — the object path was not issued to your account or the request has expired',
      });
      return;
    }

    // Store the verified content-type alongside the ACL so the serve endpoint
    // can set it explicitly (prevents content-sniffing attacks).
    // Bind the object to the authenticated user who confirmed the upload.
    await objectFile.setMetadata({
      metadata: {
        'custom:aclPolicy': JSON.stringify({ owner: authPayload.sub, visibility: 'public' }),
        'custom:verifiedContentType': storedContentType,
      },
    });

    res.json({ objectPath, servingUrl: `/api/storage${objectPath}` });
  }),
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * Unconditionally public — no authentication or ACL checks.
 */
router.get(
  '/storage/public-objects/*filePath',
  asyncWrap(async (req: Request, res: Response) => {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join('/') : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    // Token images are content-addressed (immutable) — cache aggressively in browser + CDN.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Vary', 'Accept');

    if (response.body) {
      const nodeStream = Readable.fromWeb(
        response.body as ReadableStream<Uint8Array>,
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  }),
);

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * Access is granted ONLY for objects that have been explicitly marked public
 * via POST /storage/uploads/confirm (ACL policy visibility === 'public').
 * All other objects return 403.
 *
 * The response always sets:
 *   - Content-Type: the verified image MIME type stored at confirm time
 *   - X-Content-Type-Options: nosniff   (prevents browser content-sniffing)
 */
router.get('/storage/objects/*path', asyncWrap(async (req: Request, res: Response) => {
  const raw = req.params.path;
  const wildcardPath = Array.isArray(raw) ? raw.join('/') : raw;
  const objectPath = `/objects/${wildcardPath}`;
  const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

  // ACL check: only serve objects explicitly confirmed as public
  const canAccess = await objectStorageService.canAccessObjectEntity({
    objectFile,
    requestedPermission: ObjectPermission.READ,
  });
  if (!canAccess) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  // Read GCS metadata to get the server-verified content type
  const [metadata] = await objectFile.getMetadata();
  const verifiedContentType: string =
    (metadata.metadata?.['custom:verifiedContentType'] as string | undefined) ??
    String(metadata.contentType ?? 'application/octet-stream');

  // Double-check the verified type is still in the allowed set before serving
  if (!ALLOWED_IMAGE_TYPES.has(verifiedContentType)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const response = await objectStorageService.downloadObject(objectFile);

  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));

  // Override Content-Type with the server-verified value and prevent sniffing
  res.setHeader('Content-Type', verifiedContentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (response.body) {
    const nodeStream = Readable.fromWeb(
      response.body as ReadableStream<Uint8Array>,
    );
    nodeStream.pipe(res);
  } else {
    res.end();
  }
}));

export default router;
