-- ============================================================
-- RocketFi — Full Database Setup Script
-- Run once on a fresh PostgreSQL database.
-- Idempotent: safe to re-run (uses IF NOT EXISTS / IF NOT EXISTS).
-- ============================================================

-- ── tokens ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tokens (
  id                      SERIAL PRIMARY KEY,
  address                 TEXT NOT NULL UNIQUE,
  name                    TEXT NOT NULL,
  symbol                  TEXT NOT NULL,
  description             TEXT,
  image_url               TEXT,
  creator_address         TEXT NOT NULL,
  virtual_token_reserves  TEXT NOT NULL DEFAULT '0',
  virtual_eth_reserves    TEXT NOT NULL DEFAULT '0',
  real_token_reserves     TEXT NOT NULL DEFAULT '0',
  real_eth_reserves       TEXT NOT NULL DEFAULT '0',
  total_supply            TEXT NOT NULL DEFAULT '0',
  market_cap_eth          TEXT,
  price_eth               TEXT,
  graduated               BOOLEAN NOT NULL DEFAULT FALSE,
  graduated_at            TIMESTAMPTZ,
  volume_eth              TEXT NOT NULL DEFAULT '0',
  trade_count             NUMERIC NOT NULL DEFAULT '0',
  holder_count            NUMERIC NOT NULL DEFAULT '0',
  twitter_url             TEXT,
  telegram_url            TEXT,
  website_url             TEXT,
  platform                TEXT NOT NULL DEFAULT 'unknown',
  chain                   TEXT NOT NULL DEFAULT 'solana',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- DEX columns (multi-DEX support)
  pool_address            TEXT,
  quote_mint              TEXT,
  liquidity_usd           DOUBLE PRECISION,
  price_usd               DOUBLE PRECISION,
  market_cap_usd          DOUBLE PRECISION,
  pct_change_24h          DOUBLE PRECISION,
  decimals                INTEGER NOT NULL DEFAULT 6,
  metadata_uri            TEXT
);

-- ── trades ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id             SERIAL PRIMARY KEY,
  token_address  TEXT NOT NULL,
  token_name     TEXT,
  token_symbol   TEXT,
  trader_address TEXT NOT NULL,
  is_buy         BOOLEAN NOT NULL,
  eth_amount     TEXT NOT NULL,
  token_amount   TEXT NOT NULL,
  price_eth      TEXT,
  tx_hash        TEXT NOT NULL UNIQUE,
  platform       TEXT NOT NULL DEFAULT 'unknown',
  timestamp      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── profiles ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  address             TEXT PRIMARY KEY,
  username            TEXT NOT NULL UNIQUE,
  bio                 TEXT,
  avatar_url          TEXT,
  twitter_handle      TEXT,
  website_url         TEXT,
  followers_count     INTEGER NOT NULL DEFAULT 0,
  following_count     INTEGER NOT NULL DEFAULT 0,
  email               TEXT UNIQUE,
  google_id           TEXT UNIQUE,
  auth_type           TEXT NOT NULL DEFAULT 'wallet',
  linked_wallet       TEXT UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tokens_pool_address        ON tokens (pool_address);
CREATE INDEX IF NOT EXISTS idx_tokens_platform            ON tokens (platform);
CREATE INDEX IF NOT EXISTS idx_tokens_graduated           ON tokens (graduated);
CREATE INDEX IF NOT EXISTS idx_tokens_created_at          ON tokens (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_token_address       ON trades (token_address);
CREATE INDEX IF NOT EXISTS idx_trades_token_timestamp     ON trades (token_address, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_tx_hash             ON trades (tx_hash);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp           ON trades (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp_token     ON trades (timestamp DESC, token_address);

-- ── done ─────────────────────────────────────────────────────
DO $$ BEGIN
  RAISE NOTICE 'Database setup complete. Tables: tokens, trades, profiles.';
END $$;
