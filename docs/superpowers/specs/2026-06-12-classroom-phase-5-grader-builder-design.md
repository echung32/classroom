# Phase 5 — Grader Builder + Grading Decisions (Design Spec)

**Status:** Approved design, ready for implementation planning.
**Date:** 2026-06-12
**Predecessor:** Phase 3 (Lazy deadline evaluation), merged. (Phase 4 — the queue pipeline —
was cut by the Phase 3 pivot; see that spec's §3 and §11.)

---

## 1. Summary

Phase 5 delivers two teacher-facing, backend-only capabilities (the UI is Phase 6):

1. **Per-student grading decision.** After Phase 3 evaluation freezes each submission, the
   teacher sets each student's `grade_decision` to `at_deadline` (default), `accept_late`,
   or `exclude`. This is the teacher's "do I count this student's late work?" lever, decided
   in advance of building.

2. **Grader build.** Assembles `org/grader-{slug}` via the **GitHub Git Data API only**
   (no clone, no GitHub Action), pinning each included student's repo as a git submodule at
   the commit SHA their decision selects. Opening the grader in its devcontainer (or
   `git clone --recurse-submodules`) yields every graded submission at its pinned state.

The build **does not run evaluation** — it requires submissions to already be evaluated
(the "decide first, then build" gate). It reads the frozen `submissions` rows + decisions
and produces the grader. This is a deliberate choice so the teacher's grading decisions are
an explicit, reviewed input rather than a side effect of building.

## 2. Naming

- Grader repo name: **`grader-{slug}`** (prefix), e.g. `grader-ics605-sp26-assignment-3`.
- Stored as `assignments.grader_repo = "{org}/grader-{slug}"`.
- Submodule URLs point at the **student** repos `{slug}-{username}` (unchanged from Phase 2);
  only the grader repo's own name uses the `grader-` prefix.

## 3. Data model (migration `0005_grading_decisions.sql`)

Extend `submissions` (two added columns; existing columns unchanged):

| column           | type | meaning |
|------------------|------|---------|
| `latest_sha`     | TEXT | SHA of the latest commit overall on the default branch. Today only `latest_commit_at` (its timestamp) is stored; the SHA is needed to pin an `accept_late` student to real post-deadline work. Captured during evaluation, refreshed alongside `latest_commit_at`. Nullable (empty repo). |
| `grade_decision` | TEXT NOT NULL DEFAULT `'at_deadline'` | One of `at_deadline` \| `accept_late` \| `exclude`. Teacher intent — set via the decision endpoint, **never recomputed**, preserved across re-evaluation/refresh. |

```sql
ALTER TABLE submissions ADD COLUMN latest_sha TEXT;
ALTER TABLE submissions ADD COLUMN grade_decision TEXT NOT NULL DEFAULT 'at_deadline';
```

No change to `assignments`' columns; on a successful build the existing `grader_repo` and
`status` columns are written (`status = 'built'`).

### 3.1 Phase 3 module extensions (small)

- `src/lib/github/commits.ts` — `readRepoCommitState` additionally returns `latestSha`
  (the `sha` of the first element of the unfiltered `?per_page=2` commits call; `null` when
  the repo has no commits).
- `src/lib/db/submissions.ts`:
  - `Submission` interface + `SubmissionRow` + `toSubmission` gain `latestSha` and
    `gradeDecision`.
  - `freezeSubmission` writes `latest_sha` (refreshed, not COALESCE-frozen — only
    `deadline_sha`/`deadline_commit_at` stay immutable). Its `INSERT` does **not** list
    `grade_decision` (DB default applies); its `ON CONFLICT DO UPDATE` does **not** touch
    `grade_decision` (existing teacher intent preserved).
  - `refreshSubmissionStatus` also updates `latest_sha` (never `grade_decision`,
    `deadline_sha`).
- `src/lib/domain/evaluation.ts` — thread `latestSha` from `readRepoCommitState` into
  `freezeSubmission`/`refreshSubmissionStatus`; add `latestSha`/`gradeDecision` to
  `SubmissionLite`/`SubmissionView` so the status board also surfaces them.

These extensions keep existing Phase 3 behavior (the `deadline_sha` immutability via
COALESCE, the per-repo error isolation) intact.

## 4. Pin selection + content builders (pure, unit-tested)

`src/lib/domain/grader.ts` — no I/O.

### 4.1 `selectGraderEntries(submissions)`

Input: the assignment's submissions (each with `githubUsername`, `gradeDecision`,
`deadlineSha`, `latestSha`). Output: `{ included: GraderEntry[], skipped: SkippedEntry[] }`.

`skipped` is a complete accounting of every submission not pinned, so the response explains
each omission. Per submission:

- `grade_decision === 'exclude'` → `skipped` with reason `excluded` (kept out of the grader
  by the teacher's choice).
- `grade_decision === 'at_deadline'` → pin `deadline_sha`, `source: 'deadline'`.
- `grade_decision === 'accept_late'` → pin `latest_sha`, `source: 'latest'`.
- An otherwise-included student whose selected SHA is `null` → `skipped` with reason
  (`no-deadline-sha` / `no-latest-sha`), **not** a build failure.
- A student with `githubUsername === null` (roster entry never linked to a GitHub account)
  → `skipped` with reason `no-github-username` (can't form a submodule path/URL).

```
GraderEntry  = { username: string, sha: string, source: 'deadline' | 'latest' }
SkippedEntry = { username: string | null, studentId: string, reason: string }
```

### 4.2 Content builders

- `buildGitmodules(entries, org)` → the `.gitmodules` text, one block per included entry:
  ```
  [submodule "submissions/<username>"]
      path = submissions/<username>
      url = https://github.com/<org>/<slug>-<username>.git
  ```
  (The student repo name `{slug}-{username}` is passed in per entry; `org` is the classroom
  org.)
- `buildDevcontainer(entries, org, name)` → the `.devcontainer/devcontainer.json` text.
  **Critical for GitHub Codespaces:** a Codespace's token only gets access to repositories
  declared under `customizations.codespaces.repositories`, so without one read entry per
  student repo the private submodules cannot be cloned. The builder emits one
  `"{org}/{slug}-{username}": { "permissions": { "contents": "read" } }` entry per
  **included** entry. Built as a structured JS object and serialized with
  `JSON.stringify(obj, null, 2)` (safe escaping of `name`, deterministic key order by
  username — no manual comma-joining):
  ```json
  {
    "name": "grader-{slug}",
    "image": "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
    "features": { "ghcr.io/devcontainers/features/git:1": {} },
    "customizations": {
      "codespaces": {
        "repositories": {
          "{org}/{slug}-{username}": { "permissions": { "contents": "read" } }
        }
      }
    },
    "postCreateCommand": "git submodule update --init --recursive"
  }
  ```
  (`postCreateCommand` is retained so opening the grader still initializes the submodules;
  `name` is the grader repo name `grader-{slug}`.)
- `buildReadme(assignmentTitle, entries)` → a short top-level `README.md` naming the
  assignment and listing the pinned submissions (informational).

All three return deterministic strings (stable ordering by username) so rebuilds are
reproducible and diffs are clean.

## 5. Git Data API wrappers

`src/lib/github/git-data.ts` — thin, injectable (`fetchImpl?`), mirroring `repos.ts`. Each
wraps one `githubRequest` call:

- `ensureOrgRepo({ token, org, name, fetchImpl })` — `POST /orgs/{org}/repos`
  `{ name, private: true }`; on `GitHubApiError` status **422** (already exists), confirm via
  `GET /repos/{org}/{name}` and return it. Returns `{ fullName, htmlUrl }`.
- `createTree({ token, org, repo, tree, fetchImpl })` — `POST /repos/{org}/{repo}/git/trees`
  with the entries array (no `base_tree`). Returns the new tree SHA.
- `createCommit({ token, org, repo, message, tree, parents, fetchImpl })` —
  `POST /repos/{org}/{repo}/git/commits`. Returns the new commit SHA.
- `getMainRef({ token, org, repo, fetchImpl })` — `GET /repos/{org}/{repo}/git/ref/heads/main`;
  returns the SHA, or `null` on **404** (first build, no commits yet).
- `createMainRef({ token, org, repo, sha, fetchImpl })` —
  `POST /repos/{org}/{repo}/git/refs` `{ ref: "refs/heads/main", sha }`.
- `updateMainRef({ token, org, repo, sha, fetchImpl })` —
  `PATCH /repos/{org}/{repo}/git/refs/heads/main` `{ sha, force: false }`.

Tree entries use inline `content` for the text blobs (the trees API creates the blob
automatically) and `sha` + `mode: "160000"` + `type: "commit"` for gitlinks — no separate
`git/blobs` calls needed.

## 6. Build orchestration

`src/lib/domain/grader-build.ts` — `deps`-injected like `evaluation.ts` (token, `fetchImpl`,
and DB-bound closures: `loadAssignment`, `loadClassroom`, `listSubmissionsWithStudents`,
`setGraderBuilt`).

```
buildGrader(deps, { assignmentId }) -> GraderBuildResult
```

Steps:

1. Load the assignment (throw `AssignmentNotFoundError` if missing — endpoints map to 404).
2. Guard: if `deadline_at` is null or `now < deadline_at`, reject — there is nothing to
   grade yet. (Surfaced as a 409/400 by the endpoint.) `now` is injected for testability.
3. Load the classroom (for `github_org`) and the submissions joined to students (username +
   the student repo name `{slug}-{username}`).
4. `selectGraderEntries(...)` → `{ included, skipped }`. If `included` is empty, reject with
   a clear "nothing to build" error rather than creating an empty grader.
5. `ensureOrgRepo` → grader repo `grader-{slug}`.
6. Build the tree entries: `.gitmodules`, `.devcontainer/devcontainer.json`, `README.md`
   (inline content) + one `160000` gitlink per `included` entry. `createTree`.
7. `getMainRef` → `parent` (or `null`). `createCommit` with `parents: parent ? [parent] : []`.
8. `parent ? updateMainRef : createMainRef`.
9. `setGraderBuilt(assignmentId, "{org}/grader-{slug}")` → sets `grader_repo` + `status =
   'built'`.
10. Return `{ graderRepo, htmlUrl, commitSha, included, skipped }`.

**Idempotency / partial failure.** The whole tree is rebuilt every time (no `base_tree`), so
re-running picks up changed decisions and refreshed `latest_sha` values and is safe on an
already-`built` assignment. A failure before step 8 leaves the `main` ref untouched (dangling
blobs/trees/commits are harmless); a re-run repairs. `ensureOrgRepo`'s 422 path handles a
grader repo created by a prior failed attempt.

**Error policy.** Unlike Phase 3's per-repo evaluation, the Git Data API calls here are
single grader-repo operations, not per-student — a failure aborts the build and surfaces as a
**502** through the existing `toResponse` mapping (consistent with the Phase 2/3 token-mint
mapping). Per-student concerns are handled earlier as `skipped` entries (§4.1), never as
thrown errors.

## 7. Endpoints (owner-only)

Both resolve the user via the existing `requireUser`, load the assignment, and call
`assertOwnsClassroom(db, assignment.classroomId, userId)`.

### 7.1 `PUT /api/assignments/:id/submissions/:studentId/decision`

`src/pages/api/assignments/[id]/submissions/[studentId]/decision.ts`.

- Body `{ decision: "at_deadline" | "accept_late" | "exclude" }`, validated by a Valibot enum
  in `src/lib/http/schemas.ts`.
- `setGradeDecision(db, assignmentId, studentId, decision)` — UPDATE of `grade_decision`.
  Requires an existing (evaluated) submission row; if the UPDATE matches no row, return
  **404** (`NotFoundError`) — decisions can only be set on evaluated submissions.
- Returns the updated submission view.

### 7.2 `POST /api/assignments/:id/grader`

`src/pages/api/assignments/[id]/grader.ts`.

- Calls `buildGrader`. No request body.
- Returns `{ graderRepo, htmlUrl, commitSha, included: [{ username, sha, source }],
  skipped: [{ username, studentId, reason }] }`.
- The "deadline not passed / no deadline" guard (§6 step 2) → 400; "nothing to build"
  (empty `included`) → 400; Git Data API failure → 502; unknown assignment → 404; non-owner →
  403.

## 8. DB helpers

`src/lib/db/submissions.ts`:
- `setGradeDecision(db, assignmentId, studentId, decision) -> boolean` (false if no row).
- `listSubmissionsWithStudents(db, assignmentId)` — submissions joined to `students` and
  `assignments` to yield, per row: `studentId`, `githubUsername`, the student repo name
  (`{slug}-{username}`), `gradeDecision`, `deadlineSha`, `latestSha`, `status`. (Reuses the
  join shape from `listReposWithStudentsByAssignment`.)

`src/lib/db/assignments.ts`:
- `setGraderBuilt(db, assignmentId, graderRepo)` — `UPDATE assignments SET grader_repo = ?,
  status = 'built' WHERE id = ?`.

## 9. Testing

### 9.1 Unit (plain Vitest, mocked fetch)

- `test/unit/grader.test.ts` — `selectGraderEntries` across all three decisions, null-SHA
  skip (both `deadline`/`latest`), `no-github-username` skip, and `exclude` omission; the
  content builders (`.gitmodules` exact text; devcontainer JSON includes one
  `customizations.codespaces.repositories` read entry per included student repo and the
  `postCreateCommand`; deterministic ordering).
- `test/unit/git-data.test.ts` — each wrapper with an injected `fetchImpl` (assert
  URL/method/body); `ensureOrgRepo` 422→GET recovery; `getMainRef` 404→`null`.
- `test/unit/github-commits.test.ts` — extend to assert `readRepoCommitState` now returns
  `latestSha`.

### 9.2 Integration (`@cloudflare/vitest-pool-workers`)

GitHub egress is mocked by the global miniflare `outboundService` in
`test/integration/github-mock.ts` (not `fetchMock`); idempotency is verified via observable
state, not call counts (per the harness memory).

- Extend `github-mock.ts` to answer the Git Data API routes: `POST /orgs/{org}/repos`
  (201, echo `grader-{slug}`), `POST /repos/{o}/{r}/git/trees` (201, canned tree sha),
  `POST /repos/{o}/{r}/git/commits` (201, canned commit sha), `GET /repos/{o}/{r}/git/ref/heads/main`
  (a documented convention: 404 = first build, else a canned sha), `POST /repos/{o}/{r}/git/refs`
  and `PATCH /repos/{o}/{r}/git/refs/heads/main` (200/201).
- `test/integration/decision-api.test.ts` — set a decision on an evaluated submission (200,
  row updated); on a non-evaluated/unknown student → 404; non-owner → 403.
- `test/integration/grader-api.test.ts` — seed an assignment past its deadline with evaluated
  submissions in a mix of decisions (`at_deadline`, `accept_late`, `exclude`, plus one with a
  null SHA), POST `/grader`, assert: `assignment.grader_repo === "{org}/grader-{slug}"` and
  `status === 'built'`; the response `included` pins the right SHA per `source`; `skipped`
  contains the null-SHA and excluded-from-build cases. A second POST still returns `built`
  (idempotent). Deadline-not-passed → 400; non-owner → 403.

## 10. File structure

**New:**
- `migrations/0005_grading_decisions.sql`
- `src/lib/domain/grader.ts`
- `src/lib/github/git-data.ts`
- `src/lib/domain/grader-build.ts`
- `src/pages/api/assignments/[id]/submissions/[studentId]/decision.ts`
- `src/pages/api/assignments/[id]/grader.ts`
- `test/unit/grader.test.ts`, `test/unit/git-data.test.ts`
- `test/integration/decision-api.test.ts`, `test/integration/grader-api.test.ts`

**Modified:**
- `src/lib/github/commits.ts` (+`latestSha`)
- `src/lib/db/submissions.ts` (+`setGradeDecision`, +`listSubmissionsWithStudents`, persist
  `latest_sha`, expose `gradeDecision`)
- `src/lib/db/assignments.ts` (+`setGraderBuilt`)
- `src/lib/domain/evaluation.ts` (thread `latestSha`, expose `gradeDecision` in views)
- `src/lib/http/schemas.ts` (decision enum)
- `test/integration/github-mock.ts` (Git Data API responders)
- `test/unit/github-commits.test.ts` (assert `latestSha`)

## 11. Out of scope / open items

- **Frontend (Phase 6):** the UI for reviewing statuses, setting decisions, and triggering a
  build. This phase delivers only the APIs.
- **Submodule clone auth:** in a **Codespace**, read access to the private student submodules
  is granted by the `customizations.codespaces.repositories` block the builder writes into
  `devcontainer.json` (§4.2). For a **local** `git clone --recurse-submodules`, the operator's
  own GitHub credentials must have read on the student repos (as in the build plan §6.7) —
  not something the grader file can control; documented as an operational note.
- **Pin timing for `accept_late`:** the build pins the student's `latest_sha` *as of the
  build* (the most recent evaluation/refresh), not as of the moment the decision was made.
  Acceptable: the build is the teacher's explicit final action. A teacher who wants the very
  latest should refresh the status board (Phase 3) before building.
- **`missing` students:** default `at_deadline` pins their template-import commit (the
  deadline state). A teacher who doesn't want them in the grader sets `exclude`.
- **Multi-commit templates:** as noted in the Phase 3 spec §11, the `hasStudentCommits`
  heuristic (`>= 2` commits) assumes a single template-import commit; unchanged here.
