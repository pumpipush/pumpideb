-- Speed up wallet activity queries.
-- Without this, every /api/wallet/:address/activity call does a full table
-- scan of trades before applying LIMIT — gets slower as trades accumulates.
CREATE INDEX IF NOT EXISTS idx_trades_trader_address ON trades (trader_address, timestamp DESC);
