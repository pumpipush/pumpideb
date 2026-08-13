-- Add in-app SOL balance to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS sol_balance_lamports BIGINT NOT NULL DEFAULT 0;

-- Track Solana Pay deposit sessions
CREATE TABLE IF NOT EXISTS deposits (
  id SERIAL PRIMARY KEY,
  user_address TEXT NOT NULL REFERENCES profiles(address) ON DELETE CASCADE,
  reference_pubkey TEXT NOT NULL UNIQUE,
  amount_lamports BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_signature TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes')
);

CREATE INDEX IF NOT EXISTS deposits_user_address_idx ON deposits(user_address);
CREATE INDEX IF NOT EXISTS deposits_reference_idx ON deposits(reference_pubkey);
CREATE INDEX IF NOT EXISTS deposits_status_idx ON deposits(status);
