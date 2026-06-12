-- Phase 5: grading decisions + the latest-commit SHA needed to pin accept_late
-- students to real post-deadline work. `latest_sha` is captured/refreshed during
-- evaluation alongside `latest_commit_at`. `grade_decision` is teacher intent —
-- set via the decision endpoint, never recomputed, preserved across re-evaluation.

ALTER TABLE submissions ADD COLUMN latest_sha TEXT;
ALTER TABLE submissions ADD COLUMN grade_decision TEXT NOT NULL DEFAULT 'at_deadline';
