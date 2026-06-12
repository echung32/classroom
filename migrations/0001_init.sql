-- Phase 0: full schema from the build plan §4, plus `users` (design §3).
-- Only `users` is read/written in Phase 0.

CREATE TABLE users (
  id              TEXT PRIMARY KEY,                 -- uuid
  github_id       INTEGER NOT NULL UNIQUE,          -- stable identity (usernames change)
  github_username TEXT NOT NULL,                    -- latest known login
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at   TEXT
);

CREATE TABLE classrooms (
  id            TEXT PRIMARY KEY,            -- uuid
  name          TEXT NOT NULL,
  github_org    TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assignments (
  id            TEXT PRIMARY KEY,            -- uuid
  classroom_id  TEXT NOT NULL REFERENCES classrooms(id),
  slug          TEXT NOT NULL,               -- url-safe, unique per classroom
  title         TEXT NOT NULL,
  template_repo TEXT NOT NULL,               -- "org/template-name"
  deadline_at   TEXT,                        -- UTC ISO8601, nullable = no deadline
  grace_minutes INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open',-- open | closed | building | built
  grader_repo   TEXT,                        -- "org/{slug}-grader" once created
  closed_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (classroom_id, slug)
);

CREATE TABLE students (
  id                 TEXT PRIMARY KEY,        -- uuid
  classroom_id       TEXT NOT NULL REFERENCES classrooms(id),
  roster_identifier  TEXT,                    -- optional friendly id (student #, email)
  github_username    TEXT,                    -- nullable until linked
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (classroom_id, github_username)
);

CREATE TABLE repos (
  id                  TEXT PRIMARY KEY,       -- uuid
  assignment_id       TEXT NOT NULL REFERENCES assignments(id),
  student_id          TEXT NOT NULL REFERENCES students(id),
  repo_name           TEXT NOT NULL,          -- "{slug}-{username}"
  repo_id             INTEGER,                -- GitHub numeric repo id
  accepted_at         TEXT,
  permission_synced_at TEXT,
  UNIQUE (assignment_id, student_id)
);

CREATE TABLE submissions (
  assignment_id   TEXT NOT NULL REFERENCES assignments(id),
  student_id      TEXT NOT NULL REFERENCES students(id),
  last_commit_sha TEXT,
  last_commit_at  TEXT,                       -- UTC ISO8601
  status          TEXT NOT NULL DEFAULT 'missing', -- on_time | late | missing
  evaluated_at    TEXT,
  PRIMARY KEY (assignment_id, student_id)
);
