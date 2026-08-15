-- Remove the Solana Pay deposit system (table + in-app balance column).
-- The deposits feature was removed from the codebase; these objects are orphaned.

DROP TABLE IF EXISTS deposits;

ALTER TABLE profiles DROP COLUMN IF EXISTS sol_balance_lamports;
