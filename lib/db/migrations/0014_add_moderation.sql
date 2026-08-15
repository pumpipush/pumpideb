-- Migration: add moderation columns to profiles and tokens
-- Note: no CONCURRENTLY — Drizzle runs migrations inside a transaction.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "banned_at"  timestamp with time zone;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "ban_reason" text;
ALTER TABLE "tokens"   ADD COLUMN IF NOT EXISTS "hidden"     boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "profiles_banned_at_idx" ON "profiles" ("banned_at") WHERE "banned_at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "tokens_hidden_idx"      ON "tokens"   ("hidden")    WHERE "hidden" = true;
