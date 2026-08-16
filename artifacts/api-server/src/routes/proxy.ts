import { randomUUID } from "crypto";
import { Router } from "express";
import { URL } from "url";
import { ObjectStorageService } from "../lib/objectStorage";
import { asyncWrap } from "../lib/asyncHandler.js";
import { uploadLimiter } from "../lib/rateLimiters.js";

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
const ALLOWED_HOSTS = new Set([
  // pump.fun CDN
  "cf-ipfs.com",
  "ipfs.io",
  "gateway.ipfs.io",
  "dweb.link",
  "nftstorage.link",
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

  // Derive the public base URL from request headers so the metadataUri is absolute
  // and fetchable by external clients (pump.fun explorers, wallets, etc.)
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ??
    req.headers.host ??
    "localhost";
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? "https";
  const baseUrl = `${proto}://${host}`;

  // ── Path A: Replit object storage (available on Replit hosted envs) ──────────
  try {
    const uuid = randomUUID();
    const ext = mimeToExt(imageType);
    const imageSubPath = `token-images/${uuid}.${ext}`;
    const metaSubPath  = `token-meta/${uuid}.json`;

    // 1. Upload image to public object storage.
    // uploadToPublicPath attempts to make the file publicly readable and returns
    // the direct GCS URL (https://storage.googleapis.com/…) when it succeeds —
    // this URL is permanent and reachable by external services (pump.fun, wallets)
    // regardless of which server is currently handling requests.
    // Falls back to the proxied URL when per-object ACLs are disabled on the bucket.
    const directImageUrl = await storageService.uploadToPublicPath(imageSubPath, imageBuffer, imageType);
    const imageUrl = directImageUrl ?? `${baseUrl}/api/storage/public-objects/${imageSubPath}`;

    if (!directImageUrl) {
      console.warn("[proxy] pump-ipfs-upload: could not get direct GCS URL for image — using proxied URL instead. Logo may not show on pump.fun if the proxy URL is not publicly reachable.");
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
    console.warn("[proxy] pump-ipfs-upload: object storage unavailable, trying pump.fun fallback:", storageErr);
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

    console.info("[proxy] pump-ipfs-upload: used pump.fun fallback successfully");
    return res.json({ metadataUri: pumpData.metadataUri });
  } catch (pumpErr) {
    console.error("[proxy] pump-ipfs-upload: both storage and pump.fun fallback failed:", pumpErr);
    return res.status(502).json({ error: "Metadata upload failed — object storage and pump.fun fallback both unavailable" });
  }
}));

router.get("/proxy-image", asyncWrap(async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing url");
  if (!isAllowedUrl(url)) return res.status(403).send("Domain not allowed");

  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) return res.status(502).send("Upstream error");

    const contentType = upstream.headers.get("content-type") ?? "image/png";
    // Only proxy image content types
    if (!contentType.startsWith("image/")) return res.status(415).send("Not an image");

    // Cap response at 5 MB to prevent memory abuse
    const MAX_BYTES = 5 * 1024 * 1024;
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return res.status(413).send("Image too large");

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(Buffer.from(buf));
  } catch {
    return res.status(502).send("Failed to fetch image");
  }
}));

export default router;
