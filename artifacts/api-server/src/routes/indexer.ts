/**
 * GET  /indexer/status  — live status of the onchain indexer
 * POST /indexer/sync    — trigger an immediate block sync (returns new event count)
 */
import { Router, type IRouter } from "express";
import { getIndexerStatus, syncNow } from "../lib/indexer";

const router: IRouter = Router();

router.get("/indexer/status", (_req, res) => {
  res.json(getIndexerStatus());
});

router.post("/indexer/sync", async (_req, res): Promise<void> => {
  try {
    const result = await syncNow();
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ ok: false, error: message });
  }
});

export default router;
