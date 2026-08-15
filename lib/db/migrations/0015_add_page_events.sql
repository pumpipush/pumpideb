-- Migration: create page_events table for website analytics
-- Stores per-page-view events emitted by the frontend tracking beacon.
CREATE TABLE IF NOT EXISTS "page_events" (
  "id"           SERIAL PRIMARY KEY,
  "ts"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "path"         TEXT NOT NULL,
  "referrer"     TEXT,
  "ip"           TEXT,
  "user_agent"   TEXT,
  "browser"      TEXT,
  "os"           TEXT,
  "device"       TEXT,
  "session_id"   TEXT,
  "user_address" TEXT
);
CREATE INDEX IF NOT EXISTS "page_events_ts_idx"      ON "page_events" ("ts" DESC);
CREATE INDEX IF NOT EXISTS "page_events_session_idx" ON "page_events" ("session_id");
CREATE INDEX IF NOT EXISTS "page_events_path_idx"    ON "page_events" ("path");
CREATE INDEX IF NOT EXISTS "page_events_ip_idx"      ON "page_events" ("ip");
