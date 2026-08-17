/**
 * Analytics routes
 *
 * Public:
 *   POST /track   — page-view beacon from the frontend (fire-and-forget)
 *
 * Admin-protected (X-Admin-Secret):
 *   GET /admin/analytics          — overview KPIs
 *   GET /admin/analytics/daily    — daily time series
 *   GET /admin/analytics/pages    — top pages
 *   GET /admin/analytics/referrers — top referrers
 *   GET /admin/analytics/devices  — device / browser / OS breakdown
 *   GET /admin/analytics/recent   — recent raw visitor rows
 */

import { createHash } from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { asyncWrap } from "../lib/asyncHandler.js";
import { verifyAdminSecret } from "../lib/auth-jwt.js";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireAdminSecret(req: Request, res: Response, next: () => void): void {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) { res.status(503).json({ error: "Admin secret not configured." }); return; }
  if (!verifyAdminSecret(req.headers["x-admin-secret"], secret)) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  next();
}

function parseUA(ua: string | undefined): { browser: string; os: string; device: string } {
  if (!ua) return { browser: "Unknown", os: "Unknown", device: "Desktop" };

  const browser =
    /Edg\//i.test(ua)                           ? "Edge"    :
    /OPR\/|Opera\//i.test(ua)                    ? "Opera"   :
    /SamsungBrowser/i.test(ua)                    ? "Samsung" :
    /Chrome\/(?!.*Chromium)/i.test(ua)            ? "Chrome"  :
    /Firefox\//i.test(ua)                         ? "Firefox" :
    /Safari\//.test(ua) && /Version\//.test(ua)   ? "Safari"  :
    /MSIE |Trident\//i.test(ua)                   ? "IE"      : "Other";

  const os =
    /Windows NT/i.test(ua)                        ? "Windows" :
    /(iPhone|iPad)/i.test(ua)                     ? "iOS"     :
    /Android/i.test(ua)                           ? "Android" :
    /Mac OS X/i.test(ua)                          ? "macOS"   :
    /Linux/i.test(ua)                             ? "Linux"   : "Other";

  const device =
    /Mobi|Android(?!.*Tablet)|iPhone/i.test(ua)  ? "Mobile"  :
    /iPad|Tablet|PlayBook/i.test(ua)              ? "Tablet"  : "Desktop";

  return { browser, os, device };
}

function getClientIP(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = (Array.isArray(xff) ? xff[0] : xff).split(",")[0].trim();
    if (first) return first;
  }
  return (req.socket as { remoteAddress?: string })?.remoteAddress ?? "";
}

function makeSessionId(ip: string, ua: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${ip}:${ua}:${day}`).digest("hex").slice(0, 16);
}

function rangeInterval(range: string): string {
  switch (range) {
    case "1d":  return "1 day";
    case "7d":  return "7 days";
    case "30d": return "30 days";
    case "90d": return "90 days";
    default:    return "7 days";
  }
}

// ── POST /track ───────────────────────────────────────────────────────────────
// Fire-and-forget beacon from the main app frontend. Returns 204 immediately.

router.post("/track", asyncWrap(async (req: Request, res: Response) => {
  // Respond immediately — tracking must never block the browser.
  res.status(204).end();

  try {
    const { path, referrer, userAddress } = req.body ?? {};
    if (!path || typeof path !== "string") return;

    // ── Field length limits — prevent DB bloat from unbounded inputs ──────────
    // path and referrer: 500 chars is enough for any real URL; truncate silently.
    const safePath = path.slice(0, 500);
    // referrer: same 500-char cap; null out empty/non-string values as before.
    const rawRef = typeof referrer === "string" ? referrer.trim() : "";
    const ref: string | null = rawRef.length > 0 ? rawRef.slice(0, 500) : null;
    // userAddress: Solana base58 addresses are 32–44 chars; discard if too long.
    const safeUserAddress: string | null =
      typeof userAddress === "string" && userAddress.length <= 44
        ? userAddress
        : null;

    const ua   = (req.headers["user-agent"] ?? "").slice(0, 500);
    const ip   = getClientIP(req);
    const sid  = makeSessionId(ip, ua);
    const { browser, os, device } = parseUA(ua);

    await db.execute(sql`
      INSERT INTO page_events (path, referrer, ip, user_agent, browser, os, device, session_id, user_address)
      VALUES (${safePath}, ${ref}, ${ip}, ${ua}, ${browser}, ${os}, ${device}, ${sid}, ${safeUserAddress})
    `);
  } catch {
    // Silently swallow — tracking failure must never surface to the user.
  }
}));

// ── Admin analytics — all protected ──────────────────────────────────────────

router.use("/admin/analytics", requireAdminSecret);

// GET /admin/analytics — KPI overview
router.get("/admin/analytics", asyncWrap(async (req: Request, res: Response) => {
  const interval = rangeInterval(req.query.range as string);

  const [kpi, sessions] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*)                             AS views,
        COUNT(DISTINCT session_id)           AS visitors,
        COUNT(DISTINCT ip)                   AS unique_ips
      FROM page_events
      WHERE ts >= NOW() - ${sql.raw(`INTERVAL '${interval}'`)}
    `),
    db.execute(sql`
      SELECT session_id, COUNT(*) AS pages
      FROM page_events
      WHERE ts >= NOW() - ${sql.raw(`INTERVAL '${interval}'`)}
      GROUP BY session_id
    `),
  ]);

  const k = (kpi as unknown as { rows: Record<string, unknown>[] }).rows[0] ?? {};
  const sessRows = (sessions as unknown as { rows: { pages: string }[] }).rows;
  const total = sessRows.length;
  const bounced = sessRows.filter(r => Number(r.pages) === 1).length;
  const totalPages = sessRows.reduce((a, r) => a + Number(r.pages), 0);

  res.json({
    views:            Number(k.views ?? 0),
    visitors:         Number(k.visitors ?? 0),
    uniqueIPs:        Number(k.unique_ips ?? 0),
    sessions:         total,
    bounceRate:       total > 0 ? Math.round((bounced / total) * 100) : 0,
    avgPages:         total > 0 ? +(totalPages / total).toFixed(1) : 0,
  });
}));

// GET /admin/analytics/daily — views + visitors per day
router.get("/admin/analytics/daily", asyncWrap(async (req: Request, res: Response) => {
  const interval = rangeInterval(req.query.range as string);
  const days = req.query.range === "1d" ? 24 : (req.query.range === "90d" ? 90 : req.query.range === "30d" ? 30 : 7);

  let rows: unknown[];
  if (req.query.range === "1d") {
    // Hourly buckets for 24h
    rows = (await db.execute(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('hour', ts), 'HH24:00') AS bucket,
        COUNT(*)                                    AS views,
        COUNT(DISTINCT session_id)                  AS visitors
      FROM page_events
      WHERE ts >= NOW() - ${sql.raw(`INTERVAL '${interval}'`)}
      GROUP BY DATE_TRUNC('hour', ts)
      ORDER BY DATE_TRUNC('hour', ts)
    `)).rows;
  } else {
    rows = (await db.execute(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('day', ts), 'MM-DD') AS bucket,
        COUNT(*)                                 AS views,
        COUNT(DISTINCT session_id)               AS visitors
      FROM page_events
      WHERE ts >= NOW() - ${sql.raw(`INTERVAL '${interval}'`)}
      GROUP BY DATE_TRUNC('day', ts)
      ORDER BY DATE_TRUNC('day', ts)
    `)).rows;
  }

  res.json(rows);
}));

// GET /admin/analytics/pages — top pages by views
router.get("/admin/analytics/pages", asyncWrap(async (req: Request, res: Response) => {
  const interval = rangeInterval(req.query.range as string);
  const limit = Math.min(Number(req.query.limit ?? 20), 100);

  const [pagesResult, totalResult] = await Promise.all([
    db.execute(sql`
      SELECT path, COUNT(*) AS views
      FROM page_events
      WHERE ts >= NOW() - ${sql.raw(`INTERVAL '${interval}'`)}
      GROUP BY path
      ORDER BY views DESC
      LIMIT ${limit}
    `),
    db.execute(sql`
      SELECT COUNT(*) AS total FROM page_events
      WHERE ts >= NOW() - ${sql.raw(`INTERVAL '${interval}'`)}
    `),
  ]);

  const total = Number((totalResult as unknown as { rows: { total: string }[] }).rows[0]?.total ?? 1);
  const rows = (pagesResult as unknown as { rows: { path: string; views: string }[] }).rows.map(r => ({
    path:  r.path,
    views: Number(r.views),
    pct:   Math.round((Number(r.views) / total) * 100),
  }));

  res.json({ total, rows });
}));

// GET /admin/analytics/referrers — top traffic sources
router.get("/admin/analytics/referrers", asyncWrap(async (req: Request, res: Response) => {
  const interval = rangeInterval(req.query.range as string);
  const limit = Math.min(Number(req.query.limit ?? 20), 100);

  const [refResult, totalResult] = await Promise.all([
    db.execute(sql`
      SELECT
        COALESCE(NULLIF(referrer, ''), 'Direct') AS source,
        COUNT(*) AS visits
      FROM page_events
      WHERE ts >= NOW() - ${sql.raw(`INTERVAL '${interval}'`)}
      GROUP BY source
      ORDER BY visits DESC
      LIMIT ${limit}
    `),
    db.execute(sql`
      SELECT COUNT(*) AS total FROM page_events
      WHERE ts >= NOW() - ${sql.raw(`INTERVAL '${interval}'`)}
    `),
  ]);

  const total = Number((totalResult as unknown as { rows: { total: string }[] }).rows[0]?.total ?? 1);
  const rows = (refResult as unknown as { rows: { source: string; visits: string }[] }).rows.map(r => ({
    source: r.source,
    visits: Number(r.visits),
    pct:    Math.round((Number(r.visits) / total) * 100),
  }));

  res.json({ total, rows });
}));

// GET /admin/analytics/devices — device / browser / OS breakdown
router.get("/admin/analytics/devices", asyncWrap(async (req: Request, res: Response) => {
  const interval = rangeInterval(req.query.range as string);

  const [devResult, brResult, osResult] = await Promise.all([
    db.execute(sql`
      SELECT COALESCE(device, 'Unknown') AS name, COUNT(*) AS value
      FROM page_events WHERE ts >= NOW() - ${sql.raw(`INTERVAL '${interval}'`)}
      GROUP BY name ORDER BY value DESC
    `),
    db.execute(sql`
      SELECT COALESCE(browser, 'Unknown') AS name, COUNT(*) AS value
      FROM page_events WHERE ts >= NOW() - ${sql.raw(`INTERVAL '${interval}'`)}
      GROUP BY name ORDER BY value DESC
    `),
    db.execute(sql`
      SELECT COALESCE(os, 'Unknown') AS name, COUNT(*) AS value
      FROM page_events WHERE ts >= NOW() - ${sql.raw(`INTERVAL '${interval}'`)}
      GROUP BY name ORDER BY value DESC
    `),
  ]);

  const toArr = (r: { rows: { name: string; value: string }[] }) =>
    r.rows.map(x => ({ name: x.name, value: Number(x.value) }));

  res.json({
    devices:  toArr(devResult  as unknown as { rows: { name: string; value: string }[] }),
    browsers: toArr(brResult   as unknown as { rows: { name: string; value: string }[] }),
    os:       toArr(osResult   as unknown as { rows: { name: string; value: string }[] }),
  });
}));

// GET /admin/analytics/recent — raw recent visitor rows (with IP)
router.get("/admin/analytics/recent", asyncWrap(async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);

  const rows = (await db.execute(sql`
    SELECT id, ts, path, referrer, ip, browser, os, device, session_id, user_address
    FROM page_events
    ORDER BY ts DESC
    LIMIT ${limit}
  `)).rows;

  res.json(rows);
}));

export default router;
