-- Migration 0018: Add pg_trgm extension for trigram-based GIN indexes
--
-- The extension itself is created here inside the normal migration transaction.
-- The actual GIN indexes on tokens.name and tokens.symbol are created CONCURRENTLY
-- (outside any transaction) by createTrgmIndexes() called at server startup
-- immediately after runMigrations() completes.
--
-- Using pg_trgm + GIN indexes turns ILIKE '%...%' scans on the tokens table
-- from O(n) sequential scans into O(log n) index lookups, which is critical
-- as the tokens table grows into the hundreds of thousands.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
