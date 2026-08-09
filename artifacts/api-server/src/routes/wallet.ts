import { Router, type IRouter } from "express";
import { db, tokensTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
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
router.get("/wallet/:address/portfolio", async (req, res) => {
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
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
