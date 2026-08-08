-- Migration: add graduated_at column to tokens table
-- Idempotent: safe to run against both fresh and existing databases.
ALTER TABLE "tokens" ADD COLUMN IF NOT EXISTS "graduated_at" timestamp with time zone;
