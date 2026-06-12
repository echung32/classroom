-- Phase 2: link a roster entry to the stable authenticated identity (users.id),
-- not just the mutable github_username.
ALTER TABLE students ADD COLUMN user_id TEXT REFERENCES users(id);

-- One account can claim at most one roster row per classroom. SQLite treats NULLs
-- as distinct, so many unclaimed (user_id IS NULL) rows still coexist.
CREATE UNIQUE INDEX students_classroom_user ON students(classroom_id, user_id);
