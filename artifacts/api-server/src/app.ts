import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import router from "./routes";
import { logger } from "./lib/logger";
import { imageLimiter } from "./lib/rateLimiters";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ── CORS ──────────────────────────────────────────────────────────────────────
// Configure via ALLOWED_ORIGINS env var (comma-separated explicit origin list).
// Example: ALLOWED_ORIGINS=https://pumpi.io,https://www.pumpi.io
//
// Origin resolution priority:
//   1. ALLOWED_ORIGINS set → use that list exactly (production and staging)
//   2. NODE_ENV === "production" → block all cross-origin (fail-safe: env var must be set)
//   3. Otherwise (local dev / Replit preview) → allowlist of safe known patterns:
//        - http(s)://localhost:<port>
//        - http(s)://127.0.0.1:<port>
//        - https://*.replit.dev  (Replit dev preview domains)
//        - https://*.replit.app  (Replit published app domains)
//        - https://*.repl.co     (older Replit domains)
//      This is intentionally NOT `origin: true` (reflect-any) to prevent an
//      attacker-controlled page from reading credentialed responses on staging.
const rawAllowedOrigins = process.env.ALLOWED_ORIGINS;
const allowedOriginList = rawAllowedOrigins
  ? rawAllowedOrigins.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

// Patterns that are safe for non-production without an explicit allowlist.
const DEV_ORIGIN_PATTERNS: RegExp[] = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/[a-z0-9-]+\.replit\.dev$/,
  /^https:\/\/[a-z0-9-]+\.replit\.app$/,
  /^https:\/\/[a-z0-9-]+\.repl\.co$/,
];

type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;

function resolveOrigin(origin: string | undefined, callback: CorsOriginCallback): void {
  if (!origin) {
    // Non-browser request (curl, server-to-server) — no Origin header, allow.
    callback(null, true);
    return;
  }

  if (allowedOriginList.length > 0) {
    // Explicit allowlist wins (production and configured staging).
    callback(null, allowedOriginList.includes(origin));
    return;
  }

  if (process.env.NODE_ENV === "production") {
    // Production with no ALLOWED_ORIGINS configured: block everything cross-origin.
    // This is a fail-safe — set ALLOWED_ORIGINS in production deployments.
    callback(null, false);
    return;
  }

  // Dev/preview: check against known-safe patterns only.
  const allowed = DEV_ORIGIN_PATTERNS.some((re) => re.test(origin));
  callback(null, allowed);
}

// Log resolved CORS config at startup for auditability.
if (allowedOriginList.length > 0) {
  logger.info({ origins: allowedOriginList }, "[cors] explicit allowlist");
} else if (process.env.NODE_ENV === "production") {
  logger.warn(
    "[cors] ALLOWED_ORIGINS is not set in production — all cross-origin requests will be blocked. " +
    "Set ALLOWED_ORIGINS=https://pumpi.io to enable frontend access.",
  );
} else {
  logger.info("[cors] dev mode — allowing localhost and *.replit.dev/app origins");
}

app.use(
  cors({
    origin: resolveOrigin,
    credentials: true,
  }),
);

// 10 MB limit to accommodate base64-encoded token images in pump-ipfs-upload
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Trust the first reverse-proxy hop (Replit / nginx / Cloudflare) so the real
// client IP is read from X-Forwarded-For instead of the proxy's address.
app.set("trust proxy", 1);

// REST endpoints — 120 req / minute per IP.
// Note: our own frontend polls at ~64 req/min on an active token page, so a
// 60/min limit would 429 normal users. 120/min stops scrapers/bots while
// keeping the UI responsive even with two tabs open simultaneously.
const restLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: "draft-7", // Return RateLimit-Policy / RateLimit headers
  legacyHeaders: false,
  message: { error: "Too many requests — please wait a moment and try again." },
  skip: (req) =>
    process.env.NODE_ENV === "test" ||    // bypass in test — suites easily exceed 120 req/min
    req.method === "OPTIONS" ||           // never block CORS preflight
    req.path === "/healthz" ||            // never block health checks
    req.path.endsWith("/stream") ||       // SSE streams get their own bucket below
    req.path === "/proxy-image",          // images get their own dedicated bucket below
});

// SSE stream endpoints — much tighter (10 opens / minute per IP).
// Each SSE connection is long-lived and counts only once when it opens, so
// 10/min allows comfortable reconnect cycles while blocking connection-flood attacks.
const sseLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many stream connections — please wait before reconnecting." },
  skip: () => process.env.NODE_ENV === "test",
});

// Apply REST limiter to all /api/* except SSE paths and image proxy (excluded via skip above).
app.use("/api", restLimiter);

// Image proxy gets its own generous bucket (600/min) so dashboard image loads
// don't eat into the data-endpoint quota (trades, holders, etc.).
app.use("/api/proxy-image", imageLimiter);

// Apply SSE limiter to both stream endpoints.
app.use("/api/feed/stream", sseLimiter);
app.use("/api/tokens", (req, _res, next) => {
  // Match /api/tokens/:mint/stream only — other token endpoints use the REST bucket.
  if (req.path.endsWith("/stream")) { sseLimiter(req, _res, next); return; }
  next();
});

// Challenge endpoint — very tight limit (10 nonces / minute per IP).
// This endpoint is public/unauthenticated by design, so without a dedicated
// limit a script could flood the in-memory nonce store between prune cycles.
const challengeLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res, _next, options) => {
    const retryAfterSecs = Math.ceil(options.windowMs / 1000);
    res.setHeader("Retry-After", String(retryAfterSecs));
    res.status(options.statusCode).json({
      error: "Too many challenge requests — please wait a minute and try again.",
    });
  },
  skip: (req) => process.env.NODE_ENV === "test" || req.method === "OPTIONS",
});
app.post("/api/profiles/challenge", challengeLimiter);

// ── Security headers ──────────────────────────────────────────────────────
// Registered BEFORE app.use("/api", router) so every successful response
// gets these headers. Route handlers call res.json() without calling next(),
// so a post-route middleware would be bypassed for successful responses.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");           // modern browsers ignore this; CSP is the right defence
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.use("/api", router);

// ── Global error handler ──────────────────────────────────────────────────
import { globalErrorHandler } from "./lib/errorHandler.js";
app.use(globalErrorHandler);

export default app;
