import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import router from "./routes";
import { logger } from "./lib/logger";

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
// Configure via ALLOWED_ORIGINS env var (comma-separated list of allowed origins).
// Example: ALLOWED_ORIGINS=https://myapp.com,https://www.myapp.com
//
// If ALLOWED_ORIGINS is not set:
//   - In production: logs a warning and allows no cross-origin requests
//   - In development: reflects the request origin (permissive, safe for local dev)
const rawAllowedOrigins = process.env.ALLOWED_ORIGINS;
const allowedOriginList = rawAllowedOrigins
  ? rawAllowedOrigins.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

if (!rawAllowedOrigins && process.env.NODE_ENV === "production") {
  logger.warn(
    "[cors] ALLOWED_ORIGINS is not set. Cross-origin requests will be blocked. " +
    "Set ALLOWED_ORIGINS=https://yourdomain.com to enable frontend access."
  );
}

app.use(
  cors({
    // In dev (no ALLOWED_ORIGINS): reflect any origin so local dev works out of the box.
    // In prod (ALLOWED_ORIGINS set): restrict to the declared list.
    origin: allowedOriginList.length > 0 ? allowedOriginList : (process.env.NODE_ENV === "production" ? false : true),
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
    req.method === "OPTIONS" ||           // never block CORS preflight
    req.path === "/healthz" ||            // never block health checks
    req.path.endsWith("/stream"),         // SSE streams get their own bucket below
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
});

// Apply REST limiter to all /api/* except SSE paths (excluded via skip above).
app.use("/api", restLimiter);

// Apply SSE limiter to both stream endpoints.
app.use("/api/feed/stream", sseLimiter);
app.use("/api/tokens", (req, _res, next) => {
  // Match /api/tokens/:mint/stream only — other token endpoints use the REST bucket.
  if (req.path.endsWith("/stream")) { sseLimiter(req, _res, next); return; }
  next();
});

app.use("/api", router);

// ── Security headers ──────────────────────────────────────────────────────
// Applied after routes so they appear on every response including errors.
// Not using helmet to keep the dependency footprint minimal.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");           // modern browsers ignore this; CSP is the right defence
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

// ── Global error handler ──────────────────────────────────────────────────
import { globalErrorHandler } from "./lib/errorHandler.js";
app.use(globalErrorHandler);

export default app;
