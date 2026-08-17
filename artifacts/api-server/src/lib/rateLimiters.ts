/**
 * Shared rate limiter instances.
 *
 * Import these in route files to apply per-route limits on top of the global
 * 120 req/min REST limiter defined in app.ts.
 *
 * All limiters use `req.ip` which respects the `trust proxy 1` setting in
 * app.ts so the real client IP is used (not the reverse-proxy address).
 *
 * In test mode (NODE_ENV === 'test', set automatically by vitest) every
 * limiter is bypassed via the `skip` callback.  A single test file can easily
 * make 30+ auth requests in under a second, which would exhaust the 10/min
 * budget and cause unrelated tests to receive 429.  Rate-limiting behaviour
 * is not tested here; it is an infrastructure concern best verified with a
 * dedicated load-testing tool against a staging environment.
 */

import rateLimit from "express-rate-limit";

const IS_TEST = process.env.NODE_ENV === "test";

const MESSAGE_SLOW_DOWN = { error: "Too many requests — please wait a moment and try again." };
const MESSAGE_AUTH      = { error: "Too many authentication attempts — please wait before trying again." };
const MESSAGE_UPLOAD    = { error: "Too many upload requests — wait a moment and try again." };

/**
 * Heavy DB aggregation routes (OHLCV, holders, position, top-wallets,
 * price-history, trade registration).
 *
 * 30 req / min / IP — comfortably above the highest normal polling rate
 * (OHLCV at 8 s = 7.5 req/min per tab; two tabs = 15 req/min) while
 * preventing scripted abuse of full-table aggregations.
 */
export const heavyLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: MESSAGE_SLOW_DOWN,
  skip: () => IS_TEST,
});

/**
 * Auth / OTP endpoints (wallet challenge, wallet login, email send/verify).
 *
 * 10 req / min / IP — well above any legitimate interactive login flow while
 * preventing brute-force enumeration across email addresses.
 * Note: email OTP routes also have per-email in-memory limiters inside the
 * handler (3 sends / 15 min, 10 verify attempts / 15 min) as a second layer.
 */
export const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: MESSAGE_AUTH,
  skip: () => IS_TEST,
});

/**
 * Token image upload endpoint.
 *
 * 6 req / min / IP (≈ 1 per 10 s) — token creation is a deliberate user
 * action, not a polling flow.  Uses req.ip (respects trust proxy) unlike the
 * previous in-process Map which used req.socket.remoteAddress.
 */
export const uploadLimiter = rateLimit({
  windowMs: 60_000,
  max: 6,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: MESSAGE_UPLOAD,
  skip: () => IS_TEST,
});

/**
 * Launch-registration endpoint (POST /tokens/register-launch).
 *
 * 10 req / min / IP — each request triggers a Solana getTransaction RPC call,
 * making it the most expensive unauthenticated endpoint.  10/min allows rapid
 * retries (e.g. tx not yet confirmed) while bounding RPC amplification.
 */
export const launchLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many launch registrations — please wait a moment and try again." },
  skip: () => IS_TEST,
});
