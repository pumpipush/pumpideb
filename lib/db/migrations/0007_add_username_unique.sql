-- Enforce username uniqueness at the DB level so no two profiles can claim
-- the same handle, even under concurrent requests.
-- Uses IF NOT EXISTS so re-running the migration is safe.
ALTER TABLE profiles ADD CONSTRAINT profiles_username_unique UNIQUE (username);
