-- Migration: add DEX-specific columns for multi-DEX indexer support.
--
-- pool_address   — the DEX pool/pair address (Raydium pool, Orca whirlpool, etc.)
-- quote_mint     — the quote token of the pair (WSOL, USDC, etc.)
-- liquidity_usd  — pool liquidity in USD at time of discovery
-- price_usd      — latest price in USD (updated by Raydium poller / Birdeye)
-- market_cap_usd — latest market cap in USD

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS pool_address TEXT;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS quote_mint TEXT;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS liquidity_usd DOUBLE PRECISION;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS price_usd DOUBLE PRECISION;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS market_cap_usd DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS idx_tokens_pool_address ON tokens(pool_address);
CREATE INDEX IF NOT EXISTS idx_tokens_platform ON tokens(platform);
