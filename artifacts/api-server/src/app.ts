import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
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

app.use("/api", router);

// ── Global error handler ──────────────────────────────────────────────────
import { globalErrorHandler } from "./lib/errorHandler.js";
app.use(globalErrorHandler);

export default app;
