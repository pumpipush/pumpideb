ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "email" text UNIQUE;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "google_id" text UNIQUE;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "auth_type" text NOT NULL DEFAULT 'wallet';
