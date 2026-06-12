# Phase 3 — Lazy Deadline Evaluation (Design Spec)

**Status:** Approved design, ready for implementation planning.
**Date:** 2026-06-12
**Predecessor:** Phase 2 (Acceptance + Re-sync), merged.

---

## 1. Summary

Phase 3 delivers the deadline engine — but **without a cron trigger, without a custom
Worker entry, and without permission downgrades.** A student's deadline state is a pure
function of immutable, timestamped git history, so it can be reconstructed at any later
time. Evaluation is therefore **teacher-triggered and lazy**: the first time a teacher
views an assignment's status board after its deadline, each repo is evaluated and the
result is **frozen** into the `submissions` table. The pinned commit SHA captured here is
exactly what Phase 5's grader builder will submodule-pin to.

This is a deliberate departure from the original build plan (§6.5–6.6), which assumed a
cron sweep that revoked write access and fanned per-repo work out to a queue. We keep the
classification *taxonomy* (`on_time` / `late` / `missing`) and the pinned-deadline-SHA
concept; we drop the enforcement machinery.

## 2. Rationale: why no cron

The only thing in the original design that *had* to happen at the deadline moment was
**enforcement** — revoking write access so a student physically cannot push late. GitHub
does not do that on its own, so something had to fire at `deadline`. That was the sole
reason a cron (or Durable Object alarm) existed.

If students instead keep push access and we simply **record what was there at the
deadline**, the deadline state becomes derivable from git history at any time:

- *Last commit at or before the deadline* → `GET /repos/{o}/{r}/commits?until={deadline}`
- *Any commit after the deadline?* → the latest commit's timestamp vs. the deadline

Nothing needs to be captured *at* the deadline instant. This also simplifies Phase 5: the
deadline SHA is recoverable on demand.

**Accepted trade-off — history rewrites.** Because students retain write access, a student
could force-push and rewrite history *after* the deadline, erasing the commit that was
there. Mitigation: the **first** evaluation after the deadline *freezes* `deadline_sha`
into `submissions`; later reads use the frozen row. A rewrite before that first evaluation
is an accepted, low-probability risk for the MVP (no teacher has looked yet, and the window
is short). We do not add a background snapshotter to close it.

**Accepted trade-off — commit-date trust.** Late-ness is derived from commit timestamps,
which a determined student can backdate (`git commit --date=...`). The original plan's
per-student derivation had the same property. Acceptable for the MVP.

## 3. What changes relative to the build plan

**Removed from Phase 3 scope:**

- Cron trigger / scheduled sweep.
- Custom `src/worker.ts` entry (we stay on the stock `@astrojs/cloudflare` adapter — the
  deferral carried since Phase 0 continues).
- Permission downgrade to `pull`.
- The `assignments.grace_minutes` column and all references to it.

**Deferred / reframed:**

- **Phase 4 (queue pipeline)** loses its original purpose (deadline-time fan-out +
  downgrade). If a queue is ever needed it would only be to evaluate very large classes in
  parallel without blocking a request. This is **deferred and may be dropped**; it is out
  of scope for Phase 3.
- `assignments.status` (`open|closed|building|built`) and `closed_at` are **left untouched**
  in Phase 3. "Past deadline" is derived (`now ≥ deadline_at`), not a stored flag. Phase 5
  may set `building`/`built` when it creates the grader repo.

## 4. Data model changes (migration `0004`)

A single migration `migrations/0004_deadline_evaluation.sql`.

### 4.1 Drop `grace_minutes`

```sql
ALTER TABLE assignments DROP COLUMN grace_minutes;
```

Downstream removals (all currently set `grace_minutes`/`graceMinutes`):

- `src/lib/http/schemas.ts` — remove the `grace_minutes` Valibot field.
- `src/pages/api/classrooms/[id]/assignments.ts` — remove `graceMinutes: body.grace_minutes`.
- `src/lib/db/assignments.ts` — remove `graceMinutes` from the `Assignment` interface, the
  row type, the `toAssignment` mapper, and the `createAssignment` INSERT column list + bind.
- Tests that set or assert `graceMinutes` / `grace_minutes`:
  `test/integration/assignments-db.test.ts`, `assignments-api.test.ts`, `accept-api.test.ts`,
  `resync-api.test.ts`, `roster-api.test.ts`, `classrooms-api.test.ts`,
  `test/unit/validation.test.ts`. Update them to no longer reference grace.

### 4.2 Reshape `submissions`

The `submissions` table was created in Phase 0's schema but is not yet read or written by
any code (verified: no `src/` references), so it can be reshaped freely. Target shape:

| column               | type | meaning |
|----------------------|------|---------|
| `assignment_id`      | TEXT | PK part, FK → assignments(id) |
| `student_id`         | TEXT | PK part, FK → students(id) |
| `deadline_sha`       | TEXT | last commit at-or-before the deadline; **immutable once written**; what Phase 5 pins |
| `deadline_commit_at` | TEXT | commit date of `deadline_sha` (UTC ISO-8601) |
| `latest_commit_at`   | TEXT | most recent commit overall; drives late-ness; updated on refresh |
| `status`             | TEXT | `on_time` \| `late` \| `missing` |
| `evaluated_at`       | TEXT | null until first evaluation |

PK remains `(assignment_id, student_id)`. Implement by renaming the existing
`last_commit_sha` → `deadline_sha`, `last_commit_at` → `deadline_commit_at`, and adding
`latest_commit_at` (the existing `status` and `evaluated_at` columns are kept as-is). The
migration is plain DDL since the table is empty.

## 5. Classifier (core deliverable)

`src/lib/domain/deadline.ts` — pure, no I/O, fully unit-tested.

```
classifySubmission({ deadlineAt, latestCommitAt, hasStudentCommits })
  -> 'on_time' | 'late' | 'missing'
```

Rules:

- `!hasStudentCommits` → **`missing`** (repo holds only the template's initial commit).
- `hasStudentCommits && latestCommitAt <= deadlineAt` → **`on_time`**.
- `hasStudentCommits && latestCommitAt > deadlineAt` → **`late`**.

Notes:

- The boundary is the deadline alone (grace dropped). A commit whose timestamp equals the
  deadline exactly counts as `on_time` (`<=`).
- `deadline_sha` (the pinned commit) is selected separately as "last commit at-or-before
  the deadline" and is **independent of status** — for a student with only late work it is
  the template commit, which is the correct deadline-state to grade.
- Timestamps are compared as instants (parse ISO-8601 to epoch ms); never string-compare.

**Boundary unit tests (required):** commit exactly at the deadline (`on_time`); one second
before (`on_time`); one second after (`late`); no student commits / template only
(`missing`); student work all after the deadline (`late`, with `deadline_sha` = template
commit).

## 6. GitHub reads

`src/lib/github/commits.ts` — uses the existing lean `githubRequest` client; accepts an
injectable `fetchImpl` for unit tests (same pattern as `src/lib/github/repos.ts`). Calls
target the repository's **default branch** (the commits API defaults to it when `sha` is
omitted), so no separate default-branch lookup is needed.

Two calls per repo:

1. `GET /repos/{owner}/{repo}/commits?per_page=2`
   - `latestCommitAt` = `commits[0].commit.committer.date` (or `null` if empty).
   - `hasStudentCommits` = `commits.length >= 2` (more than the single template-import
     commit). An empty array (no commits at all) ⇒ `hasStudentCommits = false`.
2. `GET /repos/{owner}/{repo}/commits?until={deadlineAtIso}&per_page=1`
   - `deadlineSha` = `commits[0].sha` (or `null` if none ≤ deadline).
   - `deadlineCommitAt` = `commits[0].commit.committer.date`.

Helper shape (illustrative):

```
readRepoCommitState({ token, owner, repo, deadlineAt, fetchImpl })
  -> { latestCommitAt, hasStudentCommits, deadlineSha, deadlineCommitAt }
```

**Error handling:** a `404` (repo deleted) or other `GitHubApiError` for a single repo is
caught by the orchestrator and recorded as a per-repo error in the response; it does not
abort evaluation of the other repos. The repo's submission row is left unevaluated.

## 7. Evaluation orchestration

`src/lib/domain/evaluation.ts`:

```
evaluateAssignmentSubmissions(deps, { assignmentId, now, refresh })
  -> { evaluated: SubmissionView[], errors: {studentId, repoName, message}[], dueState }
```

- `deps` carries the D1 handle, the installation token (via the existing
  `getInstallationToken()` from `src/lib/github/app.ts`), and `fetchImpl` for tests.
- Load the assignment. If `deadline_at` is null → `dueState: 'no-deadline'`, return the
  repo list with `status: null`, no GitHub calls, no writes.
- If `now < deadline_at` → `dueState: 'pending'`, return repos as `pending`, no freeze.
- Otherwise (`now >= deadline_at`), list the assignment's repos joined to their students
  (need `students.github_username` and the classroom `github_org` to build `{owner, repo}`).
  For each repo:
  - If already evaluated (`evaluated_at` set) and **not** `refresh` → use the cached row.
  - Else call `readRepoCommitState`, `classifySubmission(...)`, then:
    - **Freeze:** `freezeSubmission(...)` writes `deadline_sha`/`deadline_commit_at` **only
      if not already set** (immutable), plus `latest_commit_at`, `status`, `evaluated_at`.
    - **Refresh of an already-frozen row:** `refreshSubmissionStatus(...)` updates
      `status` + `latest_commit_at` + `evaluated_at`, never touching `deadline_sha`.
- Idempotent: a second call with the same `now` and `refresh: false` performs no GitHub
  calls and no writes for already-evaluated repos.

`src/lib/db/submissions.ts`:

- `getSubmission(db, assignmentId, studentId) -> Submission | null`
- `listSubmissionsByAssignment(db, assignmentId) -> Submission[]`
- `freezeSubmission(db, { assignmentId, studentId, deadlineSha, deadlineCommitAt,
  latestCommitAt, status })` — INSERT, or UPDATE that sets `deadline_sha`/`deadline_commit_at`
  only when currently null (`COALESCE`-style guard), to enforce immutability.
- `refreshSubmissionStatus(db, { assignmentId, studentId, latestCommitAt, status })` —
  UPDATE of `status`, `latest_commit_at`, `evaluated_at` only.

## 8. Endpoints (owner-only)

Both endpoints resolve the authenticated user (existing `requireUser`) and call
`assertOwnsClassroom(db, assignment.classroomId, userId)` (via the assignment's classroom).

### 8.1 `GET /api/assignments/:id/submissions`

`src/pages/api/assignments/[id]/submissions.ts` (GET handler).

- Calls `evaluateAssignmentSubmissions(deps, { assignmentId, now, refresh: false })`.
- Lazily evaluates+freezes any not-yet-evaluated repo whose deadline has passed; returns
  cached rows for already-evaluated repos.
- Response: `{ assignmentId, dueState, submissions: [...], errors: [...] }` where each
  submission carries `{ studentId, githubUsername, repoName, status, deadlineSha,
  deadlineCommitAt, latestCommitAt, evaluatedAt }`.

### 8.2 `POST /api/assignments/:id/submissions/refresh`

Same file, POST handler (or a sibling route — implementer's call, but keep the URL as
specified).

- Calls `evaluateAssignmentSubmissions(deps, { assignmentId, now, refresh: true })`.
- Re-checks late-ness on already-frozen rows (catches a student who pushed after the first
  evaluation). `deadline_sha` is preserved. Same response shape as the GET.

Synchronous inline over the repo list, mirroring Phase 2's inline accept (~2 GitHub calls
per student; tens of students is well within primary rate limits). `GitHubApiError` that is
not a per-repo 404 surfaces through the existing `toResponse` mapping (→ 502 per the Phase 2
extension).

## 9. Testing

### 9.1 Unit (plain Vitest, mocked fetch)

- `test/unit/deadline.test.ts` — classifier boundaries from §5.
- `test/unit/github-commits.test.ts` — `readRepoCommitState` with an injected `fetchImpl`
  (same style as `test/unit/github-repos.test.ts`): asserts the two request URLs/params and
  the mapped `{latestCommitAt, hasStudentCommits, deadlineSha, deadlineCommitAt}`, including
  the empty-repo and only-template cases.
- Optionally an evaluation-orchestrator unit test with a mocked commit-state function +
  in-memory submission writes.

### 9.2 Integration (`@cloudflare/vitest-pool-workers`)

Per the project's harness memory, GitHub egress is mocked by the global miniflare
`outboundService` in `test/integration/github-mock.ts` (not `fetchMock`), and idempotency
is verified via observable state, not call counts.

- Extend `github-mock.ts` to answer `GET /repos/{o}/{r}/commits` (with and without `until`).
  Derive canned commits from the repo name using a documented convention (mirroring the
  existing `member` rule), e.g. a repo name containing `late` yields a latest commit after
  the deadline, `ontime` yields one before, `missing` yields a single (template-only) commit.
- `test/integration/submissions-api.test.ts`:
  - Seed a classroom/assignment with a **past** `deadline_at`, seed students + accepted
    repos, GET the status board → assert frozen `submissions` rows with the expected
    `status` per repo and a non-null `deadline_sha`/`evaluated_at`.
  - GET again → assert the rows are unchanged (`evaluated_at` stable) — cache hit verified by
    state, not call count.
  - POST `/refresh` after changing the mock's late-ness for one repo → assert `status`
    flips and `latest_commit_at` updates while `deadline_sha` is preserved.
  - Non-owner GET → 403; unknown assignment → 404; assignment with null deadline → rows with
    `status: null`, `dueState: 'no-deadline'`.

## 10. File structure summary

**New:**

- `migrations/0004_deadline_evaluation.sql`
- `src/lib/domain/deadline.ts`
- `src/lib/github/commits.ts`
- `src/lib/db/submissions.ts`
- `src/lib/domain/evaluation.ts`
- `src/pages/api/assignments/[id]/submissions.ts`
- `test/unit/deadline.test.ts`, `test/unit/github-commits.test.ts`
- `test/integration/submissions-api.test.ts`

**Modified:**

- `src/lib/http/schemas.ts`, `src/pages/api/classrooms/[id]/assignments.ts`,
  `src/lib/db/assignments.ts` (drop grace).
- `test/integration/github-mock.ts` (commits responder).
- The grace-referencing tests listed in §4.1.

## 11. Out of scope / open items

- **Phase 4 (queue):** purpose reduced to large-class parallel evaluation; deferred and
  possibly dropped. Not built here.
- **History-rewrite window** before first evaluation (§2): accepted risk, no snapshotter.
- **"Missing" heuristic:** defined as "default branch has only the template-import commit at
  the deadline" (≤1 commit). A template with multiple seed commits would defeat the
  `>= 2` heuristic; revisit if a real template needs it (could compare the deadline tree SHA
  to the template's tree). Documented as a known limitation, not addressed in Phase 3.
- **No-deadline assignments:** surfaced as `status: null`; never evaluated.
