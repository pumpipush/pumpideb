-- Migration 0003: add pct_change_24h column to tokens
-- Stores 24-hour price change percentage for DEX tokens (refreshed from Birdeye).
-- pump.fun tokens compute this on-the-fly from the trades table.

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS pct_change_24h DOUBLE PRECISION;
