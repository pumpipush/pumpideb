import type { Request, Response, NextFunction } from "express";

/**
 * asyncWrap — explicit async error propagation for Express route handlers.
 *
 * Express 5 propagates rejected async handlers to next(err) automatically,
 * so this wrapper is belt-and-suspenders rather than strictly required. It
 * is applied consistently across all async routes so that:
 *   • The intent "this handler forwards errors to the global handler" is
 *     visible at the call site, not implicit in the runtime version.
 *   • Any future downgrade to Express 4 stays safe without a full audit.
 *
 * The global error-handling middleware in app.ts receives next(err) calls
 * and turns them into a structured JSON 500 response.
 *
 * Usage:
 *   router.get("/path", asyncWrap(async (req, res) => {
 *     const rows = await db.select()...;
 *     res.json(rows);
 *   }));
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function asyncWrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
