-- Store the on-chain metadata URI from the createLaunchpad instruction so the
-- enrichment loop can fall back to it when Raydium's /mint/ids registry hasn't
-- indexed the token yet.  Nullable — only set for raydium_launchlab tokens whose
-- Borsh decode succeeded; null for all other platforms.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS metadata_uri TEXT;
