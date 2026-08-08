import { Readable } from 'stream';
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from '@workspace/api-zod';
import { Router, type IRouter, type Request, type Response } from 'express';

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
 *   - Rate limited to 10 requests per socket IP per minute (not spoofable via headers)
 *   - contentType must be an allowed image MIME type (no SVG)
 *   - Declared size must be ≤ 5 MB
 *
 * The presigned URL expires in 15 minutes. After uploading to GCS, the client
 * MUST call POST /storage/uploads/confirm to verify the object and make it accessible.
 */
router.post(
  '/storage/uploads/request-url',
  async (req: Request, res: Response) => {
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

    try {
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, 'Error generating upload URL');
      res.status(500).json({ error: 'Failed to generate upload URL' });
    }
  },
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
  async (req: Request, res: Response) => {
    const { objectPath } = req.body as { objectPath?: unknown };

    if (typeof objectPath !== 'string' || !objectPath.startsWith('/objects/')) {
      res.status(400).json({ error: 'Invalid objectPath' });
      return;
    }

    try {
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

      // Store the verified content-type alongside the ACL so the serve endpoint
      // can set it explicitly (prevents content-sniffing attacks).
      await objectFile.setMetadata({
        metadata: {
          'custom:aclPolicy': JSON.stringify({ owner: 'public', visibility: 'public' }),
          'custom:verifiedContentType': storedContentType,
        },
      });

      res.json({ objectPath, servingUrl: `/api/storage${objectPath}` });
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: 'Object not found' });
        return;
      }
      req.log.error({ err: error }, 'Error confirming upload');
      res.status(500).json({ error: 'Failed to confirm upload' });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * Unconditionally public — no authentication or ACL checks.
 */
router.get(
  '/storage/public-objects/*filePath',
  async (req: Request, res: Response) => {
    try {
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

      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      req.log.error({ err: error }, 'Error serving public object');
      res.status(500).json({ error: 'Failed to serve public object' });
    }
  },
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
router.get('/storage/objects/*path', async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, 'Object not found');
      res.status(404).json({ error: 'Object not found' });
      return;
    }
    req.log.error({ err: error }, 'Error serving object');
    res.status(500).json({ error: 'Failed to serve object' });
  }
});

export default router;
