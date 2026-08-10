-- Add indexes for the most frequently queried columns.
-- Without these, every chart load, trade history fetch, and enrichment loop
-- performs a full table scan — latency grows linearly with DB size.

-- trades: heavily filtered/sorted by token_address + timestamp in every chart/history query
CREATE INDEX IF NOT EXISTS idx_trades_token_address ON trades (token_address);
CREATE INDEX IF NOT EXISTS idx_trades_token_timestamp ON trades (token_address, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_tx_hash ON trades (tx_hash);

-- tokens: sorted/filtered by created_at in trending/new queries and enrichment batches
CREATE INDEX IF NOT EXISTS idx_tokens_created_at ON tokens (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_platform ON tokens (platform);
CREATE INDEX IF NOT EXISTS idx_tokens_graduated ON tokens (graduated);
