-- Migration 0017: Schema hardening — FK, duplicate index cleanup, missing indexes
--
-- 1. Add FK: trades.token_address → tokens.address ON DELETE CASCADE.
--    Ensures referential integrity; cascading delete removes trades automatically
--    when a token is hard-deleted (e.g. moderation removal).
--
--    NOT VALID: skips the expensive full-table validation scan of existing rows
--    (which would take minutes on a large trades table and block the migration).
--    New inserts and ON DELETE CASCADE are still fully enforced immediately.
--    Run `ALTER TABLE trades VALIDATE CONSTRAINT fk_trades_token;` offline
--    (outside a transaction, ideally during a low-traffic window) to back-fill
--    the historical validation without blocking the app.
ALTER TABLE trades
  ADD CONSTRAINT fk_trades_token
  FOREIGN KEY (token_address) REFERENCES tokens(address)
  ON DELETE CASCADE
  NOT VALID;

-- 3. Drop the redundant explicit index on trades.tx_hash.
--    The UNIQUE constraint on tx_hash already creates a B-tree index; the
--    explicit idx_trades_tx_hash added in migration 0004 is a duplicate that
--    wastes write overhead and storage on every INSERT.
DROP INDEX IF EXISTS idx_trades_tx_hash;

-- 4. Add missing indexes on tokens.
--    creator_address: queried in "my launches" / creator profile pages.
--    trade_count: used in ORDER BY / WHERE trade_count > 0 in enrichment and trending.
CREATE INDEX IF NOT EXISTS idx_tokens_creator_address ON tokens (creator_address);
CREATE INDEX IF NOT EXISTS idx_tokens_trade_count     ON tokens (trade_count DESC);

-- Note: full-text ILIKE search on tokens.name / tokens.symbol would benefit from
-- a pg_trgm GIN index, but that requires CREATE EXTENSION pg_trgm and is tracked
-- as a separate task.
