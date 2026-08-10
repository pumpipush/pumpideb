---
name: Drizzle migration pitfalls
description: How Drizzle tracks migrations and why raw SQL files added manually sometimes don't run
---

# Drizzle Migration Pitfalls

## Rule
Raw SQL files added to `lib/db/migrations/` AFTER the server last ran migrations won't run until the next server restart — and even then, Drizzle tracks state in `drizzle.__drizzle_migrations` (a DB table), not the meta/journal.json file. If the file content hash already matches a completed migration, it skips it.

**Why:** Drizzle's `migrate()` reads all `.sql` files, hashes their content, and compares against `drizzle.__drizzle_migrations`. Files created and the server restarted in the same window usually work, but changes to the Drizzle schema (`$inferSelect`) propagate immediately to queries — so a column added to schema but not yet in the DB causes runtime errors before the next migration run.

## How to apply
- When adding new schema columns: apply directly via `executeSql()` (in CodeExecution) as a safety net BEFORE restarting the server.
- Also write the migration file so future deployments apply it automatically.
- The meta/journal.json is NOT what Drizzle uses at runtime — it's only for Drizzle Kit tooling.
- Verify the column exists: `SELECT column_name FROM information_schema.columns WHERE table_name='tokens' AND column_name='decimals'`
