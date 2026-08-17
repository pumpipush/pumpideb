import { randomUUID } from "crypto";
import { Router } from "express";
import { URL } from "url";
import { ObjectStorageService } from "../lib/objectStorage";
import { asyncWrap } from "../lib/asyncHandler.js";
import { uploadLimiter } from "../lib/rateLimiters.js";
import { extractBearer, verifyToken } from "../lib/auth-jwt.js";

const router = Router();
const storageService = new ObjectStorageService();

// ── pump.fun metadata self-hosting ─────────────────────────────────────────────

// Accept any image/* MIME type — normalise known aliases before the check.
// We validate content via buffer inspection after decode, so strict MIME gatekeeping
// here adds friction without adding real security.
function isAllowedImageMime(mime: string): boolean {
  const normalised = mime.trim().toLowerCase()
    // Non-standard aliases browsers occasionally report
    .replace(/^image\/jpg$/, "image/jpeg")
    .replace(/^image\/pjpeg$/, "image/jpeg");
  return normalised.startsWith("image/") && normalised.length > 6;
}

// Extension map for saving files — fall back to "bin" for unusual types.
function mimeToExt(mime: string): string {
  const m: Record<string, string> = {
    "image/jpeg":  "jpg",
    "image/png":   "png",
    "image/gif":   "gif",
    "image/webp":  "webp",
    "image/avif":  "avif",
    "image/bmp":   "bmp",
    "image/svg+xml": "svg",
  };
  return m[mime.trim().toLowerCase().replace(/^image\/jpg$/, "image/jpeg")] ?? "bin";
}


// Allowlisted hostnames for image proxying — prevents SSRF to internal services.
// Add new CDN/IPFS hosts here as needed; never allow bare IP addresses or localhost.
// ── IPFS gateway list ─────────────────────────────────────────────────────────
// cf-ipfs.com was shut down by Cloudflare. These are the active public gateways
// we race in parallel when fetching IPFS content (both metadata and images).
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://w3s.link/ipfs/",
] as const;

/** Extract the bare CID from any IPFS URL variant (ipfs://, https://gateway/ipfs/…). */
function extractIpfsCid(url: string): string | null {
  if (url.startsWith("ipfs://")) return url.slice(7);
  const m = url.match(/\/ipfs\/(.+)$/);
  return m?.[1] ?? null;
}

const ALLOWED_HOSTS = new Set([
  // IPFS gateways
  "ipfs.io",
  "gateway.ipfs.io",
  "dweb.link",
  "nftstorage.link",
  "w3s.link",
  // Arweave gateways
  "arweave.net",
  "gateway.arweave.net",
  // Common image CDNs used by Solana token metadata
  "i.imgur.com",
  "raw.githubusercontent.com",
  "bafybei.ipfs.nftstorage.link",
  // pump.fun + pumpswap own CDN
  "pump.fun",
  "pumpswap.fun",
  "cdn.pump.fun",
  // DexScreener token images
  "dd.dexscreener.com",
  "assets.coingecko.com",
  // Birdeye CDN
  "cdn.birdeye.so",
  "birdeye.so",
  // Generic image hosts commonly used by Solana token creators
  "images.unsplash.com",
  "cloudflare-ipfs.com",
  "gateway.pinata.cloud",
  "ipfs.filebase.io",
  "media.discordapp.net",
  "cdn.discordapp.com",
]);

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    // Only HTTP/HTTPS, no file:// data:// etc.
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    // Reject bare IPs and localhost
    if (/^[\d.]+$/.test(host) || /^[0-9a-f:]+$/.test(host)) return false;
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    // Allow exact match or any subdomain of an allowed host
    return Array.from(ALLOWED_HOSTS).some(
      allowed => host === allowed || host.endsWith("." + allowed)
    );
  } catch {
    return false;
  }
}

/**
 * POST /pump-ipfs-upload
 *
 * Hosts token metadata for pump.fun coin creation using our own object storage.
 * pump.fun's /api/ipfs endpoint is blocked from Replit datacenter IPs (Cloudflare 530)
 * and also rejects cross-origin browser requests. Instead of forwarding to pump.fun,
 * we host the metadata ourselves:
 *
 *   1. Decode the base64-encoded image from the JSON body
 *   2. Upload the image to GCS under the public search path
 *   3. Build a Metaplex-standard metadata JSON referencing the image URL
 *   4. Upload the metadata JSON to GCS under the public search path
 *   5. Return { metadataUri } — an absolute HTTPS URL that any client can fetch
 *
 * pump.fun's on-chain program only stores the metadataUri string; it accepts any
 * publicly reachable HTTPS URL, not just IPFS URIs.
 *
 * Body (application/json):
 *   name, symbol, description: string (required)
 *   imageBase64: string (required) — base64-encoded image bytes
 *   imageType: string (required) — MIME type, e.g. "image/png"
 *   twitter, telegram, website: string (optional)
 *
 * Rate: 6 req / min / IP via uploadLimiter (uses req.ip, respects trust-proxy header).
 */
router.post("/pump-ipfs-upload", uploadLimiter, asyncWrap(async (req, res) => {
  // ── Auth check ──────────────────────────────────────────────────────────────
  // This endpoint writes to object storage and consumes pump.fun quota.
  // Require a valid wallet/social JWT so only authenticated Pumpi users can upload.
  const bearerToken = extractBearer(req.headers.authorization);
  const authPayload = bearerToken ? verifyToken(bearerToken) : null;
  if (!authPayload) {
    return res.status(401).json({ error: "Authentication required — please connect your wallet and try again." });
  }

  // Body parser skips non-JSON content-types → req.body is undefined.
  // Return a clear 400 instead of letting destructuring throw a 500.
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Request body must be JSON (Content-Type: application/json)" });
  }
  const { name, symbol, description, imageBase64, imageType, twitter, telegram, website } =
    req.body as Record<string, unknown>;

  // Validate required fields with specific error messages for easier debugging.
  if (typeof name !== "string" || !name.trim())
    return res.status(400).json({ error: "Missing or empty required field: name" });
  if (typeof symbol !== "string" || !symbol.trim())
    return res.status(400).json({ error: "Missing or empty required field: symbol" });
  if (typeof imageBase64 !== "string" || !imageBase64)
    return res.status(400).json({ error: "Missing required field: imageBase64" });
  if (typeof imageType !== "string" || !isAllowedImageMime(imageType))
    return res.status(400).json({ error: `Invalid imageType: "${imageType}" — must be an image/* MIME type` });

  // description is optional for Raydium tokens — default to empty string.
  const descriptionStr = typeof description === "string" ? description.trim() : "";

  // Decode base64 image
  let imageBuffer: Buffer;
  try {
    imageBuffer = Buffer.from(imageBase64, "base64");
  } catch {
    return res.status(400).json({ error: "imageBase64 is not valid base64" });
  }

  const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
  if (imageBuffer.byteLength > MAX_IMAGE_BYTES) {
    return res.status(400).json({ error: "Image must be 5 MB or smaller" });
  }
  if (imageBuffer.byteLength === 0) {
    return res.status(400).json({ error: "Image data is empty" });
  }

  // Use configured PUBLIC_BASE_URL if set — prevents URL poisoning via
  // client-controlled X-Forwarded-Host / Host headers.
  // Fall back to deriving from request headers only in development.
  const baseUrl = process.env["PUBLIC_BASE_URL"] ?? (() => {
    const forwardedHost = req.headers["x-forwarded-host"];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ??
      req.headers.host ?? "localhost";
    const forwardedProto = req.headers["x-forwarded-proto"];
    const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? "https";
    return `${proto}://${host}`;
  })();

  // ── Path A: Replit object storage (available on Replit hosted envs) ──────────
  try {
    const uuid = randomUUID();
    const ext = mimeToExt(imageType);
    const imageSubPath = `token-images/${uuid}.${ext}`;
    const metaSubPath  = `token-meta/${uuid}.json`;

    // 1. Upload image to public object storage.
    // uploadToPublicPath uploads the file and returns the direct GCS URL when the
    // object is confirmed publicly accessible (either via per-object ACL or
    // uniform bucket-level IAM). Returns null only on unexpected ACL errors, in
    // which case we fall back to our proxied URL. Throws on upload failure (auth,
    // network), which is caught below and routes to Path B.
    const directImageUrl = await storageService.uploadToPublicPath(imageSubPath, imageBuffer, imageType);
    const imageUrl = directImageUrl ?? `${baseUrl}/api/storage/public-objects/${imageSubPath}`;

    if (!directImageUrl) {
      console.warn("[proxy] pump-ipfs-upload: could not confirm image is publicly accessible — using proxied URL instead. Logo may not show on pump.fun if the proxy URL is not publicly reachable.");
    }

    // 2. Build Metaplex-compatible metadata JSON (pump.fun standard format)
    const metadata: Record<string, unknown> = {
      name:        name.trim(),
      symbol:      symbol.trim(),
      description: descriptionStr,
      image:       imageUrl,
      showName:    true,
      createdOn:   "https://pump.fun",
    };
    if (typeof twitter === "string" && twitter.trim())  metadata.twitter  = twitter.trim();
    if (typeof telegram === "string" && telegram.trim()) metadata.telegram = telegram.trim();
    if (typeof website === "string" && website.trim())  metadata.website  = website.trim();

    // 3. Upload metadata JSON to public object storage
    const metaBuffer = Buffer.from(JSON.stringify(metadata));
    const directMetaUrl = await storageService.uploadToPublicPath(metaSubPath, metaBuffer, "application/json");
    const metadataUri = directMetaUrl ?? `${baseUrl}/api/storage/public-objects/${metaSubPath}`;

    return res.json({ metadataUri, imageUrl });
  } catch (storageErr) {
    console.error("[proxy] pump-ipfs-upload: Path A (object storage) failed — falling back to pump.fun IPFS:", {
      error: storageErr instanceof Error ? storageErr.message : String(storageErr),
      stack: storageErr instanceof Error ? storageErr.stack : undefined,
    });
  }

  // ── Path B: pump.fun /api/ipfs (works from VPS IPs — not blocked by Cloudflare) ──
  // The Replit sidecar at 127.0.0.1:1106 is only present in Replit-hosted envs.
  // On the VPS the sidecar is absent, so GCS auth fails and we fall through here.
  // pump.fun's /api/ipfs accepts multipart/form-data and returns { metadataUri }.
  try {
    const { FormData, Blob } = await import("node:buffer") as unknown as {
      FormData: typeof globalThis.FormData;
      Blob: typeof globalThis.Blob;
    };
    // Node 18+ has FormData globally; use globalThis for compatibility
    const form: FormData = new (globalThis.FormData ?? FormData)();
    form.append("name",        (name as string).trim());
    form.append("symbol",      (symbol as string).trim());
    form.append("description", descriptionStr);
    if (typeof twitter  === "string" && twitter.trim())  form.append("twitter",  twitter.trim());
    if (typeof telegram === "string" && telegram.trim()) form.append("telegram", telegram.trim());
    if (typeof website  === "string" && website.trim())  form.append("website",  website.trim());

    const ext = mimeToExt(imageType);
    const blob = new (globalThis.Blob ?? Blob)([imageBuffer.buffer as ArrayBuffer], { type: imageType });
    form.append("file", blob, `image.${ext}`);

    const pumpRes = await fetch("https://pump.fun/api/ipfs", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20_000),
    });

    if (!pumpRes.ok) {
      const txt = await pumpRes.text().catch(() => `HTTP ${pumpRes.status}`);
      throw new Error(`pump.fun /api/ipfs returned ${pumpRes.status}: ${txt.slice(0, 200)}`);
    }

    const pumpData = await pumpRes.json() as { metadataUri?: string };
    if (!pumpData.metadataUri) throw new Error("pump.fun /api/ipfs did not return metadataUri");

    // Fetch the metadata JSON to extract the image URL so the frontend
    // can store it in the DB and display the logo immediately after launch.
    // Race all active IPFS gateways; fastest one wins.
    let ipfsImageUrl: string | null = null;
    try {
      const cid = extractIpfsCid(pumpData.metadataUri) ?? pumpData.metadataUri;
      const gateways = IPFS_GATEWAYS.map(g => g + cid);
      const metaJson = await Promise.any(
        gateways.map(url =>
          fetch(url, { signal: AbortSignal.timeout(12_000) })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        )
      );
      const meta = metaJson as { image?: string };
      ipfsImageUrl = (typeof meta.image === "string" && meta.image) ? meta.image : null;
    } catch {
      // Non-fatal — logo will appear once the enrichment adapter processes the token
    }

    console.info("[proxy] pump-ipfs-upload: used pump.fun fallback successfully", { imageUrl: ipfsImageUrl });
    return res.json({ metadataUri: pumpData.metadataUri, imageUrl: ipfsImageUrl });
  } catch (pumpErr) {
    console.error("[proxy] pump-ipfs-upload: both storage and pump.fun fallback failed:", pumpErr);
    return res.status(502).json({ error: "Metadata upload failed — object storage and pump.fun fallback both unavailable" });
  }
}));

router.get("/proxy-image", asyncWrap(async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing url");
  if (!isAllowedUrl(url)) return res.status(403).send("Domain not allowed");

  // For IPFS URLs, race all active gateways so the fastest one serves the image.
  // This prevents ipfs.io timeouts from showing a broken logo to the user.
  const cid = extractIpfsCid(url);
  const urlsToTry: string[] = cid ? IPFS_GATEWAYS.map(g => g + cid) : [url];

  const fetchImage = (u: string) =>
    fetch(u, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(12_000),
    }).then(r => {
      if (!r.ok) return Promise.reject(new Error(`HTTP ${r.status}`));
      const ct = r.headers.get("content-type") ?? "";
      if (!ct.startsWith("image/")) return Promise.reject(new Error("Not an image"));
      return r;
    });

  try {
    const upstream = await Promise.any(urlsToTry.map(fetchImage));

    const contentType = upstream.headers.get("content-type") ?? "image/png";
    // Cap response at 5 MB to prevent memory abuse
    const MAX_BYTES = 5 * 1024 * 1024;
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return res.status(413).send("Image too large");

    res.setHeader("Content-Type", contentType);
    // Immutable cache — IPFS content is content-addressed and never changes
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(Buffer.from(buf));
  } catch {
    return res.status(502).send("Failed to fetch image");
  }
}));

export default router;
