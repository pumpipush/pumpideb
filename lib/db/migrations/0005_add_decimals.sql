-- Add SPL token decimal precision to every token record.
-- All current platforms (pump.fun, PumpSwap, Raydium LaunchLab) mint 6-decimal tokens,
-- so DEFAULT 6 is correct for existing rows and for new rows where the adapter doesn't
-- explicitly set a value.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS decimals INTEGER NOT NULL DEFAULT 6;
