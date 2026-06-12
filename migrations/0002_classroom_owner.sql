-- Phase 1: classroom ownership. Nullable at the DB level because SQLite cannot
-- add a NOT NULL column without a default, but the application ALWAYS sets it
-- on insert (createClassroom). No backfill: Phase 0 only wrote `users`.
ALTER TABLE classrooms ADD COLUMN created_by TEXT REFERENCES users(id);
