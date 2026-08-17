-- Migration 0019: Durable orphan-cleanup status tracking
--
-- Context: migration 0017 added fk_trades_token (NOT VALID) and migration 0018
-- registered the cleanup requirement. This migration creates a persistent log
-- table so the progress and completion of the offline cleanup script can be
-- tracked durably in the database itself rather than only in server logs.
--
-- How to complete the FK rollout:
--   1. Ensure migration 0017 has applied fk_trades_token (check pg_constraint).
--   2. Run the cleanup script during a low-traffic window:
--        pnpm --filter @workspace/api-server run cleanup:orphan-trades
--      The script batch-deletes orphan trades and then runs VALIDATE CONSTRAINT,
--      writing its progress to _orphan_cleanup_log as it goes.
--   3. Confirm status:
--        SELECT * FROM _orphan_cleanup_log ORDER BY started_at DESC LIMIT 1;
--      A row with validated=true and completed_at set confirms success.

CREATE TABLE IF NOT EXISTS _orphan_cleanup_log (
  id             SERIAL PRIMARY KEY,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ,
  deleted_count  INTEGER,
  validated      BOOLEAN NOT NULL DEFAULT FALSE,
  notes          TEXT
);

-- Insert a pending record so operators know cleanup is required even before
-- the script is run for the first time.
INSERT INTO _orphan_cleanup_log (notes)
SELECT 'PENDING: fk_trades_token is NOT VALID — run cleanup:orphan-trades to delete orphan trades and validate the constraint'
WHERE NOT EXISTS (SELECT 1 FROM _orphan_cleanup_log);
