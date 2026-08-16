-- Migration 0016: Follow/follower relationship table
--
-- follows.follower_address — the person doing the following
-- follows.following_address — the person being followed
-- Composite PK prevents duplicate follows.
-- Counters on profiles are maintained in-application (incremented/decremented in transactions).

CREATE TABLE IF NOT EXISTS follows (
  follower_address  TEXT NOT NULL REFERENCES profiles(address) ON DELETE CASCADE,
  following_address TEXT NOT NULL REFERENCES profiles(address) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_address, following_address),
  CHECK (follower_address <> following_address)
);

CREATE INDEX IF NOT EXISTS follows_following_address_idx ON follows (following_address);
