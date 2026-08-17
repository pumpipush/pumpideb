-- Migration 0018: Marker for orphan-trade cleanup deferred to an offline script
--
-- Context: migration 0017 added fk_trades_token with NOT VALID to avoid a
-- full-table scan that would block the server startup migration runner.
-- New inserts are immediately enforced; ON DELETE CASCADE is active.
--
-- The historical cleanup (DELETE orphan rows + VALIDATE CONSTRAINT) is too
-- slow to run inside a startup migration (~2.8M orphan rows on production).
-- It is tracked here for version control and must be completed by running the
-- dedicated offline script:
--
--   pnpm --filter @workspace/api-server run cleanup:orphan-trades
--
-- That script batch-deletes orphans in chunks of 10 000 rows (avoiding long
-- locks), then calls ALTER TABLE trades VALIDATE CONSTRAINT fk_trades_token.

DO $$ BEGIN
  RAISE NOTICE 'fk_trades_token is NOT VALID — run cleanup:orphan-trades to complete validation.';
END $$;
