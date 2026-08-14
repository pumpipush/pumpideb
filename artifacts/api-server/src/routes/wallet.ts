import { Router, type IRouter } from "express";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { inArray, eq, desc, sql } from "drizzle-orm";
import { asyncWrap } from "../lib/asyncHandler.js";
import { PUBLICNODE_HTTP, FALLBACK_HTTP_RPCS } from "../lib/adapters/solanaRpcBase";

const router: IRouter = Router();

const ALL_HTTP_RPCS = [PUBLICNODE_HTTP, ...FALLBACK_HTTP_RPCS];

async function rpcPost(method: string, params: unknown[]): Promise<unknown> {
  let lastErr: unknown;
  for (const url of ALL_HTTP_RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8_000),
      });
      const json = (await res.json()) as { result?: unknown; error?: { message: string } };
      if (json.error) throw new Error(json.error.message);
      return json.result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// ── GET /api/wallet/:address/portfolio ─────────────────────────────────────────
// Returns the wallet's SOL balance + SPL token holdings enriched from our DB.
router.get("/wallet/:address/portfolio", asyncWrap(async (req, res) => {
  const { address } = req.params;

  if (!address || address.length < 32) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }

  try {
    // 1. SOL balance
    const balResult = (await rpcPost("getBalance", [
      address,
      { commitment: "confirmed" },
    ])) as { value: number };
    const solBalance = balResult.value / 1e9;

    // 2. SPL token accounts
    const tokenResult = (await rpcPost("getTokenAccountsByOwner", [
      address,
      { programId: TOKEN_PROGRAM_ID },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ])) as {
      value: Array<{
        account: {
          data: {
            parsed: {
              info: {
                mint: string;
                tokenAmount: { uiAmount: number | null; decimals: number };
              };
            };
          };
        };
      }>;
    };

    const nonZero = tokenResult.value
      .map((acc) => ({
        mint: acc.account.data.parsed.info.mint,
        balance: acc.account.data.parsed.info.tokenAmount.uiAmount ?? 0,
        decimals: acc.account.data.parsed.info.tokenAmount.decimals,
      }))
      .filter((t) => t.balance > 0);

    // 3. Enrich from our DB
    type DbRow = {
      address: string;
      name: string | null;
      symbol: string | null;
      imageUrl: string | null;
      priceEth: string | null;
      marketCapEth: string | null;
    };
    let byMint: Record<string, DbRow> = {};

    if (nonZero.length > 0) {
      const mints = nonZero.map((t) => t.mint);
      const rows: DbRow[] = await db
        .select({
          address: tokensTable.address,
          name: tokensTable.name,
          symbol: tokensTable.symbol,
          imageUrl: tokensTable.imageUrl,
          priceEth: tokensTable.priceEth,
          marketCapEth: tokensTable.marketCapEth,
        })
        .from(tokensTable)
        .where(inArray(tokensTable.address, mints));

      for (const row of rows) byMint[row.address] = row;
    }

    const tokens = nonZero
      .map((t) => {
        const meta = byMint[t.mint];
        const priceSol = meta?.priceEth ? parseFloat(meta.priceEth) : null;
        return {
          mint: t.mint,
          balance: t.balance,
          decimals: t.decimals,
          name: meta?.name ?? null,
          symbol: meta?.symbol ?? null,
          imageUrl: meta?.imageUrl ?? null,
          marketCapEth: meta?.marketCapEth ?? null,
          priceSol,
          valueSol: priceSol !== null ? t.balance * priceSol : null,
          inDb: !!meta,
        };
      })
      // sort by value desc, known tokens first
      .sort((a, b) => {
        if (a.valueSol !== null && b.valueSol !== null) return b.valueSol - a.valueSol;
        if (a.valueSol !== null) return -1;
        if (b.valueSol !== null) return 1;
        return 0;
      });

    res.json({ solBalance, tokens });
  } catch (err) {
    // Log the detail server-side but never expose it to the caller.
    console.error("[portfolio] fetch failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}));

// ── GET /api/wallet/:address/activity ──────────────────────────────────────────
// Returns the trade history for a specific wallet address directly from the DB.
// Unlike /stats/recent-activity (which fetches global latest N rows and relies on
// the caller to filter), this endpoint queries WHERE trader_address = :address so
// the result is always wallet-specific, regardless of global trade volume.
router.get("/wallet/:address/activity", asyncWrap(async (req, res) => {
  const address = String(req.params["address"] ?? "");
  const rawLimit = parseInt(String(req.query["limit"] ?? "100"), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 100;

  if (!address || address.length < 32) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }

  const activity = await db
    .select({
      id:               tradesTable.id,
      tokenAddress:     tradesTable.tokenAddress,
      // Trade-level snapshot (may be null for older rows)
      _tradeName:       tradesTable.tokenName,
      _tradeSymbol:     tradesTable.tokenSymbol,
      // Live tokens-table data (preferred when the token is in our DB)
      _tokenName:       tokensTable.name,
      _tokenSymbol:     tokensTable.symbol,
      tokenImageUrl:    tokensTable.imageUrl,
      traderAddress:    tradesTable.traderAddress,
      isBuy:            tradesTable.isBuy,
      ethAmount:        tradesTable.ethAmount,
      tokenAmount:      tradesTable.tokenAmount,
      txHash:           tradesTable.txHash,
      timestamp:        tradesTable.timestamp,
    })
    .from(tradesTable)
    .leftJoin(tokensTable, sql`${tradesTable.tokenAddress} = ${tokensTable.address}`)
    .where(eq(tradesTable.traderAddress, address))
    .orderBy(desc(tradesTable.timestamp))
    .limit(limit);

  res.json(
    activity.map(({ _tradeName, _tradeSymbol, _tokenName, _tokenSymbol, ...a }) => ({
      ...a,
      // Prefer the live tokens-table value; fall back to the trade snapshot.
      // Use || not ?? so empty-string values also fall through.
      tokenName:   _tokenName   || _tradeName   || "Unknown",
      tokenSymbol: _tokenSymbol || _tradeSymbol || "?",
    })),
  );
}));

// ── GET /api/wallet/:address/created-tokens ─────────────────────────────────
// Returns all tokens whose creator_address matches, ordered by trade count desc.
router.get("/wallet/:address/created-tokens", asyncWrap(async (req, res) => {
  const { address } = req.params;
  if (!address || address.length < 32) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }
  const tokens = await db
    .select({
      address:      tokensTable.address,
      name:         tokensTable.name,
      symbol:       tokensTable.symbol,
      imageUrl:     tokensTable.imageUrl,
      marketCapEth: tokensTable.marketCapEth,
      tradeCount:   tokensTable.tradeCount,
      platform:     tokensTable.platform,
      graduated:    tokensTable.graduated,
    })
    .from(tokensTable)
    .where(eq(tokensTable.creatorAddress, String(address)))
    .orderBy(desc(tokensTable.tradeCount))
    .limit(200);
  res.json(tokens);
}));

export default router;
