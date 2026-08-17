import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { File, Storage } from '@google-cloud/storage';

import {
  canAccessObject,
  getObjectAclPolicy,
  ObjectAclPolicy,
  ObjectPermission,
  setObjectAclPolicy,
} from './objectAcl';

// ── GCS client configuration ──────────────────────────────────────────────────
//
// Two auth modes are supported:
//
//  1. VPS / standard GCS  — set GOOGLE_APPLICATION_CREDENTIALS to the path of a
//     service account JSON key file. The @google-cloud/storage client picks it up
//     automatically via Application Default Credentials (ADC).
//     Also set GCS_PROJECT_ID to your GCP project ID.
//
//  2. Replit hosted        — no env vars needed. The Replit sidecar at
//     http://127.0.0.1:1106 vends short-lived tokens that the storage client
//     exchanges for GCS credentials transparently.
//
// Which mode is active is determined by whether GOOGLE_APPLICATION_CREDENTIALS is set.

const REPLIT_SIDECAR_ENDPOINT = 'http://127.0.0.1:1106';

const isStandardGcs = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);

export const objectStorageClient = isStandardGcs
  ? // Standard GCS auth — uses GOOGLE_APPLICATION_CREDENTIALS automatically
    new Storage({
      projectId: process.env.GCS_PROJECT_ID ?? '',
    })
  : // Replit-hosted auth — sidecar vends short-lived tokens
    new Storage({
      credentials: {
        audience: 'replit',
        subject_token_type: 'access_token',
        token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
        type: 'external_account',
        credential_source: {
          url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
          format: {
            type: 'json',
            subject_token_field_name: 'access_token',
          },
        },
        universe_domain: 'googleapis.com',
      },
      projectId: '',
    });

export class ObjectNotFoundError extends Error {
  constructor() {
    super('Object not found');
    this.name = 'ObjectNotFoundError';
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || '';
    const paths = Array.from(
      new Set(
        pathsStr
          .split(',')
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      ),
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          'tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths).',
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || '';
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          'tool and set PRIVATE_OBJECT_DIR env var.',
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(
    file: File,
    cacheTtlSec: number = 3600,
  ): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === 'public';

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      'Content-Type':
        (metadata.contentType as string) || 'application/octet-stream',
      'Cache-Control': `${isPublic ? 'public' : 'private'}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers['Content-Length'] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          'tool and set PRIVATE_OBJECT_DIR env var.',
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: 'PUT',
      ttlSec: 900,
    });
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith('/objects/')) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split('/');
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join('/');
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith('/')) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith('https://storage.googleapis.com/')) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith('/')) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith('/')) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  /**
   * Upload a file directly to the first PUBLIC_OBJECT_SEARCH_PATH so it is
   * immediately reachable via GET /api/storage/public-objects/{subPath}.
   *
   * Returns the direct GCS public URL (https://storage.googleapis.com/…) when
   * the object is confirmed publicly accessible via one of two paths:
   *
   *   a) makePublic() succeeds (fine-grained ACL bucket) — the file is given
   *      a public-read ACL and the direct GCS URL is returned.
   *
   *   b) makePublic() fails with a "uniform bucket-level access" error — the
   *      bucket uses IAM-only access, meaning per-object ACLs are disabled.
   *      Replit-provisioned buckets of this type already grant allUsers
   *      storage.objectViewer at the bucket level, so the object is already
   *      publicly reachable at the canonical GCS URL even without a per-object ACL.
   *      The direct GCS URL is returned.
   *
   * Returns null when makePublic() fails for any reason — the caller should
   * fall back to the proxied /api/storage/public-objects URL in that case.
   * Common causes logged at WARN level:
   *  - Uniform bucket-level access (per-object ACLs disabled on the bucket)
   *  - IAM policy does not grant the service account storage.objects.setIamPolicy
   *  - Transient GCS API error
   *
   * Throws when the underlying file.save() fails (GCS auth error, network
   * error, etc.) — the caller is responsible for catching and falling back to
   * an alternative upload path (e.g. pump.fun IPFS).
   *
   * @param subPath      Path under the public prefix, e.g. "token-meta/uuid.json"
   * @param content      File content as a Buffer
   * @param contentType  MIME type stored in GCS metadata
   * @returns Direct GCS URL if the object was confirmed public via ACL, otherwise null
   */
  async uploadToPublicPath(
    subPath: string,
    content: Buffer,
    contentType: string,
  ): Promise<string | null> {
    const paths = this.getPublicObjectSearchPaths();
    // Strip trailing slash; split into '/bucketName/optional/prefix'
    const basePath = paths[0].replace(/\/$/, "");
    const parts = basePath.split("/").filter(Boolean);
    const bucketName = parts[0];
    const prefix = parts.slice(1).join("/");
    const objectName = prefix ? `${prefix}/${subPath}` : subPath;
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    try {
      await file.save(content, { contentType, resumable: false });
    } catch (saveErr) {
      console.error('[objectStorage] uploadToPublicPath: file.save() failed — GCS upload error:', {
        bucketName,
        objectName,
        contentType,
        error: saveErr instanceof Error ? saveErr.message : String(saveErr),
        stack: saveErr instanceof Error ? saveErr.stack : undefined,
      });
      throw saveErr;
    }

    const directUrl = `https://storage.googleapis.com/${bucketName}/${objectName}`;

    // Attempt to grant public-read access via a per-object ACL so external
    // services (pump.fun explorers, wallets) can fetch the image directly from
    // GCS without going through our API proxy.
    // On buckets with uniform bucket-level access enabled this always fails —
    // the caller falls back to serving via the proxied /api/storage/public-objects
    // URL which is always reachable.
    try {
      await file.makePublic();
      console.info('[objectStorage] uploadToPublicPath: file made public via per-object ACL', { directUrl });
      return directUrl;
    } catch (aclErr) {
      const msg = aclErr instanceof Error ? aclErr.message : String(aclErr);
      console.warn(
        '[objectStorage] uploadToPublicPath: makePublic() failed — ' +
        'caller will use proxied /api/storage/public-objects URL instead',
        { error: msg, directUrl },
      );
      return null;
    }
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  const pathParts = path.split('/');
  if (pathParts.length < 3) {
    throw new Error('Invalid path: must contain at least a bucket name');
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join('/');

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`,
    );
  }

  const data = await response.json() as { signed_url: string };
  return data.signed_url;
}
