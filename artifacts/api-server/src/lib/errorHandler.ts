import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

/**
 * globalErrorHandler — Express 4-argument error-handling middleware.
 *
 * Receives any error forwarded via next(err) (either explicitly by route code
 * or automatically by Express 5 for rejected async handlers) and returns a
 * structured JSON 500 response with no internal detail exposed to the caller.
 *
 * Exported as a named function so it can be independently unit-tested without
 * importing the full app (which carries DB connections and route mounts).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function globalErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  logger.error({ err }, "unhandled route error");

  if (res.headersSent) {
    // Headers already flushed (e.g. SSE stream opened). Delegate to Express's
    // default termination mechanism rather than trying to write a new response.
    return next(err);
  }

  res.status(500).json({ error: "Internal server error" });
}
