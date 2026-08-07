import { Router } from "express";

const router = Router();

router.get("/proxy-image", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing url");

  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) return res.status(502).send("Upstream error");

    const contentType = upstream.headers.get("content-type") ?? "image/png";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    const buf = await upstream.arrayBuffer();
    return res.send(Buffer.from(buf));
  } catch {
    return res.status(502).send("Failed to fetch image");
  }
});

export default router;
