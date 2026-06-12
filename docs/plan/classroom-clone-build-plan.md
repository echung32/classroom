# Classroom Clone — Build Plan

A self-hosted, serverless alternative to GitHub Classroom. Repositories live on GitHub; the
orchestration server runs on Cloudflare Workers. Scope is intentionally an MVP: assignment
distribution, the slug naming system, deadline + grace-period management, a permission re-sync
escape hatch for students, and automated assembly of a devcontainer-ready grader repository after
the deadline passes.

This document is written to be handed directly to Claude Code as an implementation spec. Read the
**Design Decisions** and **Build Phases** sections first; they constrain every implementation
choice that follows.

---

## 1. Goals & Non-Goals

### Goals
- Teachers create classrooms and assignments from a GitHub **template repository**.
- Each assignment has a URL-safe **slug**; student repos are named `{slug}-{github-username}`.
- Students **accept** an assignment, which creates their repo from the template and grants access.
- Students can **re-sync permissions** on their repo when access breaks (expired invite, etc.).
- Each assignment has a **deadline** and a **grace period**; submissions are classified
  `on_time` / `late` / `missing` from each student's latest commit.
- At `deadline + grace`, write access is revoked and a **grader repository** is assembled
  automatically: every student repo added as a submodule pinned to its commit at the deadline,
  plus a devcontainer that clones the submodules on open.
- All external GitHub work is rate-limit-safe via **Cloudflare Queues**.

### Non-Goals (explicitly out of scope for the MVP)
- **No autograding.** Grading is performed by a human after the grader repo is assembled.
- **No webhooks.** State is derived by polling the GitHub API on schedule, not by event push.
- **No grade storage or grade reporting** in this app. It never records or displays grades.
- **No git execution on the server.** The Worker never clones; it only manipulates repo metadata
  via the GitHub Git Data API. Cloning happens on the grader's machine inside the devcontainer.

---

## 2. Tech Stack

| Concern | Choice |
| --- | --- |
| Compute | Cloudflare Workers |
| Relational data | Cloudflare D1 (SQLite) |
| Async fan-out / rate limiting | Cloudflare Queues (+ a dead-letter queue) |
| Scheduled deadline sweep | Cloudflare Cron Triggers (optionally Durable Object Alarms for exact timing) |
| Token/session cache (optional) | Cloudflare KV |
| GitHub integration | A GitHub App (org-level actions) + GitHub OAuth (user login) |
| Frontend | Worker-served HTML (HTMX) or a Cloudflare Pages SPA calling the Worker API |
| Language/tooling | TypeScript, Wrangler, Octokit (Workers-compatible usage) |

---

## 3. Design Decisions (read before coding)

These are settled decisions. Do not reintroduce the alternatives without flagging them.

1. **The server cannot run `git`.** Workers have no filesystem, no shell, ~128MB memory, and short
   CPU budgets. Every operation that would normally need a working tree is done through the GitHub
   **Git Data API** (blobs / trees / commits / refs) or deferred to the grader's local machine.

2. **No GitHub Actions runner is used.** The grader repository is assembled purely from Git Data
   API calls. The actual cloning of student repos happens on the human grader's machine when they
   open the devcontainer (`postCreateCommand` runs `git submodule update --init --recursive`),
   authenticated with the grader's own credentials.

3. **Submodules are pinned to the deadline commit SHA.** The deadline sweep already fetches each
   student's latest commit SHA to classify their submission; reuse that SHA as the submodule
   gitlink so the grader checks out the exact state being graded — deterministic, no "did they push
   after?" ambiguity.

4. **The slug convention is the index for all bulk operations.** Because every repo for an
   assignment shares the `{slug}-` prefix, "all repos for assignment X" is a single filtered repo
   listing. This powers both the deadline sweep and the grader build.

5. **Deadlines are enforced by permission downgrade.** During the grace window students keep write
   access (flagged late). At `deadline + grace` their collaborator permission is downgraded to
   `pull` (read) so they retain visibility but can no longer push.

6. **GitHub work goes through a queue.** A cron/alarm fires the sweep, which enqueues one message
   per repo. A consumer with low `max_concurrency` processes them with header-aware retry/backoff.
   This protects primarily against GitHub's *secondary* (abuse/concurrency) limits and gives clean
   retries + a dead-letter queue, not just the hourly cap.

7. **All times stored in UTC.** Render in the classroom's configured timezone in the UI only.

---

## 4. Data Model (Cloudflare D1)

```sql
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
```

---

## 5. Authentication

Two distinct auth paths.

### 5.1 GitHub App (org-level actions)
Used to create repos, manage collaborators, and build the grader repo. Mints short-lived
**installation tokens** scoped to the org (higher rate limits than a PAT).

Required permissions:
- **Administration: write** — create repositories from a template.
- **Contents: write** — Git Data API (blobs/trees/commits/refs) for the grader repo.
- **Members / Collaborators: write** — add/remove/downgrade student access.
- **Metadata: read** — baseline.

Token minting on Workers: the App JWT must be signed **RS256**. Use WebCrypto
(`RSASSA-PKCS1-v1_5` + SHA-256). Store the App private key as a Worker **secret**. Exchange the JWT
for an installation token, cache it (KV or in-memory per request) until just before expiry.

### 5.2 GitHub OAuth (user login)
Identifies the logged-in teacher/student and confirms GitHub account ownership. Used to resolve
`github_username` for the roster and to gate the accept / re-sync actions.

---

## 6. Feature Components

### 6.1 Classroom & roster management
- Create a classroom bound to a GitHub org + timezone.
- Roster is minimal: a list of GitHub usernames (optionally with a friendly identifier). Linking can
  be implicit on first OAuth login, or pre-seeded by the teacher.

### 6.2 Assignment creation
- Inputs: title, slug (validated url-safe + unique per classroom), template repo, deadline,
  grace period (minutes).
- Persists to `assignments`. Optionally schedules a Durable Object alarm at `deadline + grace`.

### 6.3 Acceptance flow
1. Student hits the accept link (must be OAuth-authenticated).
2. Worker creates `{slug}-{username}` from the template repo
   (`POST /repos/{template_owner}/{template_repo}/generate`).
3. Worker adds the student as a collaborator with `push`
   (`PUT /repos/{org}/{repo}/collaborators/{username}` with `permission: push`).
4. Record the repo in `repos` (repo_name, repo_id, accepted_at).
5. Return the repo URL + invite-acceptance URL.

### 6.4 Permission re-sync (student escape hatch)
The most common breakage: **collaborator invites expire after 7 days**, so a student who never
clicked the invite has no access. The re-sync action must be idempotent and re-runnable:
1. Resolve the student's repo by the slug convention.
2. Re-add them as a collaborator (re-issues the invite if pending).
3. Return the current invitation-acceptance URL and a clear status (`already has access` /
   `invite re-sent`).

### 6.5 Deadline & grace engine
States for deadline `D`, grace `G`:
- `t < D` → **on time**, write allowed.
- `D ≤ t < D+G` → **late window**, write still allowed, flagged late.
- `t ≥ D+G` → **closed**: revoke write (downgrade to `pull`), evaluate submissions, build grader.

Per-student status is derived from their latest default-branch commit timestamp vs `D`:
- last commit `< D` → `on_time`
- `D ≤` last commit `< D+G` → `late`
- only the template commit / no commits → `missing`

Trigger mechanism:
- **MVP:** a Cron Trigger runs every minute, selecting assignments whose `deadline + grace` has
  passed and `status = 'open'`.
- **Optional precision:** a Durable Object alarm scheduled per assignment for exact firing.

### 6.6 Queue-based processing pipeline
- The sweep marks the assignment `closed`/`building` and **enqueues one message per repo**:
  `{ assignment_id, repo_id, repo_name, student_id, deadline_at, grace_minutes }`.
- A queue **consumer** processes messages with `max_concurrency` set low (start at 3):
  1. Fetch the repo's latest default-branch commit (sha + timestamp).
  2. Classify and upsert into `submissions`.
  3. Downgrade the student's collaborator permission to `pull`.
- On GitHub `403`/`429`: read `retry-after` / `x-ratelimit-reset`, call
  `message.retry({ delaySeconds })` with a delay derived from the header.
- Configure a **dead-letter queue** for poison messages (deleted repo, never-accepted student).
- When all of an assignment's repos are processed, enqueue a single **grader-build** message
  (see 6.7).

> The queue is the mechanism for graceful handling; the *policy* is "watch the rate-limit headers
> and keep concurrency modest." If concurrent consumers ever collectively overshoot, add a Durable
> Object token-bucket governor as a follow-up — not needed for the MVP.

### 6.7 Grader repository builder (pure Git Data API, no clone)
Runs once per assignment after all submissions are evaluated. Produces `org/{slug}-grader`.

1. Create the grader repo if it doesn't exist (`POST /orgs/{org}/repos`).
2. Create blobs (`POST /repos/{org}/{slug}-grader/git/blobs`) for:
   - `.gitmodules` (one block per student — see below),
   - `.devcontainer/devcontainer.json`,
   - any grader scaffolding files.
3. Create a tree (`POST .../git/trees`) mixing file blobs (`mode 100644`) with one **gitlink** per
   student:
   ```json
   { "path": "submissions/<username>", "mode": "160000", "type": "commit", "sha": "<deadline_sha>" }
   ```
   The `sha` is the student's commit at the deadline (already recorded in `submissions`).
4. Create a commit on that tree (`POST .../git/commits`); parent = current grader HEAD if updating.
5. Update the ref (`PATCH .../git/refs/heads/main`).
6. Set `assignments.grader_repo` and `status = 'built'`.

`.gitmodules` entry shape:
```
[submodule "submissions/<username>"]
    path = submissions/<username>
    url = https://github.com/<org>/<slug>-<username>.git
```

`.devcontainer/devcontainer.json`:
```json
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "postCreateCommand": "git submodule update --init --recursive"
}
```

**One-command clone for the grader:** open the grader repo in the devcontainer (locally or in a
Codespace) and `postCreateCommand` clones every pinned submodule using the grader's own org
credentials. Equivalent manual command: `git clone --recurse-submodules <grader-repo-url>`.

---

## 7. API Surface (Worker routes)

```
# Auth
GET  /auth/login                 -> GitHub OAuth start
GET  /auth/callback              -> OAuth callback, create session

# Classrooms
POST /api/classrooms             -> create classroom
GET  /api/classrooms/:id         -> classroom detail + assignments

# Assignments
POST /api/classrooms/:id/assignments         -> create assignment (slug, template, deadline, grace)
GET  /api/assignments/:id                    -> assignment detail + submission statuses
POST /api/assignments/:id/accept             -> student acceptance flow (6.3)
POST /api/assignments/:id/resync             -> permission re-sync for current user (6.4)
POST /api/assignments/:id/close              -> manual trigger of the sweep (admin/testing)

# Internal (queue consumers + cron) — not user-facing
queue: process-repo                          -> per-repo evaluation + lock (6.6)
queue: build-grader                          -> grader assembly (6.7)
cron:  * * * * *                             -> deadline sweep
```

---

## 8. Project Structure

```
/
├─ wrangler.toml
├─ src/
│  ├─ index.ts                 # router + fetch handler
│  ├─ scheduled.ts             # cron deadline sweep
│  ├─ queue.ts                 # queue consumer(s): process-repo, build-grader
│  ├─ auth/
│  │  ├─ githubApp.ts          # JWT (RS256) + installation token minting
│  │  └─ oauth.ts              # user OAuth + sessions
│  ├─ github/
│  │  ├─ client.ts             # Octokit/fetch wrapper + rate-limit header handling
│  │  ├─ repos.ts              # create-from-template, collaborators, latest commit
│  │  └─ graderBuilder.ts      # Git Data API tree/commit assembly (6.7)
│  ├─ domain/
│  │  ├─ deadlines.ts          # status classification, window logic
│  │  └─ slug.ts               # slug validation + repo-name helpers
│  ├─ routes/                  # one file per route group
│  └─ db/
│     ├─ schema.sql            # section 4
│     └─ queries.ts            # typed D1 queries
└─ public/ or pages/           # minimal frontend
```

---

## 9. Configuration (wrangler.toml bindings)

- **D1 binding** — e.g. `DB`.
- **Queue producer + consumer bindings** — `WORK_QUEUE`, with `max_batch_size`,
  `max_batch_timeout`, `max_concurrency`, and `dead_letter_queue` configured.
- **KV binding** (optional) — `CACHE` for installation-token caching.
- **Durable Object binding** (optional) — for per-assignment deadline alarms.
- **Cron trigger** — `"* * * * *"`.
- **Secrets** (via `wrangler secret put`): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
  `GITHUB_APP_INSTALLATION_ID` (or resolve dynamically), `GITHUB_OAUTH_CLIENT_ID`,
  `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`.

---

## 10. Build Phases (suggested order for Claude Code)

**Phase 0 — Skeleton.** Wrangler project, TypeScript, router, D1 binding, `schema.sql` applied.
GitHub App JWT + installation-token minting working (verify with a simple authenticated call).
OAuth login + session. *Done when:* a logged-in user's GitHub username is resolved and stored.

**Phase 1 — Assignments + slug.** Classroom + assignment creation with slug validation
(url-safe, unique per classroom) and repo-name helpers. *Done when:* an assignment persists and its
expected repo-name pattern is computable.

**Phase 2 — Acceptance + re-sync.** Create-from-template, add collaborator, record repo. Idempotent
re-sync that re-issues invites. *Done when:* a student can accept, lose access, and recover it.

**Phase 3 — Deadline engine.** Cron sweep selecting assignments past `deadline + grace`; status
classification logic with unit tests for the on_time/late/missing boundaries. *Done when:* the sweep
correctly identifies due assignments and classifies a set of test repos.

**Phase 4 — Queue pipeline.** Fan-out per repo, low-concurrency consumer, header-aware retry,
dead-letter queue, permission downgrade. *Done when:* closing an assignment evaluates and locks all
repos without tripping secondary rate limits.

**Phase 5 — Grader builder.** Git Data API assembly of `{slug}-grader` with pinned submodule
gitlinks, `.gitmodules`, and the devcontainer. *Done when:* opening the grader repo in a devcontainer
clones every submodule at its deadline SHA with one action.

**Phase 6 — Frontend.** Teacher views (create/manage, submission status board) and student views
(accept, re-sync, deadline state). Minimal HTMX or Pages SPA.

---

## 11. Acceptance Criteria (end-to-end)

- A teacher creates an assignment with a template, deadline, and 60-minute grace.
- A student accepts and gets a `{slug}-{username}` repo with push access.
- A student with a broken/expired invite recovers access via re-sync.
- At the deadline, students in the grace window can still push and are flagged `late`.
- At `deadline + grace`, push access is revoked (downgraded to read) and statuses are finalized.
- A `{slug}-grader` repo exists with all student repos as submodules pinned to their deadline SHAs.
- `git clone --recurse-submodules <grader-repo>` (or opening it in the devcontainer) yields every
  student's submission at the graded state, with no GitHub Action involved.

---

## 12. Open Items / Verify Against Current Docs

- Confirm current Cloudflare limits relevant to the cron sweep: CPU/wall-time budget, Queues message
  size, batch size, and `max_concurrency` ceilings. Keep per-invocation work paginated and small.
- Confirm GitHub App installation **primary** rate-limit scaling for your org size, and stay well
  under **secondary** (concurrency/abuse) limits — keep consumer `max_concurrency` low and honor
  `retry-after`.
- Decide roster strategy: implicit linking on first OAuth login vs. teacher-seeded usernames.
- Decide grader repo lifecycle: one persistent grader repo per assignment updated in place, vs.
  a fresh build each run.
- Default branch assumption: confirm each student repo's default branch before reading "latest
  commit" (don't hardcode `main`).
