/**
 * Admin-only routes — protected by the ADMIN_SECRET environment variable.
 *
 * Auth: every request must include the header
 *   X-Admin-Secret: <value of ADMIN_SECRET env var>
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db, tokensTable, tradesTable, profilesTable } from "@workspace/db";
import { sql, desc, ilike, or, eq } from "drizzle-orm";
import { getSolPriceUsd } from "../lib/birdeye.js";
import { asyncWrap } from "../lib/asyncHandler.js";

const router: IRouter = Router();

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAdminSecret(req: Request, res: Response, next: () => void): void {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.status(503).json({ error: "Admin secret not configured on this server." });
    return;
  }
  const provided = req.headers["x-admin-secret"];
  if (!provided || provided !== secret) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  next();
}

// Apply middleware to all /admin/* routes
router.use("/admin", requireAdminSecret);

// ── GET /admin/overview ───────────────────────────────────────────────────────
// One-shot KPI summary for the dashboard home page.

router.get("/admin/overview", asyncWrap(async (_req: Request, res: Response) => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last7d    = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [users, tokens, trades, solPrice] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*)                                                         AS total,
        COUNT(*) FILTER (WHERE auth_type = 'google')                    AS google,
        COUNT(*) FILTER (WHERE auth_type = 'wallet')                    AS wallet,
        COUNT(*) FILTER (WHERE auth_type = 'email')                     AS email,
        COUNT(*) FILTER (WHERE linked_wallet IS NOT NULL)               AS linked,
        COUNT(*) FILTER (WHERE banned_at IS NOT NULL)                   AS banned,
        COUNT(*) FILTER (WHERE created_at >= ${yesterday.toISOString()}) AS last_24h,
        COUNT(*) FILTER (WHERE created_at >= ${last7d.toISOString()})   AS last_7d
      FROM profiles
    `),
    db.execute(sql`
      SELECT
        COUNT(*)                                                         AS total,
        COUNT(*) FILTER (WHERE graduated = true)                        AS graduated,
        COUNT(*) FILTER (WHERE hidden = true)                           AS hidden,
        COUNT(*) FILTER (WHERE platform = 'pump_fun')                   AS pump_fun,
        COUNT(*) FILTER (WHERE platform = 'pumpswap')                   AS pumpswap,
        COUNT(*) FILTER (WHERE platform = 'raydium_launchlab')          AS raydium_launchlab,
        COUNT(*) FILTER (WHERE platform = 'moonshot')                   AS moonshot,
        COUNT(*) FILTER (WHERE platform = 'letsbonk')                   AS letsbonk,
        COUNT(*) FILTER (WHERE created_at >= ${yesterday.toISOString()}) AS last_24h,
        COUNT(*) FILTER (WHERE created_at >= ${last7d.toISOString()})   AS last_7d
      FROM tokens
    `),
    db.execute(sql`
      SELECT
        COUNT(*)                                                              AS total,
        COUNT(*) FILTER (WHERE is_buy = true)                                AS buys,
        COUNT(*) FILTER (WHERE is_buy = false)                               AS sells,
        COUNT(*) FILTER (WHERE timestamp >= ${yesterday.toISOString()})      AS last_24h,
        COALESCE(SUM(eth_amount::numeric), 0)                                AS total_volume_lamports,
        COALESCE(SUM(eth_amount::numeric) FILTER (WHERE timestamp >= ${yesterday.toISOString()}), 0) AS volume_24h_lamports
      FROM trades
    `),
    getSolPriceUsd().catch(() => null),
  ]);

  const u = (users as { rows: Record<string, string>[] }).rows[0];
  const t = (tokens as { rows: Record<string, string>[] }).rows[0];
  const tr = (trades as { rows: Record<string, string>[] }).rows[0];

  const lamToSol = (lam: string) => (Number(lam) / 1e9).toFixed(4);

  res.json({
    users: {
      total:   Number(u.total),
      google:  Number(u.google),
      wallet:  Number(u.wallet),
      email:   Number(u.email),
      linked:  Number(u.linked),
      banned:  Number(u.banned),
      last24h: Number(u.last_24h),
      last7d:  Number(u.last_7d),
    },
    tokens: {
      total:             Number(t.total),
      graduated:         Number(t.graduated),
      hidden:            Number(t.hidden),
      pump_fun:          Number(t.pump_fun),
      pumpswap:          Number(t.pumpswap),
      raydium_launchlab: Number(t.raydium_launchlab),
      moonshot:          Number(t.moonshot),
      letsbonk:          Number(t.letsbonk),
      last24h:           Number(t.last_24h),
      last7d:            Number(t.last_7d),
    },
    trades: {
      total:        Number(tr.total),
      buys:         Number(tr.buys),
      sells:        Number(tr.sells),
      last24h:      Number(tr.last_24h),
      volumeSol:    lamToSol(tr.total_volume_lamports),
      volume24hSol: lamToSol(tr.volume_24h_lamports),
    },
    solPrice,
  });
}));

// ── GET /admin/charts/daily ───────────────────────────────────────────────────
// 30-day time series: new users, new tokens, trade count, volume (SOL).

router.get("/admin/charts/daily", asyncWrap(async (_req: Request, res: Response) => {
  const [userRows, tokenRows, tradeRows] = await Promise.all([
    db.execute(sql`
      SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*) AS count
      FROM profiles
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1 ORDER BY 1
    `),
    db.execute(sql`
      SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*) AS count
      FROM tokens
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1 ORDER BY 1
    `),
    db.execute(sql`
      SELECT
        DATE_TRUNC('day', timestamp)        AS day,
        COUNT(*)                            AS trades,
        COALESCE(SUM(eth_amount::numeric) / 1e9, 0) AS volume_sol
      FROM trades
      WHERE timestamp >= NOW() - INTERVAL '30 days'
      GROUP BY 1 ORDER BY 1
    `),
  ]);

  type DayRow = { day: string; count?: string; trades?: string; volume_sol?: string };
  const uRows  = (userRows  as { rows: DayRow[] }).rows;
  const tRows  = (tokenRows as { rows: DayRow[] }).rows;
  const trRows = (tradeRows as { rows: DayRow[] }).rows;

  // Build a unified day index for last 30 days
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const toMap = (rows: DayRow[], key: "count" | "trades" | "volume_sol") =>
    Object.fromEntries(rows.map(r => [r.day.slice(0, 10), Number(r[key] ?? 0)]));

  const uMap  = toMap(uRows,  "count");
  const tMap  = toMap(tRows,  "count");
  const trMap = toMap(trRows, "trades");
  const vMap  = toMap(trRows, "volume_sol");

  res.json(days.map(d => ({
    date:      d,
    users:     uMap[d]  ?? 0,
    tokens:    tMap[d]  ?? 0,
    trades:    trMap[d] ?? 0,
    volumeSol: vMap[d]  ?? 0,
  })));
}));

// ── GET /admin/users ──────────────────────────────────────────────────────────
// Paginated user list with optional search.

router.get("/admin/users", asyncWrap(async (req: Request, res: Response) => {
  const limit  = Math.min(Number(req.query.limit  ?? 50), 200);
  const offset = Number(req.query.offset ?? 0);
  const search = (req.query.search as string | undefined)?.trim() ?? "";

  const where = search
    ? or(
        ilike(profilesTable.username, `%${search}%`),
        ilike(profilesTable.email, `%${search}%`),
        ilike(profilesTable.address, `%${search}%`),
      )
    : undefined;

  const [rows, countResult] = await Promise.all([
    db.select({
      address:      profilesTable.address,
      username:     profilesTable.username,
      email:        profilesTable.email,
      authType:     profilesTable.authType,
      linkedWallet: profilesTable.linkedWallet,
      createdAt:    profilesTable.createdAt,
      avatarUrl:    profilesTable.avatarUrl,
      bannedAt:     profilesTable.bannedAt,
      banReason:    profilesTable.banReason,
    })
      .from(profilesTable)
      .where(where)
      .orderBy(desc(profilesTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.execute(
      search
        ? sql`SELECT COUNT(*) FROM profiles WHERE username ILIKE ${'%' + search + '%'} OR email ILIKE ${'%' + search + '%'} OR address ILIKE ${'%' + search + '%'}`
        : sql`SELECT COUNT(*) FROM profiles`,
    ),
  ]);

  const total = Number((countResult as { rows: { count: string }[] }).rows[0]?.count ?? 0);
  res.json({ total, rows });
}));

// ── GET /admin/tokens ─────────────────────────────────────────────────────────
// Paginated token list with optional filters.

router.get("/admin/tokens", asyncWrap(async (req: Request, res: Response) => {
  const limit     = Math.min(Number(req.query.limit    ?? 50), 200);
  const offset    = Number(req.query.offset   ?? 0);
  const search    = (req.query.search    as string | undefined)?.trim() ?? "";
  const platform  = (req.query.platform  as string | undefined)?.trim() ?? "";
  const graduated = req.query.graduated === "true"  ? true
                  : req.query.graduated === "false" ? false
                  : undefined;

  const conditions: ReturnType<typeof sql>[] = [];
  if (search)    conditions.push(sql`(t.name ILIKE ${'%' + search + '%'} OR t.symbol ILIKE ${'%' + search + '%'} OR t.address ILIKE ${'%' + search + '%'}`);
  if (platform)  conditions.push(sql`t.platform = ${platform}`);
  if (graduated !== undefined) conditions.push(sql`t.graduated = ${graduated}`);

  const whereClause = conditions.length
    ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
    : sql``;

  // Close open paren if search opened one
  const baseQuery = search
    ? sql`SELECT t.id, t.address, t.name, t.symbol, t.platform, t.graduated, t.market_cap_usd, t.price_usd, t.volume_eth, t.trade_count, t.holder_count, t.creator_address, t.created_at, t.image_url FROM tokens t ${whereClause}) ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`
    : sql`SELECT t.id, t.address, t.name, t.symbol, t.platform, t.graduated, t.market_cap_usd, t.price_usd, t.volume_eth, t.trade_count, t.holder_count, t.creator_address, t.created_at, t.image_url FROM tokens t ${whereClause} ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;

  // Build WHERE conditions for the data query
  const hidden = req.query.hidden === "true"  ? true
               : req.query.hidden === "false" ? false
               : undefined;

  let rows: unknown[];
  const cols = sql`id, address, name, symbol, platform, graduated, hidden, market_cap_usd, price_usd, volume_eth, trade_count, holder_count, creator_address, created_at, image_url`;

  if (search && platform && graduated !== undefined && hidden !== undefined) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE (name ILIKE ${'%' + search + '%'} OR symbol ILIKE ${'%' + search + '%'} OR address ILIKE ${'%' + search + '%'}) AND platform = ${platform} AND graduated = ${graduated} AND hidden = ${hidden} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (search && platform && graduated !== undefined) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE (name ILIKE ${'%' + search + '%'} OR symbol ILIKE ${'%' + search + '%'} OR address ILIKE ${'%' + search + '%'}) AND platform = ${platform} AND graduated = ${graduated} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (search && platform && hidden !== undefined) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE (name ILIKE ${'%' + search + '%'} OR symbol ILIKE ${'%' + search + '%'} OR address ILIKE ${'%' + search + '%'}) AND platform = ${platform} AND hidden = ${hidden} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (search && graduated !== undefined && hidden !== undefined) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE (name ILIKE ${'%' + search + '%'} OR symbol ILIKE ${'%' + search + '%'} OR address ILIKE ${'%' + search + '%'}) AND graduated = ${graduated} AND hidden = ${hidden} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (platform && graduated !== undefined && hidden !== undefined) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE platform = ${platform} AND graduated = ${graduated} AND hidden = ${hidden} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (search && platform) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE (name ILIKE ${'%' + search + '%'} OR symbol ILIKE ${'%' + search + '%'} OR address ILIKE ${'%' + search + '%'}) AND platform = ${platform} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (search && graduated !== undefined) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE (name ILIKE ${'%' + search + '%'} OR symbol ILIKE ${'%' + search + '%'} OR address ILIKE ${'%' + search + '%'}) AND graduated = ${graduated} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (search && hidden !== undefined) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE (name ILIKE ${'%' + search + '%'} OR symbol ILIKE ${'%' + search + '%'} OR address ILIKE ${'%' + search + '%'}) AND hidden = ${hidden} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (platform && graduated !== undefined) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE platform = ${platform} AND graduated = ${graduated} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (platform && hidden !== undefined) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE platform = ${platform} AND hidden = ${hidden} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (graduated !== undefined && hidden !== undefined) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE graduated = ${graduated} AND hidden = ${hidden} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (search) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE name ILIKE ${'%' + search + '%'} OR symbol ILIKE ${'%' + search + '%'} OR address ILIKE ${'%' + search + '%'} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (platform) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE platform = ${platform} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (graduated !== undefined) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE graduated = ${graduated} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else if (hidden !== undefined) {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens WHERE hidden = ${hidden} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  } else {
    rows = (await db.execute(sql`SELECT ${cols} FROM tokens ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)).rows;
  }

  // Count query (simplified)
  let countRows: { count: string }[];
  if (search) {
    countRows = (await db.execute(sql`SELECT COUNT(*) FROM tokens WHERE name ILIKE ${'%' + search + '%'} OR symbol ILIKE ${'%' + search + '%'} OR address ILIKE ${'%' + search + '%'}`)).rows as { count: string }[];
  } else if (platform && graduated !== undefined) {
    countRows = (await db.execute(sql`SELECT COUNT(*) FROM tokens WHERE platform = ${platform} AND graduated = ${graduated}`)).rows as { count: string }[];
  } else if (platform) {
    countRows = (await db.execute(sql`SELECT COUNT(*) FROM tokens WHERE platform = ${platform}`)).rows as { count: string }[];
  } else if (graduated !== undefined) {
    countRows = (await db.execute(sql`SELECT COUNT(*) FROM tokens WHERE graduated = ${graduated}`)).rows as { count: string }[];
  } else {
    countRows = (await db.execute(sql`SELECT COUNT(*) FROM tokens`)).rows as { count: string }[];
  }

  const total = Number(countRows[0]?.count ?? 0);
  res.json({ total, rows });
}));

// ── GET /admin/trades ─────────────────────────────────────────────────────────
// Recent trades across all tokens.

router.get("/admin/trades", asyncWrap(async (req: Request, res: Response) => {
  const limit  = Math.min(Number(req.query.limit  ?? 50), 200);
  const offset = Number(req.query.offset ?? 0);

  const [rows, countResult] = await Promise.all([
    db.select({
      id:          tradesTable.id,
      tokenAddress: tradesTable.tokenAddress,
      tokenName:   tradesTable.tokenName,
      tokenSymbol: tradesTable.tokenSymbol,
      traderAddress: tradesTable.traderAddress,
      isBuy:       tradesTable.isBuy,
      ethAmount:   tradesTable.ethAmount,
      platform:    tradesTable.platform,
      txHash:      tradesTable.txHash,
      timestamp:   tradesTable.timestamp,
    })
      .from(tradesTable)
      .orderBy(desc(tradesTable.timestamp))
      .limit(limit)
      .offset(offset),
    db.execute(sql`SELECT COUNT(*) FROM trades`),
  ]);

  const total = Number((countResult as { rows: { count: string }[] }).rows[0]?.count ?? 0);
  res.json({ total, rows });
}));

// ── POST /admin/users/:address/ban ───────────────────────────────────────────

router.post("/admin/users/:address/ban", asyncWrap(async (req: Request, res: Response) => {
  const { address } = req.params as { address: string };
  const reason = (req.body as { reason?: string })?.reason?.trim() ?? "Banned by admin";

  const rows = await db
    .update(profilesTable)
    .set({ bannedAt: new Date(), banReason: reason })
    .where(eq(profilesTable.address, address))
    .returning({ address: profilesTable.address });

  if (!rows.length) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  res.json({ ok: true, address, bannedAt: rows[0]!.address });
}));

// ── DELETE /admin/users/:address/ban ─────────────────────────────────────────

router.delete("/admin/users/:address/ban", asyncWrap(async (req: Request, res: Response) => {
  const { address } = req.params as { address: string };

  const rows = await db
    .update(profilesTable)
    .set({ bannedAt: null, banReason: null })
    .where(eq(profilesTable.address, address))
    .returning({ address: profilesTable.address });

  if (!rows.length) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  res.json({ ok: true, address });
}));

// ── POST /admin/tokens/:address/hide ─────────────────────────────────────────

router.post("/admin/tokens/:address/hide", asyncWrap(async (req: Request, res: Response) => {
  const { address } = req.params as { address: string };

  const rows = await db
    .update(tokensTable)
    .set({ hidden: true })
    .where(eq(tokensTable.address, address))
    .returning({ address: tokensTable.address });

  if (!rows.length) {
    res.status(404).json({ error: "Token not found." });
    return;
  }
  res.json({ ok: true, address });
}));

// ── DELETE /admin/tokens/:address/hide ───────────────────────────────────────

router.delete("/admin/tokens/:address/hide", asyncWrap(async (req: Request, res: Response) => {
  const { address } = req.params as { address: string };

  const rows = await db
    .update(tokensTable)
    .set({ hidden: false })
    .where(eq(tokensTable.address, address))
    .returning({ address: tokensTable.address });

  if (!rows.length) {
    res.status(404).json({ error: "Token not found." });
    return;
  }
  res.json({ ok: true, address });
}));

// ── GET /admin/fees ───────────────────────────────────────────────────────────
// Top creators by tokens launched + trading volume generated. No on-chain calls.

router.get("/admin/fees", asyncWrap(async (req: Request, res: Response) => {
  const limit  = Math.min(Number(req.query.limit  ?? 50), 200);
  const offset = Number(req.query.offset ?? 0);

  const [leaderboard, totals] = await Promise.all([
    db.execute(sql`
      SELECT
        t.creator_address,
        p.username,
        p.avatar_url,
        COUNT(DISTINCT t.address)::int          AS token_count,
        COALESCE(SUM(t.volume_eth::numeric), 0) AS total_volume_lamports,
        COALESCE(SUM(t.trade_count::numeric), 0)::int AS total_trades,
        COUNT(DISTINCT t.address) FILTER (WHERE t.graduated = true)::int AS graduated_tokens,
        MAX(t.created_at)                       AS last_token_at
      FROM tokens t
      LEFT JOIN profiles p ON p.address = t.creator_address
      GROUP BY t.creator_address, p.username, p.avatar_url
      ORDER BY total_volume_lamports DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute(sql`
      SELECT
        COUNT(DISTINCT creator_address)             AS total_creators,
        COALESCE(SUM(volume_eth::numeric), 0)       AS total_volume_lamports,
        COALESCE(SUM(trade_count::numeric), 0)::int AS total_trades
      FROM tokens
    `),
  ]);

  const t = (totals as { rows: Record<string, string>[] }).rows[0]!;
  res.json({
    totals: {
      creators:      Number(t.total_creators),
      volumeLamports: t.total_volume_lamports,
      volumeSol:     (Number(t.total_volume_lamports) / 1e9).toFixed(4),
      trades:        Number(t.total_trades),
    },
    rows: (leaderboard as { rows: Record<string, unknown>[] }).rows.map(r => ({
      creatorAddress:   r.creator_address,
      username:         r.username ?? null,
      avatarUrl:        r.avatar_url ?? null,
      tokenCount:       Number(r.token_count),
      totalVolumeLamports: String(r.total_volume_lamports),
      totalVolumeSol:   (Number(r.total_volume_lamports) / 1e9).toFixed(4),
      totalTrades:      Number(r.total_trades),
      graduatedTokens:  Number(r.graduated_tokens),
      lastTokenAt:      r.last_token_at,
    })),
  });
}));

// ── GET /admin/fees/creator/:address ─────────────────────────────────────────
// Checks the on-chain pump.fun creator vault balance for a given wallet.

router.get("/admin/fees/creator/:address", asyncWrap(async (req: Request, res: Response) => {
  const { address } = req.params as { address: string };
  try {
    // Proxy to the public creator-fees endpoint logic inline
    const proxyRes = await fetch(
      `http://localhost:${process.env.PORT ?? 8080}/api/creator-fees/${address}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const data = await proxyRes.json();
    res.status(proxyRes.status).json(data);
  } catch {
    res.status(503).json({ error: "RPC unavailable" });
  }
}));

// ── POST /admin/fix-dex-market-caps ─────────────────────────────────────────
// (kept from before) One-time market cap repair for DEX tokens.

router.post("/admin/fix-dex-market-caps", asyncWrap(async (_req: Request, res: Response) => {
  const solPriceUsd = await getSolPriceUsd();
  if (!solPriceUsd || solPriceUsd <= 0) {
    res.status(502).json({ error: "Could not fetch SOL/USD price from Birdeye. Try again in a few seconds." });
    return;
  }
  const result = await db.execute(sql`
    UPDATE tokens
    SET market_cap_eth = ROUND(market_cap_usd / ${solPriceUsd} * 1e9)::text
    WHERE platform IN ('pumpswap', 'raydium_launchlab')
      AND market_cap_usd IS NOT NULL
      AND market_cap_usd > 0
  `);
  const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  res.json({ ok: true, rowsUpdated: rowCount, solPriceUsed: solPriceUsd });
}));

// ── GET /admin/dex-market-cap-stats ─────────────────────────────────────────
// (kept from before) Market cap diagnostic.

router.get("/admin/dex-market-cap-stats", asyncWrap(async (_req: Request, res: Response) => {
  const stats = await db.execute(sql`
    SELECT
      platform,
      COUNT(*)                                                                 AS total,
      COUNT(*) FILTER (WHERE market_cap_usd > 0)                              AS has_mc_usd,
      COUNT(*) FILTER (
        WHERE market_cap_usd > 0
          AND market_cap_eth IS NOT NULL
          AND market_cap_eth != '0'
          AND (market_cap_eth::numeric / market_cap_usd) BETWEEN 5e6 AND 2e7
      )                                                                        AS correct_mc_eth,
      COUNT(*) FILTER (
        WHERE market_cap_usd > 0
          AND market_cap_eth IS NOT NULL
          AND market_cap_eth != '0'
          AND (market_cap_eth::numeric / market_cap_usd) NOT BETWEEN 5e6 AND 2e7
      )                                                                        AS bad_mc_eth,
      AVG(
        CASE
          WHEN market_cap_usd > 0
            AND market_cap_eth IS NOT NULL
            AND market_cap_eth != '0'
            AND (market_cap_eth::numeric / market_cap_usd) BETWEEN 5e6 AND 2e7
          THEN 1e9 / (market_cap_eth::numeric / market_cap_usd)
        END
      )                                                                        AS avg_implied_sol_price
    FROM tokens
    WHERE platform IN ('pumpswap', 'raydium_launchlab')
    GROUP BY platform
    ORDER BY platform
  `);
  res.json({ stats: (stats as unknown as { rows: unknown[] }).rows });
}));

export default router;
