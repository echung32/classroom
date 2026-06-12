-- Phase 3: drop the unused grace window, and reshape `submissions` for lazy
-- deadline evaluation. `submissions` was created in 0001 but is not read or
-- written by any code yet, so this is plain DDL on an empty table.

ALTER TABLE assignments DROP COLUMN grace_minutes;

ALTER TABLE submissions RENAME COLUMN last_commit_sha TO deadline_sha;
ALTER TABLE submissions RENAME COLUMN last_commit_at TO deadline_commit_at;
ALTER TABLE submissions ADD COLUMN latest_commit_at TEXT;
