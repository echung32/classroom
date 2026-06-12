# Phase 5 — Grader Builder + Grading Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-student grading decisions and a "build grader repo via the GitHub Git Data API" capability (backend only — UI is Phase 6).

**Architecture:** Phase 3's lazy-evaluation modules are extended to also capture each repo's `latest_sha` and to carry a teacher-set `grade_decision`. A new pure domain module (`grader.ts`) selects which commit to pin per student and builds the grader repo's file contents. Thin injectable Git Data API wrappers (`git-data.ts`) and a `deps`-injected orchestrator (`grader-build.ts`) assemble `org/grader-{slug}` with one git-submodule gitlink per included student, pinned at the decision-selected SHA. Two owner-only endpoints expose setting a decision and triggering a build.

**Tech Stack:** Astro (API routes), Cloudflare Workers, D1 (SQLite), Valibot (request validation), Vitest (unit) + `@cloudflare/vitest-pool-workers` (integration), GitHub Git Data API.

**Spec:** `docs/superpowers/specs/2026-06-12-classroom-phase-5-grader-builder-design.md`

---

## File Structure

**New files:**
- `migrations/0005_grading_decisions.sql` — adds `latest_sha`, `grade_decision` to `submissions`.
- `src/lib/domain/grader.ts` — pure: `selectGraderEntries`, `buildGitmodules`, `buildDevcontainer`, `buildReadme`. No I/O.
- `src/lib/github/git-data.ts` — injectable Git Data API wrappers (one `githubRequest` each).
- `src/lib/domain/grader-build.ts` — `deps`-injected `buildGrader` orchestrator.
- `src/pages/api/assignments/[id]/submissions/[studentId]/decision.ts` — `PUT` decision endpoint.
- `src/pages/api/assignments/[id]/grader.ts` — `POST` build endpoint.
- `test/unit/grader.test.ts`, `test/unit/git-data.test.ts` — unit tests.
- `test/integration/decision-api.test.ts`, `test/integration/grader-api.test.ts` — integration tests.

**Modified files:**
- `src/lib/github/commits.ts` — `readRepoCommitState` also returns `latestSha`.
- `src/lib/db/submissions.ts` — `Submission`/`SubmissionRow`/`toSubmission` gain `latestSha`+`gradeDecision`; `freezeSubmission`/`refreshSubmissionStatus` persist `latest_sha`; new `setGradeDecision`, `listSubmissionsWithStudents`.
- `src/lib/db/assignments.ts` — new `setGraderBuilt`.
- `src/lib/domain/evaluation.ts` — thread `latestSha`; expose `latestSha`/`gradeDecision` in views.
- `src/lib/http/schemas.ts` — `decisionSchema` (Valibot enum).
- `test/integration/github-mock.ts` — Git Data API responders.
- `test/unit/github-commits.test.ts` — assert `latestSha`.

---

## Task 1: Migration — add `latest_sha` and `grade_decision`

**Files:**
- Create: `migrations/0005_grading_decisions.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0005_grading_decisions.sql` (mirrors the plain-DDL style of `migrations/0004_deadline_evaluation.sql`):

```sql
-- Phase 5: grading decisions + the latest-commit SHA needed to pin accept_late
-- students to real post-deadline work. `latest_sha` is captured/refreshed during
-- evaluation alongside `latest_commit_at`. `grade_decision` is teacher intent —
-- set via the decision endpoint, never recomputed, preserved across re-evaluation.

ALTER TABLE submissions ADD COLUMN latest_sha TEXT;
ALTER TABLE submissions ADD COLUMN grade_decision TEXT NOT NULL DEFAULT 'at_deadline';
```

- [ ] **Step 2: Verify the migration applies cleanly**

Run: `yarn build && npx wrangler d1 migrations list classroom --local 2>/dev/null || true`

Then confirm the SQL parses by applying migrations into a throwaway local D1 via the integration build (the integration harness calls `readD1Migrations("./migrations")` at startup, so a later integration run is the real check). For now just confirm the file is syntactically valid SQL:

Run: `yarn build`
Expected: build succeeds (no migration is parsed at build time, but this confirms nothing else broke).

- [ ] **Step 3: Commit**

```bash
git add migrations/0005_grading_decisions.sql
git commit -m "feat(db): migration 0005 — latest_sha + grade_decision on submissions"
```

---

## Task 2: `readRepoCommitState` returns `latestSha`

**Files:**
- Modify: `src/lib/github/commits.ts`
- Test: `test/unit/github-commits.test.ts`

- [ ] **Step 1: Add the failing assertion to the unit test**

Open `test/unit/github-commits.test.ts`. The first test calls `readRepoCommitState` and asserts on its return. Add an assertion that the returned object includes `latestSha` equal to the first (unfiltered) commit's `sha`. Locate the existing happy-path test (the one whose `fetchImpl` returns two commits for the unfiltered call) and add, after its existing assertions:

```typescript
expect(state.latestSha).toBe("latest-sha");
```

Then update that test's mock so the unfiltered (`per_page=2`, no `until`) branch returns commits carrying a `sha`:

```typescript
// in the fetchImpl for the NON-until branch, ensure objects look like:
return jsonResponse([
  { sha: "latest-sha", commit: { committer: { date: "2026-01-02T00:00:00Z" } } },
  { sha: "template-sha", commit: { committer: { date: "2025-12-30T00:00:00Z" } } },
]);
```

Also add a test that an empty-repo (no commits) yields `latestSha === null`:

```typescript
it("returns latestSha=null for a repo with no commits", async () => {
  const fetchImpl = vi.fn(async () => jsonResponse([]));
  const state = await readRepoCommitState({
    token: "ghs_x",
    owner: "org",
    repo: "empty",
    deadlineAt: DEADLINE,
    fetchImpl,
  });
  expect(state.latestSha).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit -- github-commits`
Expected: FAIL — `state.latestSha` is `undefined` (property does not exist yet).

- [ ] **Step 3: Implement `latestSha`**

In `src/lib/github/commits.ts`, add `latestSha` to the `RepoCommitState` interface and compute it from the first element of the unfiltered commits call:

```typescript
export interface RepoCommitState {
  latestCommitAt: string | null;
  latestSha: string | null;
  hasStudentCommits: boolean;
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
}
```

In `readRepoCommitState`, after the `latest` request:

```typescript
  const latestCommitAt = latest.data[0]?.commit.committer.date ?? null;
  const latestSha = latest.data[0]?.sha ?? null;
  const hasStudentCommits = latest.data.length >= 2;
```

And update the returned object:

```typescript
  return { latestCommitAt, latestSha, hasStudentCommits, deadlineSha, deadlineCommitAt };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:unit -- github-commits`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/github/commits.ts test/unit/github-commits.test.ts
git commit -m "feat(github): readRepoCommitState returns latestSha"
```

---

## Task 3: `submissions` DB layer — expose + persist `latestSha`/`gradeDecision`

**Files:**
- Modify: `src/lib/db/submissions.ts`
- Test: `test/integration/submissions-db.test.ts` (create — small DB-level integration test)

> `submissions.ts` is exercised through D1, so its test lives in `test/integration/`. The pure-string builders get unit tests later (Task 6).

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/submissions-db.test.ts`:

```typescript
import { env } from "cloudflare:test";
import "./apply-migrations";
import { beforeEach, describe, expect, it } from "vitest";
import { createClassroom } from "../../src/lib/db/classrooms";
import { createAssignment } from "../../src/lib/db/assignments";
import { createStudent } from "../../src/lib/db/students";
import {
  freezeSubmission,
  getSubmission,
  refreshSubmissionStatus,
  setGradeDecision,
} from "../../src/lib/db/submissions";
import { seedUserAndCookie } from "./helpers";

async function seed() {
  const teacher = await seedUserAndCookie({ githubId: 700, login: "t700" });
  const classroom = await createClassroom(env.DB, {
    name: "CS", githubOrg: "org", timezone: "UTC", createdBy: teacher.user.id,
  });
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id, slug: "hw1", title: "HW1", templateRepo: "org/hw1-template",
    deadlineAt: "2026-01-01T00:00:00Z",
  });
  const student = await createStudent(env.DB, {
    classroomId: classroom.id, userId: teacher.user.id, githubUsername: "stud",
  });
  return { assignment, student };
}

describe("submissions DB: latest_sha + grade_decision", () => {
  it("freezeSubmission persists latest_sha and defaults grade_decision to at_deadline", async () => {
    const { assignment, student } = await seed();
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      deadlineSha: "dsha", deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestSha: "lsha", latestCommitAt: "2026-02-01T00:00:00Z", status: "late",
    });
    const sub = await getSubmission(env.DB, assignment.id, student.id);
    expect(sub?.latestSha).toBe("lsha");
    expect(sub?.gradeDecision).toBe("at_deadline");
    expect(sub?.deadlineSha).toBe("dsha");
  });

  it("refreshSubmissionStatus updates latest_sha but never deadline_sha or grade_decision", async () => {
    const { assignment, student } = await seed();
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      deadlineSha: "dsha", deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestSha: "lsha1", latestCommitAt: "2026-02-01T00:00:00Z", status: "late",
    });
    await setGradeDecision(env.DB, assignment.id, student.id, "accept_late");
    await refreshSubmissionStatus(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      latestSha: "lsha2", latestCommitAt: "2026-03-01T00:00:00Z", status: "late",
    });
    const sub = await getSubmission(env.DB, assignment.id, student.id);
    expect(sub?.latestSha).toBe("lsha2");
    expect(sub?.deadlineSha).toBe("dsha"); // immutable
    expect(sub?.gradeDecision).toBe("accept_late"); // preserved
  });

  it("freeze re-run preserves an existing grade_decision (ON CONFLICT does not touch it)", async () => {
    const { assignment, student } = await seed();
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      deadlineSha: "dsha", deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestSha: "lsha1", latestCommitAt: "2026-02-01T00:00:00Z", status: "late",
    });
    await setGradeDecision(env.DB, assignment.id, student.id, "exclude");
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      deadlineSha: "dsha-IGNORED", deadlineCommitAt: "1999-01-01T00:00:00Z",
      latestSha: "lsha2", latestCommitAt: "2026-04-01T00:00:00Z", status: "late",
    });
    const sub = await getSubmission(env.DB, assignment.id, student.id);
    expect(sub?.gradeDecision).toBe("exclude"); // preserved through ON CONFLICT
    expect(sub?.deadlineSha).toBe("dsha"); // COALESCE keeps original
    expect(sub?.latestSha).toBe("lsha2"); // refreshed
  });

  it("setGradeDecision returns false when no submission row exists", async () => {
    const { assignment } = await seed();
    const ok = await setGradeDecision(env.DB, assignment.id, "no-such-student", "exclude");
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- submissions-db`
Expected: FAIL — `freezeSubmission` has no `latestSha` param; `setGradeDecision` does not exist; `sub.gradeDecision`/`sub.latestSha` are `undefined`.

- [ ] **Step 3: Extend the `Submission` types and `toSubmission`**

In `src/lib/db/submissions.ts`, add the two fields to the public interface, the row interface, and the mapper:

```typescript
export interface Submission {
  assignmentId: string;
  studentId: string;
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
  latestSha: string | null;
  latestCommitAt: string | null;
  status: string;
  gradeDecision: string;
  evaluatedAt: string | null;
}

interface SubmissionRow {
  assignment_id: string;
  student_id: string;
  deadline_sha: string | null;
  deadline_commit_at: string | null;
  latest_sha: string | null;
  latest_commit_at: string | null;
  status: string;
  grade_decision: string;
  evaluated_at: string | null;
}

function toSubmission(row: SubmissionRow): Submission {
  return {
    assignmentId: row.assignment_id,
    studentId: row.student_id,
    deadlineSha: row.deadline_sha,
    deadlineCommitAt: row.deadline_commit_at,
    latestSha: row.latest_sha,
    latestCommitAt: row.latest_commit_at,
    status: row.status,
    gradeDecision: row.grade_decision,
    evaluatedAt: row.evaluated_at,
  };
}
```

- [ ] **Step 4: Persist `latest_sha` in `freezeSubmission`**

Add `latestSha` to the input and write it (refreshed, NOT COALESCE — only `deadline_sha`/`deadline_commit_at` stay immutable). The INSERT does **not** list `grade_decision` (DB default applies); the `ON CONFLICT DO UPDATE` does **not** touch `grade_decision`:

```typescript
export async function freezeSubmission(
  db: D1Database,
  input: {
    assignmentId: string;
    studentId: string;
    deadlineSha: string | null;
    deadlineCommitAt: string | null;
    latestSha: string | null;
    latestCommitAt: string | null;
    status: SubmissionStatus;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO submissions
         (assignment_id, student_id, deadline_sha, deadline_commit_at, latest_sha, latest_commit_at, status, evaluated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
       ON CONFLICT (assignment_id, student_id) DO UPDATE SET
         deadline_sha = COALESCE(deadline_sha, excluded.deadline_sha),
         deadline_commit_at = COALESCE(deadline_commit_at, excluded.deadline_commit_at),
         latest_sha = excluded.latest_sha,
         latest_commit_at = excluded.latest_commit_at,
         status = excluded.status,
         evaluated_at = excluded.evaluated_at`,
    )
    .bind(
      input.assignmentId,
      input.studentId,
      input.deadlineSha,
      input.deadlineCommitAt,
      input.latestSha,
      input.latestCommitAt,
      input.status,
    )
    .run();
}
```

- [ ] **Step 5: Persist `latest_sha` in `refreshSubmissionStatus`**

```typescript
export async function refreshSubmissionStatus(
  db: D1Database,
  input: {
    assignmentId: string;
    studentId: string;
    latestSha: string | null;
    latestCommitAt: string | null;
    status: SubmissionStatus;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE submissions
          SET status = ?3, latest_sha = ?4, latest_commit_at = ?5, evaluated_at = datetime('now')
        WHERE assignment_id = ?1 AND student_id = ?2`,
    )
    .bind(input.assignmentId, input.studentId, input.status, input.latestSha, input.latestCommitAt)
    .run();
}
```

- [ ] **Step 6: Add `setGradeDecision`**

Append to `src/lib/db/submissions.ts`:

```typescript
/** UPDATE grade_decision on an existing (evaluated) row. False when no row matched. */
export async function setGradeDecision(
  db: D1Database,
  assignmentId: string,
  studentId: string,
  decision: "at_deadline" | "accept_late" | "exclude",
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE submissions SET grade_decision = ?3 WHERE assignment_id = ?1 AND student_id = ?2",
    )
    .bind(assignmentId, studentId, decision)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `yarn test:integration -- submissions-db`
Expected: PASS (all four cases).

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/submissions.ts test/integration/submissions-db.test.ts
git commit -m "feat(db): submissions carry latest_sha + grade_decision; add setGradeDecision"
```

---

## Task 4: `listSubmissionsWithStudents` DB helper

**Files:**
- Modify: `src/lib/db/submissions.ts`
- Test: `test/integration/submissions-db.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `test/integration/submissions-db.test.ts` (import `listSubmissionsWithStudents` from `../../src/lib/db/submissions`):

```typescript
describe("listSubmissionsWithStudents", () => {
  it("joins submissions → students → assignments and builds the student repo name", async () => {
    const { assignment, student } = await seed();
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      deadlineSha: "dsha", deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestSha: "lsha", latestCommitAt: "2026-02-01T00:00:00Z", status: "late",
    });
    const rows = await listSubmissionsWithStudents(env.DB, assignment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      studentId: student.id,
      githubUsername: "stud",
      repoName: "hw1-stud",
      gradeDecision: "at_deadline",
      deadlineSha: "dsha",
      latestSha: "lsha",
      status: "late",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- submissions-db`
Expected: FAIL — `listSubmissionsWithStudents` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `src/lib/db/submissions.ts`:

```typescript
export interface SubmissionWithStudent {
  studentId: string;
  githubUsername: string | null;
  /** The student repo name `{slug}-{username}`; null when the student has no linked GitHub username. */
  repoName: string | null;
  gradeDecision: string;
  deadlineSha: string | null;
  latestSha: string | null;
  status: string;
}

/**
 * Submissions for an assignment, joined to students and the assignment, yielding
 * the student repo name (`{slug}-{username}`) the grader build needs. Reuses the
 * join shape of listReposWithStudentsByAssignment.
 */
export async function listSubmissionsWithStudents(
  db: D1Database,
  assignmentId: string,
): Promise<SubmissionWithStudent[]> {
  const { results } = await db
    .prepare(
      `SELECT sub.student_id,
              s.github_username,
              a.slug,
              sub.grade_decision,
              sub.deadline_sha,
              sub.latest_sha,
              sub.status
         FROM submissions sub
         JOIN students s ON s.id = sub.student_id
         JOIN assignments a ON a.id = sub.assignment_id
        WHERE sub.assignment_id = ?1
        ORDER BY s.github_username ASC`,
    )
    .bind(assignmentId)
    .all<{
      student_id: string;
      github_username: string | null;
      slug: string;
      grade_decision: string;
      deadline_sha: string | null;
      latest_sha: string | null;
      status: string;
    }>();
  return results.map((r) => ({
    studentId: r.student_id,
    githubUsername: r.github_username,
    repoName: r.github_username ? `${r.slug}-${r.github_username}` : null,
    gradeDecision: r.grade_decision,
    deadlineSha: r.deadline_sha,
    latestSha: r.latest_sha,
    status: r.status,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- submissions-db`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/submissions.ts test/integration/submissions-db.test.ts
git commit -m "feat(db): listSubmissionsWithStudents for grader build"
```

---

## Task 5: `setGraderBuilt` on assignments

**Files:**
- Modify: `src/lib/db/assignments.ts`
- Test: `test/integration/submissions-db.test.ts` (extend) — or a new small test; keep it here for cohesion.

- [ ] **Step 1: Write the failing test**

Add to `test/integration/submissions-db.test.ts` (import `setGraderBuilt` and `getAssignmentById` from `../../src/lib/db/assignments`):

```typescript
describe("setGraderBuilt", () => {
  it("sets grader_repo and status='built'", async () => {
    const { assignment } = await seed();
    await setGraderBuilt(env.DB, assignment.id, "org/grader-hw1");
    const after = await getAssignmentById(env.DB, assignment.id);
    expect(after?.graderRepo).toBe("org/grader-hw1");
    expect(after?.status).toBe("built");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- submissions-db`
Expected: FAIL — `setGraderBuilt` is not exported.

- [ ] **Step 3: Implement `setGraderBuilt`**

Append to `src/lib/db/assignments.ts`:

```typescript
/** Mark an assignment's grader as built: record grader_repo and flip status to 'built'. */
export async function setGraderBuilt(
  db: D1Database,
  assignmentId: string,
  graderRepo: string,
): Promise<void> {
  await db
    .prepare("UPDATE assignments SET grader_repo = ?2, status = 'built' WHERE id = ?1")
    .bind(assignmentId, graderRepo)
    .run();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- submissions-db`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/assignments.ts test/integration/submissions-db.test.ts
git commit -m "feat(db): setGraderBuilt records grader_repo + status='built'"
```

---

## Task 6: Pure pin-selection + content builders (`grader.ts`)

**Files:**
- Create: `src/lib/domain/grader.ts`
- Test: `test/unit/grader.test.ts`

> `GraderEntry` carries `repoName` (the `{slug}-{username}` student repo) because the content builders need it per §4.2; the build orchestrator and endpoint expose only `{ username, sha, source }` to callers, so the extra field is internal.

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/grader.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  buildDevcontainer,
  buildGitmodules,
  buildReadme,
  selectGraderEntries,
  type SubmissionForSelection,
} from "../../src/lib/domain/grader";

function sub(over: Partial<SubmissionForSelection>): SubmissionForSelection {
  return {
    studentId: "s",
    githubUsername: "user",
    repoName: "hw1-user",
    gradeDecision: "at_deadline",
    deadlineSha: "dsha",
    latestSha: "lsha",
    ...over,
  };
}

describe("selectGraderEntries", () => {
  it("pins deadline_sha for at_deadline and latest_sha for accept_late; excludes exclude", () => {
    const { included, skipped } = selectGraderEntries([
      sub({ studentId: "a", githubUsername: "ada", repoName: "hw1-ada", gradeDecision: "at_deadline", deadlineSha: "d-a", latestSha: "l-a" }),
      sub({ studentId: "b", githubUsername: "ben", repoName: "hw1-ben", gradeDecision: "accept_late", deadlineSha: "d-b", latestSha: "l-b" }),
      sub({ studentId: "c", githubUsername: "cid", repoName: "hw1-cid", gradeDecision: "exclude", deadlineSha: "d-c", latestSha: "l-c" }),
    ]);
    expect(included).toEqual([
      { username: "ada", repoName: "hw1-ada", sha: "d-a", source: "deadline" },
      { username: "ben", repoName: "hw1-ben", sha: "l-b", source: "latest" },
    ]);
    expect(skipped).toEqual([{ username: "cid", studentId: "c", reason: "excluded" }]);
  });

  it("skips a null selected SHA with the matching reason (not a failure)", () => {
    const { included, skipped } = selectGraderEntries([
      sub({ studentId: "a", githubUsername: "ada", gradeDecision: "at_deadline", deadlineSha: null }),
      sub({ studentId: "b", githubUsername: "ben", gradeDecision: "accept_late", latestSha: null }),
    ]);
    expect(included).toEqual([]);
    expect(skipped).toEqual([
      { username: "ada", studentId: "a", reason: "no-deadline-sha" },
      { username: "ben", studentId: "b", reason: "no-latest-sha" },
    ]);
  });

  it("skips a student with no github username", () => {
    const { included, skipped } = selectGraderEntries([
      sub({ studentId: "a", githubUsername: null, repoName: null }),
    ]);
    expect(included).toEqual([]);
    expect(skipped).toEqual([{ username: null, studentId: "a", reason: "no-github-username" }]);
  });

  it("orders included entries deterministically by username", () => {
    const { included } = selectGraderEntries([
      sub({ studentId: "z", githubUsername: "zed", repoName: "hw1-zed", deadlineSha: "d-z" }),
      sub({ studentId: "a", githubUsername: "ann", repoName: "hw1-ann", deadlineSha: "d-a" }),
    ]);
    expect(included.map((e) => e.username)).toEqual(["ann", "zed"]);
  });
});

describe("buildGitmodules", () => {
  it("emits one submodule block per entry, ordered by username", () => {
    const text = buildGitmodules(
      [
        { username: "ann", repoName: "hw1-ann", sha: "x", source: "deadline" },
        { username: "zed", repoName: "hw1-zed", sha: "y", source: "latest" },
      ],
      "org",
    );
    expect(text).toBe(
      `[submodule "submissions/ann"]\n` +
        `\tpath = submissions/ann\n` +
        `\turl = https://github.com/org/hw1-ann.git\n` +
        `[submodule "submissions/zed"]\n` +
        `\tpath = submissions/zed\n` +
        `\turl = https://github.com/org/hw1-zed.git\n`,
    );
  });
});

describe("buildDevcontainer", () => {
  it("includes one codespaces repositories read entry per included repo + postCreateCommand", () => {
    const text = buildDevcontainer(
      [
        { username: "ann", repoName: "hw1-ann", sha: "x", source: "deadline" },
        { username: "zed", repoName: "hw1-zed", sha: "y", source: "latest" },
      ],
      "org",
      "grader-hw1",
    );
    const obj = JSON.parse(text);
    expect(obj.name).toBe("grader-hw1");
    expect(obj.postCreateCommand).toBe("git submodule update --init --recursive");
    expect(obj.customizations.codespaces.repositories).toEqual({
      "org/hw1-ann": { permissions: { contents: "read" } },
      "org/hw1-zed": { permissions: { contents: "read" } },
    });
  });
});

describe("buildReadme", () => {
  it("names the assignment and lists pinned submissions", () => {
    const text = buildReadme("Assignment 3", [
      { username: "ann", repoName: "hw1-ann", sha: "abc123", source: "deadline" },
    ]);
    expect(text).toContain("Assignment 3");
    expect(text).toContain("ann");
    expect(text).toContain("abc123");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit -- grader`
Expected: FAIL — module `src/lib/domain/grader.ts` does not exist.

- [ ] **Step 3: Implement `grader.ts`**

Create `src/lib/domain/grader.ts`:

```typescript
export interface SubmissionForSelection {
  studentId: string;
  githubUsername: string | null;
  /** `{slug}-{username}` student repo name; null when the student has no GitHub username. */
  repoName: string | null;
  gradeDecision: string;
  deadlineSha: string | null;
  latestSha: string | null;
}

export interface GraderEntry {
  username: string;
  repoName: string;
  sha: string;
  source: "deadline" | "latest";
}

export interface SkippedEntry {
  username: string | null;
  studentId: string;
  reason: string;
}

/**
 * Decide which submissions get pinned into the grader and why each omission happened.
 * Pure: deterministic ordering (by username) so rebuilds are reproducible.
 */
export function selectGraderEntries(submissions: SubmissionForSelection[]): {
  included: GraderEntry[];
  skipped: SkippedEntry[];
} {
  const included: GraderEntry[] = [];
  const skipped: SkippedEntry[] = [];

  for (const s of submissions) {
    if (s.githubUsername === null || s.repoName === null) {
      skipped.push({ username: s.githubUsername, studentId: s.studentId, reason: "no-github-username" });
      continue;
    }
    if (s.gradeDecision === "exclude") {
      skipped.push({ username: s.githubUsername, studentId: s.studentId, reason: "excluded" });
      continue;
    }
    if (s.gradeDecision === "accept_late") {
      if (s.latestSha === null) {
        skipped.push({ username: s.githubUsername, studentId: s.studentId, reason: "no-latest-sha" });
        continue;
      }
      included.push({ username: s.githubUsername, repoName: s.repoName, sha: s.latestSha, source: "latest" });
      continue;
    }
    // default: at_deadline
    if (s.deadlineSha === null) {
      skipped.push({ username: s.githubUsername, studentId: s.studentId, reason: "no-deadline-sha" });
      continue;
    }
    included.push({ username: s.githubUsername, repoName: s.repoName, sha: s.deadlineSha, source: "deadline" });
  }

  included.sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
  return { included, skipped };
}

/** The `.gitmodules` text — one block per included entry, tab-indented, trailing newline. */
export function buildGitmodules(entries: GraderEntry[], org: string): string {
  return entries
    .map(
      (e) =>
        `[submodule "submissions/${e.username}"]\n` +
        `\tpath = submissions/${e.username}\n` +
        `\turl = https://github.com/${org}/${e.repoName}.git\n`,
    )
    .join("");
}

/**
 * The `.devcontainer/devcontainer.json` text. Each included student repo gets a
 * codespaces read grant, without which the private submodules can't be cloned in
 * a Codespace. Built as a structured object → JSON.stringify (safe escaping,
 * deterministic key order since `entries` is pre-sorted by username).
 */
export function buildDevcontainer(entries: GraderEntry[], org: string, name: string): string {
  const repositories: Record<string, { permissions: { contents: string } }> = {};
  for (const e of entries) {
    repositories[`${org}/${e.repoName}`] = { permissions: { contents: "read" } };
  }
  const obj = {
    name,
    image: "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
    features: { "ghcr.io/devcontainers/features/git:1": {} },
    customizations: { codespaces: { repositories } },
    postCreateCommand: "git submodule update --init --recursive",
  };
  return JSON.stringify(obj, null, 2);
}

/** A short informational top-level README naming the assignment and its pinned submissions. */
export function buildReadme(assignmentTitle: string, entries: GraderEntry[]): string {
  const lines = entries.map((e) => `- \`submissions/${e.username}\` → ${e.repoName} @ \`${e.sha}\` (${e.source})`);
  return (
    `# Grader: ${assignmentTitle}\n\n` +
    `Pinned submissions (${entries.length}):\n\n` +
    `${lines.join("\n")}\n`
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:unit -- grader`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/grader.ts test/unit/grader.test.ts
git commit -m "feat(domain): grader pin-selection + content builders (pure)"
```

---

## Task 7: Git Data API wrappers (`git-data.ts`)

**Files:**
- Create: `src/lib/github/git-data.ts`
- Test: `test/unit/git-data.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/git-data.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import {
  createCommit,
  createMainRef,
  createTree,
  ensureOrgRepo,
  getMainRef,
  updateMainRef,
} from "../../src/lib/github/git-data";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ensureOrgRepo", () => {
  it("POSTs /orgs/{org}/repos with private:true and returns fullName/htmlUrl", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { full_name: "org/grader-hw1", html_url: "https://github.com/org/grader-hw1" }),
    );
    const res = await ensureOrgRepo({ token: "t", org: "org", name: "grader-hw1", fetchImpl });
    expect(res).toEqual({ fullName: "org/grader-hw1", htmlUrl: "https://github.com/org/grader-hw1" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("https://api.github.com/orgs/org/repos");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ name: "grader-hw1", private: true });
  });

  it("on 422 (already exists) confirms via GET /repos/{org}/{name}", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(422, { message: "name already exists" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { full_name: "org/grader-hw1", html_url: "https://github.com/org/grader-hw1" }),
      );
    const res = await ensureOrgRepo({ token: "t", org: "org", name: "grader-hw1", fetchImpl });
    expect(res.fullName).toBe("org/grader-hw1");
    expect(String((fetchImpl.mock.calls[1] as [string])[0])).toBe("https://api.github.com/repos/org/grader-hw1");
  });
});

describe("createTree", () => {
  it("POSTs the tree entries (no base_tree) and returns the sha", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { sha: "tree-sha" }));
    const tree = [{ path: "README.md", mode: "100644", type: "blob", content: "hi" }];
    const sha = await createTree({ token: "t", org: "org", repo: "grader-hw1", tree, fetchImpl });
    expect(sha).toBe("tree-sha");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("https://api.github.com/repos/org/grader-hw1/git/trees");
    expect(JSON.parse(String(init.body))).toEqual({ tree });
  });
});

describe("createCommit", () => {
  it("POSTs message/tree/parents and returns the commit sha", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { sha: "commit-sha" }));
    const sha = await createCommit({
      token: "t", org: "org", repo: "grader-hw1", message: "build", tree: "tree-sha", parents: [], fetchImpl,
    });
    expect(sha).toBe("commit-sha");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("https://api.github.com/repos/org/grader-hw1/git/commits");
    expect(JSON.parse(String(init.body))).toEqual({ message: "build", tree: "tree-sha", parents: [] });
  });
});

describe("getMainRef", () => {
  it("returns the sha from git/ref/heads/main", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { object: { sha: "main-sha" } }));
    const sha = await getMainRef({ token: "t", org: "org", repo: "grader-hw1", fetchImpl });
    expect(sha).toBe("main-sha");
    expect(String((fetchImpl.mock.calls[0] as [string])[0])).toBe(
      "https://api.github.com/repos/org/grader-hw1/git/ref/heads/main",
    );
  });

  it("returns null on 404 (first build, no commits yet)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { message: "Not Found" }));
    const sha = await getMainRef({ token: "t", org: "org", repo: "grader-hw1", fetchImpl });
    expect(sha).toBeNull();
  });
});

describe("createMainRef / updateMainRef", () => {
  it("createMainRef POSTs refs/heads/main", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { ref: "refs/heads/main" }));
    await createMainRef({ token: "t", org: "org", repo: "grader-hw1", sha: "c", fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("https://api.github.com/repos/org/grader-hw1/git/refs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ ref: "refs/heads/main", sha: "c" });
  });

  it("updateMainRef PATCHes git/refs/heads/main with force:false", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ref: "refs/heads/main" }));
    await updateMainRef({ token: "t", org: "org", repo: "grader-hw1", sha: "c", fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("https://api.github.com/repos/org/grader-hw1/git/refs/heads/main");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ sha: "c", force: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit -- git-data`
Expected: FAIL — module `src/lib/github/git-data.ts` does not exist.

- [ ] **Step 3: Implement `git-data.ts`**

Create `src/lib/github/git-data.ts`:

```typescript
import { GitHubApiError, githubRequest } from "./client";

/** A single entry in a git tree: an inline text blob or a submodule gitlink. */
export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "commit";
  content?: string;
  sha?: string;
}

/**
 * Create the grader repo, or recover the existing one. POST /orgs/{org}/repos
 * with private:true; on 422 (already exists) confirm via GET (keys on status,
 * not the fragile body message — mirrors createRepoFromTemplate).
 */
export async function ensureOrgRepo(input: {
  token: string;
  org: string;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<{ fullName: string; htmlUrl: string }> {
  const { token, org, name, fetchImpl } = input;
  try {
    const { data } = await githubRequest<{ full_name: string; html_url: string }>(
      `/orgs/${org}/repos`,
      { method: "POST", token, body: { name, private: true }, fetchImpl },
    );
    return { fullName: data.full_name, htmlUrl: data.html_url };
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 422) {
      const { data } = await githubRequest<{ full_name: string; html_url: string }>(
        `/repos/${org}/${name}`,
        { token, fetchImpl },
      );
      return { fullName: data.full_name, htmlUrl: data.html_url };
    }
    throw err;
  }
}

/** Create a git tree from inline entries (no base_tree). Returns the new tree SHA. */
export async function createTree(input: {
  token: string;
  org: string;
  repo: string;
  tree: TreeEntry[];
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { token, org, repo, tree, fetchImpl } = input;
  const { data } = await githubRequest<{ sha: string }>(
    `/repos/${org}/${repo}/git/trees`,
    { method: "POST", token, body: { tree }, fetchImpl },
  );
  return data.sha;
}

/** Create a commit pointing at a tree. Returns the new commit SHA. */
export async function createCommit(input: {
  token: string;
  org: string;
  repo: string;
  message: string;
  tree: string;
  parents: string[];
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { token, org, repo, message, tree, parents, fetchImpl } = input;
  const { data } = await githubRequest<{ sha: string }>(
    `/repos/${org}/${repo}/git/commits`,
    { method: "POST", token, body: { message, tree, parents }, fetchImpl },
  );
  return data.sha;
}

/** The current main-branch SHA, or null on 404 (first build, no commits yet). */
export async function getMainRef(input: {
  token: string;
  org: string;
  repo: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const { token, org, repo, fetchImpl } = input;
  try {
    const { data } = await githubRequest<{ object: { sha: string } }>(
      `/repos/${org}/${repo}/git/ref/heads/main`,
      { token, fetchImpl },
    );
    return data.object.sha;
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return null;
    throw err;
  }
}

/** Create refs/heads/main pointing at a commit (first build). */
export async function createMainRef(input: {
  token: string;
  org: string;
  repo: string;
  sha: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { token, org, repo, sha, fetchImpl } = input;
  await githubRequest(`/repos/${org}/${repo}/git/refs`, {
    method: "POST",
    token,
    body: { ref: "refs/heads/main", sha },
    fetchImpl,
  });
}

/** Fast-forward main to a new commit (rebuild). force:false keeps it non-destructive. */
export async function updateMainRef(input: {
  token: string;
  org: string;
  repo: string;
  sha: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { token, org, repo, sha, fetchImpl } = input;
  await githubRequest(`/repos/${org}/${repo}/git/refs/heads/main`, {
    method: "PATCH",
    token,
    body: { sha, force: false },
    fetchImpl,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:unit -- git-data`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/github/git-data.ts test/unit/git-data.test.ts
git commit -m "feat(github): Git Data API wrappers (repos/trees/commits/refs)"
```

---

## Task 8: Build orchestration (`grader-build.ts`)

**Files:**
- Create: `src/lib/domain/grader-build.ts`
- Test: `test/unit/grader-build.test.ts`

> Reuses `AssignmentNotFoundError` from `evaluation.ts` (endpoints already map it to 404). The 400-guard cases throw `ValidationError` from `http/errors` — `assignments.ts` already imports from that module, so domain→http-error coupling has precedent and `toResponse` maps `ValidationError` → 400 cleanly.

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/grader-build.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../src/lib/http/errors";
import { AssignmentNotFoundError } from "../../src/lib/domain/evaluation";
import { buildGrader, type GraderBuildDeps } from "../../src/lib/domain/grader-build";

const DEADLINE = "2026-01-01T00:00:00Z";
const AFTER = "2026-02-01T00:00:00Z";
const BEFORE = "2025-12-01T00:00:00Z";

function makeDeps(over: Partial<GraderBuildDeps> = {}): GraderBuildDeps {
  return {
    token: "t",
    fetchImpl: vi.fn(),
    loadAssignment: vi.fn(async () => ({
      id: "a1", classroomId: "c1", slug: "hw1", title: "HW 1", deadlineAt: DEADLINE,
    })),
    loadClassroom: vi.fn(async () => ({ id: "c1", githubOrg: "org" })),
    listSubmissionsWithStudents: vi.fn(async () => [
      { studentId: "s1", githubUsername: "ada", repoName: "hw1-ada", gradeDecision: "at_deadline", deadlineSha: "d-ada", latestSha: "l-ada", status: "on_time" },
    ]),
    setGraderBuilt: vi.fn(async () => {}),
    ensureOrgRepo: vi.fn(async () => ({ fullName: "org/grader-hw1", htmlUrl: "https://github.com/org/grader-hw1" })),
    createTree: vi.fn(async () => "tree-sha"),
    getMainRef: vi.fn(async () => null),
    createCommit: vi.fn(async () => "commit-sha"),
    createMainRef: vi.fn(async () => {}),
    updateMainRef: vi.fn(async () => {}),
    ...over,
  };
}

describe("buildGrader", () => {
  it("builds the grader, pins included SHAs, sets grader_repo + returns the result", async () => {
    const deps = makeDeps();
    const result = await buildGrader(deps, { assignmentId: "a1", now: AFTER });
    expect(result.graderRepo).toBe("org/grader-hw1");
    expect(result.htmlUrl).toBe("https://github.com/org/grader-hw1");
    expect(result.commitSha).toBe("commit-sha");
    expect(result.included).toEqual([{ username: "ada", sha: "d-ada", source: "deadline" }]);
    expect(result.skipped).toEqual([]);
    expect(deps.ensureOrgRepo).toHaveBeenCalledWith(expect.objectContaining({ org: "org", name: "grader-hw1" }));
    expect(deps.setGraderBuilt).toHaveBeenCalledWith("a1", "org/grader-hw1");
    // first build: no parent → createMainRef, not updateMainRef
    expect(deps.createMainRef).toHaveBeenCalledOnce();
    expect(deps.updateMainRef).not.toHaveBeenCalled();
    // the tree carries a 160000 gitlink for the included entry
    const treeArg = (deps.createTree as ReturnType<typeof vi.fn>).mock.calls[0][0].tree;
    expect(treeArg).toContainEqual({ path: "submissions/ada", mode: "160000", type: "commit", sha: "d-ada" });
  });

  it("updates main when a parent ref exists (rebuild)", async () => {
    const deps = makeDeps({ getMainRef: vi.fn(async () => "old-sha") });
    await buildGrader(deps, { assignmentId: "a1", now: AFTER });
    expect(deps.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: ["old-sha"] }));
    expect(deps.updateMainRef).toHaveBeenCalledOnce();
    expect(deps.createMainRef).not.toHaveBeenCalled();
  });

  it("throws AssignmentNotFoundError when the assignment is missing", async () => {
    const deps = makeDeps({ loadAssignment: vi.fn(async () => null) });
    await expect(buildGrader(deps, { assignmentId: "a1", now: AFTER })).rejects.toBeInstanceOf(
      AssignmentNotFoundError,
    );
  });

  it("rejects with 400 (ValidationError) when the deadline has not passed", async () => {
    const deps = makeDeps();
    await expect(buildGrader(deps, { assignmentId: "a1", now: BEFORE })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(deps.ensureOrgRepo).not.toHaveBeenCalled();
  });

  it("rejects with 400 when there is no deadline at all", async () => {
    const deps = makeDeps({
      loadAssignment: vi.fn(async () => ({ id: "a1", classroomId: "c1", slug: "hw1", title: "HW 1", deadlineAt: null })),
    });
    await expect(buildGrader(deps, { assignmentId: "a1", now: AFTER })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects with 400 when nothing is includable (all skipped)", async () => {
    const deps = makeDeps({
      listSubmissionsWithStudents: vi.fn(async () => [
        { studentId: "s1", githubUsername: "ada", repoName: "hw1-ada", gradeDecision: "exclude", deadlineSha: "d", latestSha: "l", status: "on_time" },
      ]),
    });
    await expect(buildGrader(deps, { assignmentId: "a1", now: AFTER })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(deps.ensureOrgRepo).not.toHaveBeenCalled();
  });

  it("reports skipped entries in the result", async () => {
    const deps = makeDeps({
      listSubmissionsWithStudents: vi.fn(async () => [
        { studentId: "s1", githubUsername: "ada", repoName: "hw1-ada", gradeDecision: "at_deadline", deadlineSha: "d-ada", latestSha: "l-ada", status: "on_time" },
        { studentId: "s2", githubUsername: "ben", repoName: "hw1-ben", gradeDecision: "exclude", deadlineSha: "d", latestSha: "l", status: "on_time" },
      ]),
    });
    const result = await buildGrader(deps, { assignmentId: "a1", now: AFTER });
    expect(result.included.map((e) => e.username)).toEqual(["ada"]);
    expect(result.skipped).toEqual([{ username: "ben", studentId: "s2", reason: "excluded" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit -- grader-build`
Expected: FAIL — module `src/lib/domain/grader-build.ts` does not exist.

- [ ] **Step 3: Implement `grader-build.ts`**

Create `src/lib/domain/grader-build.ts`:

```typescript
import { ValidationError } from "../http/errors";
import type { TreeEntry } from "../github/git-data";
import {
  buildDevcontainer,
  buildGitmodules,
  buildReadme,
  selectGraderEntries,
  type GraderEntry,
  type SkippedEntry,
  type SubmissionForSelection,
} from "./grader";
import { AssignmentNotFoundError } from "./evaluation";

interface AssignmentForBuild {
  id: string;
  classroomId: string;
  slug: string;
  title: string;
  deadlineAt: string | null;
}
interface ClassroomForBuild {
  id: string;
  githubOrg: string;
}

export interface GraderBuildDeps {
  token: string;
  fetchImpl?: typeof fetch;
  loadAssignment: (id: string) => Promise<AssignmentForBuild | null>;
  loadClassroom: (id: string) => Promise<ClassroomForBuild | null>;
  listSubmissionsWithStudents: (assignmentId: string) => Promise<SubmissionForSelection[]>;
  setGraderBuilt: (assignmentId: string, graderRepo: string) => Promise<void>;
  ensureOrgRepo: (input: {
    token: string;
    org: string;
    name: string;
    fetchImpl?: typeof fetch;
  }) => Promise<{ fullName: string; htmlUrl: string }>;
  createTree: (input: {
    token: string;
    org: string;
    repo: string;
    tree: TreeEntry[];
    fetchImpl?: typeof fetch;
  }) => Promise<string>;
  getMainRef: (input: {
    token: string;
    org: string;
    repo: string;
    fetchImpl?: typeof fetch;
  }) => Promise<string | null>;
  createCommit: (input: {
    token: string;
    org: string;
    repo: string;
    message: string;
    tree: string;
    parents: string[];
    fetchImpl?: typeof fetch;
  }) => Promise<string>;
  createMainRef: (input: {
    token: string;
    org: string;
    repo: string;
    sha: string;
    fetchImpl?: typeof fetch;
  }) => Promise<void>;
  updateMainRef: (input: {
    token: string;
    org: string;
    repo: string;
    sha: string;
    fetchImpl?: typeof fetch;
  }) => Promise<void>;
}

export interface GraderBuildResult {
  graderRepo: string;
  htmlUrl: string;
  commitSha: string;
  included: { username: string; sha: string; source: "deadline" | "latest" }[];
  skipped: SkippedEntry[];
}

/**
 * Assemble org/grader-{slug} via the Git Data API only. Requires submissions to
 * already be evaluated (decide-first-then-build). The whole tree is rebuilt every
 * time (no base_tree) so re-runs pick up changed decisions and are idempotent.
 */
export async function buildGrader(
  deps: GraderBuildDeps,
  input: { assignmentId: string; now: string },
): Promise<GraderBuildResult> {
  const assignment = await deps.loadAssignment(input.assignmentId);
  if (!assignment) throw new AssignmentNotFoundError();

  if (assignment.deadlineAt === null || Date.parse(input.now) < Date.parse(assignment.deadlineAt)) {
    throw new ValidationError("Cannot build a grader before the assignment deadline has passed");
  }

  const classroom = await deps.loadClassroom(assignment.classroomId);
  if (!classroom) throw new AssignmentNotFoundError();

  const submissions = await deps.listSubmissionsWithStudents(assignment.id);
  const { included, skipped } = selectGraderEntries(submissions);
  if (included.length === 0) {
    throw new ValidationError("Nothing to build: no submissions are eligible for the grader");
  }

  const org = classroom.githubOrg;
  const name = `grader-${assignment.slug}`;
  const repo = await deps.ensureOrgRepo({ token: deps.token, org, name, fetchImpl: deps.fetchImpl });

  const tree = buildTree(included, org, name, assignment.title);
  const treeSha = await deps.createTree({ token: deps.token, org, repo: name, tree, fetchImpl: deps.fetchImpl });

  const parent = await deps.getMainRef({ token: deps.token, org, repo: name, fetchImpl: deps.fetchImpl });
  const commitSha = await deps.createCommit({
    token: deps.token,
    org,
    repo: name,
    message: `Build grader for ${assignment.title}`,
    tree: treeSha,
    parents: parent ? [parent] : [],
    fetchImpl: deps.fetchImpl,
  });

  if (parent) {
    await deps.updateMainRef({ token: deps.token, org, repo: name, sha: commitSha, fetchImpl: deps.fetchImpl });
  } else {
    await deps.createMainRef({ token: deps.token, org, repo: name, sha: commitSha, fetchImpl: deps.fetchImpl });
  }

  const graderRepo = `${org}/${name}`;
  await deps.setGraderBuilt(assignment.id, graderRepo);

  return {
    graderRepo,
    htmlUrl: repo.htmlUrl,
    commitSha,
    included: included.map((e) => ({ username: e.username, sha: e.sha, source: e.source })),
    skipped,
  };
}

/** The full tree: inline text blobs + one 160000 gitlink per included entry. */
function buildTree(included: GraderEntry[], org: string, name: string, title: string): TreeEntry[] {
  const tree: TreeEntry[] = [
    { path: ".gitmodules", mode: "100644", type: "blob", content: buildGitmodules(included, org) },
    {
      path: ".devcontainer/devcontainer.json",
      mode: "100644",
      type: "blob",
      content: buildDevcontainer(included, org, name),
    },
    { path: "README.md", mode: "100644", type: "blob", content: buildReadme(title, included) },
  ];
  for (const e of included) {
    tree.push({ path: `submissions/${e.username}`, mode: "160000", type: "commit", sha: e.sha });
  }
  return tree;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:unit -- grader-build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/grader-build.ts test/unit/grader-build.test.ts
git commit -m "feat(domain): buildGrader orchestration via Git Data API"
```

---

## Task 9: Thread `latestSha`/`gradeDecision` through evaluation

**Files:**
- Modify: `src/lib/domain/evaluation.ts`
- Test: `test/unit/evaluation.test.ts` (verify no regression; extend if needed)

- [ ] **Step 1: Read the existing evaluation unit test**

Run: `cat test/unit/evaluation.test.ts` (via Read tool) to see exactly which fields its `makeDeps` mocks and which assertions compare full view objects.

- [ ] **Step 2: Add a failing assertion that views surface the new fields**

In `test/unit/evaluation.test.ts`, add a test asserting that after evaluation the `SubmissionView` for an evaluated row carries `latestSha` and `gradeDecision`. If the existing `makeDeps`/`getSubmission` mock returns a `SubmissionLite` without these fields, update that mock to include them, then assert:

```typescript
it("surfaces latestSha and gradeDecision in evaluated submission views", async () => {
  const deps = makeDeps({
    getSubmission: vi.fn(async () => ({
      deadlineSha: "dsha",
      deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestSha: "lsha",
      latestCommitAt: "2026-02-01T00:00:00Z",
      status: "late",
      gradeDecision: "accept_late",
      evaluatedAt: "2026-02-02T00:00:00Z",
    })),
  });
  const result = await evaluateAssignmentSubmissions(deps, {
    assignmentId: "a1",
    now: PAST_NOW,
    refresh: false,
  });
  expect(result.submissions[0]).toMatchObject({ latestSha: "lsha", gradeDecision: "accept_late" });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `yarn test:unit -- evaluation`
Expected: FAIL — `SubmissionView` has no `latestSha`/`gradeDecision` (and/or `SubmissionLite`/deps types reject the new mock fields).

- [ ] **Step 4: Update `evaluation.ts`**

In `src/lib/domain/evaluation.ts`:

(a) Add the fields to `SubmissionLite`:

```typescript
interface SubmissionLite {
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
  latestSha: string | null;
  latestCommitAt: string | null;
  status: string;
  gradeDecision: string;
  evaluatedAt: string | null;
}
```

(b) Add `latestSha` to the `freezeSubmission` and `refreshSubmissionStatus` deps signatures:

```typescript
  freezeSubmission: (input: {
    assignmentId: string;
    studentId: string;
    deadlineSha: string | null;
    deadlineCommitAt: string | null;
    latestSha: string | null;
    latestCommitAt: string | null;
    status: "on_time" | "late" | "missing";
  }) => Promise<void>;
  refreshSubmissionStatus: (input: {
    assignmentId: string;
    studentId: string;
    latestSha: string | null;
    latestCommitAt: string | null;
    status: "on_time" | "late" | "missing";
  }) => Promise<void>;
```

(c) Add the fields to `SubmissionView`:

```typescript
export interface SubmissionView {
  studentId: string;
  githubUsername: string | null;
  repoName: string;
  status: string | null;
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
  latestSha: string | null;
  latestCommitAt: string | null;
  gradeDecision: string;
  evaluatedAt: string | null;
}
```

(d) Update `blankView` (no row yet → effective default decision, null latestSha):

```typescript
function blankView(repo: RepoLite, status: string | null): SubmissionView {
  return {
    studentId: repo.studentId,
    githubUsername: repo.githubUsername,
    repoName: repo.repoName,
    status,
    deadlineSha: null,
    deadlineCommitAt: null,
    latestSha: null,
    latestCommitAt: null,
    gradeDecision: "at_deadline",
    evaluatedAt: null,
  };
}
```

(e) Update `rowView` to read the new fields:

```typescript
function rowView(repo: RepoLite, row: SubmissionLite): SubmissionView {
  return {
    studentId: repo.studentId,
    githubUsername: repo.githubUsername,
    repoName: repo.repoName,
    status: row.status,
    deadlineSha: row.deadlineSha,
    deadlineCommitAt: row.deadlineCommitAt,
    latestSha: row.latestSha,
    latestCommitAt: row.latestCommitAt,
    gradeDecision: row.gradeDecision,
    evaluatedAt: row.evaluatedAt,
  };
}
```

(f) Thread `latestSha` into both write calls inside the loop:

```typescript
      if (alreadyEvaluated) {
        await deps.refreshSubmissionStatus({
          assignmentId: assignment.id,
          studentId: repo.studentId,
          latestSha: state.latestSha,
          latestCommitAt: state.latestCommitAt,
          status,
        });
      } else {
        await deps.freezeSubmission({
          assignmentId: assignment.id,
          studentId: repo.studentId,
          deadlineSha: state.deadlineSha,
          deadlineCommitAt: state.deadlineCommitAt,
          latestSha: state.latestSha,
          latestCommitAt: state.latestCommitAt,
          status,
        });
      }
```

- [ ] **Step 5: Find and update the production `EvaluationDeps` factory**

The endpoints build `EvaluationDeps` (the summary showed a `buildEvaluationDeps(db, token)` factory wiring `getSubmission`/`freezeSubmission`/`refreshSubmissionStatus`). Locate it:

Run: `grep -rn "buildEvaluationDeps\|freezeSubmission:" src/`

The DB `freezeSubmission`/`refreshSubmissionStatus` now require `latestSha`, and `getSubmission` now returns it — since the factory passes the DB functions straight through, no field-by-field wiring changes, but confirm it compiles (the DB `Submission` type now satisfies `SubmissionLite` including `latestSha`/`gradeDecision`).

- [ ] **Step 6: Run the unit + a quick typecheck**

Run: `yarn test:unit`
Expected: PASS (all unit suites, including the existing evaluation tests).

Run: `yarn build`
Expected: build succeeds (confirms the endpoints wiring still typechecks).

- [ ] **Step 7: Commit**

```bash
git add src/lib/domain/evaluation.ts test/unit/evaluation.test.ts
git commit -m "feat(domain): thread latestSha + expose gradeDecision in evaluation views"
```

---

## Task 10: Decision request schema

**Files:**
- Modify: `src/lib/http/schemas.ts`
- Test: `test/unit/schemas.test.ts` (create if absent; otherwise extend)

- [ ] **Step 1: Write the failing unit test**

Create or extend `test/unit/schemas.test.ts`:

```typescript
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { decisionSchema } from "../../src/lib/http/schemas";

describe("decisionSchema", () => {
  it("accepts the three valid decisions", () => {
    for (const decision of ["at_deadline", "accept_late", "exclude"]) {
      expect(v.parse(decisionSchema, { decision }).decision).toBe(decision);
    }
  });

  it("rejects an unknown decision", () => {
    expect(() => v.parse(decisionSchema, { decision: "maybe" })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit -- schemas`
Expected: FAIL — `decisionSchema` is not exported.

- [ ] **Step 3: Add the schema**

Append to `src/lib/http/schemas.ts`:

```typescript
export const decisionSchema = v.object({
  decision: v.picklist(
    ["at_deadline", "accept_late", "exclude"],
    "decision must be one of at_deadline, accept_late, exclude",
  ),
});

export type DecisionBody = v.InferOutput<typeof decisionSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:unit -- schemas`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/http/schemas.ts test/unit/schemas.test.ts
git commit -m "feat(http): decisionSchema (Valibot enum)"
```

---

## Task 11: GitHub mock — Git Data API responders

**Files:**
- Modify: `test/integration/github-mock.ts`

- [ ] **Step 1: Add the Git Data API routes**

In `test/integration/github-mock.ts`, before the final `return new Response("unmocked...", { status: 501 })`, add these responders (using the existing `jsonResponse(status, body)` helper):

```typescript
  // POST /orgs/{org}/repos — create grader repo (echo grader-{slug})
  const orgRepos = path.match(/^\/orgs\/([^/]+)\/repos$/);
  if (method === "POST" && orgRepos) {
    const org = orgRepos[1];
    const body = (await request.json().catch(() => ({}))) as { name?: string };
    const name = body.name ?? "grader-repo";
    return jsonResponse(201, {
      full_name: `${org}/${name}`,
      html_url: `https://github.com/${org}/${name}`,
    });
  }

  // POST /repos/{o}/{r}/git/trees
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/git\/trees$/.test(path)) {
    return jsonResponse(201, { sha: "tree-sha-canned" });
  }

  // POST /repos/{o}/{r}/git/commits
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/git\/commits$/.test(path)) {
    return jsonResponse(201, { sha: "commit-sha-canned" });
  }

  // GET /repos/{o}/{r}/git/ref/heads/main — convention: 404 = first build
  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/main$/.test(path)) {
    return jsonResponse(404, { message: "Not Found" });
  }

  // POST /repos/{o}/{r}/git/refs — create main ref
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/git\/refs$/.test(path)) {
    return jsonResponse(201, { ref: "refs/heads/main", object: { sha: "commit-sha-canned" } });
  }

  // PATCH /repos/{o}/{r}/git/refs/heads/main — fast-forward main
  if (method === "PATCH" && /^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/main$/.test(path)) {
    return jsonResponse(200, { ref: "refs/heads/main", object: { sha: "commit-sha-canned" } });
  }
```

> Note: the `git/ref/heads/main` GET must be matched before any broader `/repos/.../...` catch-all. Place these blocks among the other `/repos/...` matchers; the regexes are exact-path so order among themselves is safe.

- [ ] **Step 2: Verify the mock still loads (no test yet, just build the integration bundle)**

Run: `yarn build`
Expected: build succeeds (the mock is plain TS imported by the integration config).

- [ ] **Step 3: Commit**

```bash
git add test/integration/github-mock.ts
git commit -m "test(integration): mock Git Data API routes for grader build"
```

---

## Task 12: `PUT .../decision` endpoint

**Files:**
- Create: `src/pages/api/assignments/[id]/submissions/[studentId]/decision.ts`
- Test: `test/integration/decision-api.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/decision-api.test.ts`:

```typescript
import { env } from "cloudflare:test";
import "./apply-migrations";
import { describe, expect, it } from "vitest";
import { createClassroom } from "../../src/lib/db/classrooms";
import { createAssignment } from "../../src/lib/db/assignments";
import { createStudent } from "../../src/lib/db/students";
import { freezeSubmission, getSubmission } from "../../src/lib/db/submissions";
import { seedUserAndCookie } from "./helpers";

async function seedEvaluated(githubId: number) {
  const teacher = await seedUserAndCookie({ githubId, login: `teacher-${githubId}` });
  const classroom = await createClassroom(env.DB, {
    name: "CS", githubOrg: "org", timezone: "UTC", createdBy: teacher.user.id,
  });
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id, slug: "hw1", title: "HW1", templateRepo: "org/hw1-template",
    deadlineAt: "2026-01-01T00:00:00Z",
  });
  const student = await createStudent(env.DB, {
    classroomId: classroom.id, userId: teacher.user.id, githubUsername: "stud",
  });
  await freezeSubmission(env.DB, {
    assignmentId: assignment.id, studentId: student.id,
    deadlineSha: "dsha", deadlineCommitAt: "2025-12-31T00:00:00Z",
    latestSha: "lsha", latestCommitAt: "2026-02-01T00:00:00Z", status: "late",
  });
  return { teacher, classroom, assignment, student };
}

function putDecision(assignmentId: string, studentId: string, decision: string, cookie?: string) {
  return SELF.fetch(
    `https://example.com/api/assignments/${assignmentId}/submissions/${studentId}/decision`,
    {
      method: "PUT",
      headers: cookie ? { "content-type": "application/json", cookie } : { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  );
}

import { SELF } from "cloudflare:test";

describe("PUT decision", () => {
  it("sets a decision on an evaluated submission (200) and persists it", async () => {
    const { teacher, assignment, student } = await seedEvaluated(80);
    const res = await putDecision(assignment.id, student.id, "accept_late", teacher.cookie);
    expect(res.status).toBe(200);
    const row = await getSubmission(env.DB, assignment.id, student.id);
    expect(row?.gradeDecision).toBe("accept_late");
  });

  it("returns 404 when the submission/student is not evaluated", async () => {
    const { teacher, assignment } = await seedEvaluated(81);
    const res = await putDecision(assignment.id, "no-such-student", "exclude", teacher.cookie);
    expect(res.status).toBe(404);
  });

  it("returns 403 to a non-owner", async () => {
    const { assignment, student } = await seedEvaluated(82);
    const intruder = await seedUserAndCookie({ githubId: 999, login: "intruder" });
    const res = await putDecision(assignment.id, student.id, "exclude", intruder.cookie);
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    const { assignment, student } = await seedEvaluated(83);
    const res = await putDecision(assignment.id, student.id, "exclude");
    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid decision value", async () => {
    const { teacher, assignment, student } = await seedEvaluated(84);
    const res = await putDecision(assignment.id, student.id, "maybe", teacher.cookie);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- decision-api`
Expected: FAIL — the endpoint does not exist (404 for all).

- [ ] **Step 3: Implement the endpoint**

Create `src/pages/api/assignments/[id]/submissions/[studentId]/decision.ts` (follow the `[id].ts` GET pattern for auth + `toResponse`):

```typescript
import type { APIRoute } from "astro";
import { getEnv } from "../../../../../../lib/config";
import { requireSession } from "../../../../../../lib/auth/require";
import { getAssignmentById } from "../../../../../../lib/db/assignments";
import { getSubmission, setGradeDecision } from "../../../../../../lib/db/submissions";
import { assertOwnsClassroom } from "../../../../../../lib/domain/authz";
import { decisionSchema } from "../../../../../../lib/http/schemas";
import { parseBody } from "../../../../../../lib/http/parse";
import { NotFoundError, toResponse } from "../../../../../../lib/http/errors";
import { json, error } from "../../../../../../lib/http/json";

export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    await assertOwnsClassroom(env.DB, assignment.classroomId, session.userId);

    const body = await parseBody(request, decisionSchema);
    const ok = await setGradeDecision(env.DB, assignment.id, params.studentId!, body.decision);
    if (!ok) throw new NotFoundError("No evaluated submission for that student");

    const updated = await getSubmission(env.DB, assignment.id, params.studentId!);
    return json(updated, 200);
  } catch (err) {
    return toResponse(err);
  }
};
```

> **Verify the import paths and helper names before running:** count the `../` segments for this nesting depth and confirm `parseBody` lives at `src/lib/http/parse` (the assignments POST endpoint imports it — `grep -rn "parseBody" src/pages`). Confirm `requireSession` is imported from `lib/auth/require` and `assertOwnsClassroom` from `lib/domain/authz`, matching `src/pages/api/assignments/[id].ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- decision-api`
Expected: PASS (all five cases).

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/assignments/[id]/submissions/[studentId]/decision.ts test/integration/decision-api.test.ts
git commit -m "feat(api): PUT submission grade decision (owner-only)"
```

---

## Task 13: `POST .../grader` endpoint

**Files:**
- Create: `src/pages/api/assignments/[id]/grader.ts`
- Test: `test/integration/grader-api.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/grader-api.test.ts`:

```typescript
import { env, SELF } from "cloudflare:test";
import "./apply-migrations";
import { beforeEach, describe, expect, it } from "vitest";
import { clearInstallationTokenCache } from "../../src/lib/github/app";
import { createClassroom } from "../../src/lib/db/classrooms";
import { createAssignment, getAssignmentById } from "../../src/lib/db/assignments";
import { createStudent } from "../../src/lib/db/students";
import { freezeSubmission, setGradeDecision } from "../../src/lib/db/submissions";
import { seedUserAndCookie } from "./helpers";

beforeEach(() => clearInstallationTokenCache());

const PAST = "2020-01-01T00:00:00Z";
const FUTURE = "2099-01-01T00:00:00Z";

async function seedBoard(opts: { githubId: number; deadlineAt: string }) {
  const teacher = await seedUserAndCookie({ githubId: opts.githubId, login: `teacher-${opts.githubId}` });
  const classroom = await createClassroom(env.DB, {
    name: "CS", githubOrg: "org", timezone: "UTC", createdBy: teacher.user.id,
  });
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id, slug: "hw1", title: "HW1", templateRepo: "org/hw1-template",
    deadlineAt: opts.deadlineAt,
  });

  async function seedSub(username: string, decision: string, deadlineSha: string | null, latestSha: string | null) {
    const u = await seedUserAndCookie({ githubId: opts.githubId * 100 + username.length, login: username });
    const student = await createStudent(env.DB, {
      classroomId: classroom.id, userId: u.user.id, githubUsername: username,
    });
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      deadlineSha, deadlineCommitAt: deadlineSha ? "2019-12-31T00:00:00Z" : null,
      latestSha, latestCommitAt: latestSha ? "2020-02-01T00:00:00Z" : null,
      status: "late",
    });
    await setGradeDecision(env.DB, assignment.id, student.id, decision);
    return student;
  }

  await seedSub("ann", "at_deadline", "d-ann", "l-ann");
  await seedSub("ben", "accept_late", "d-ben", "l-ben");
  await seedSub("cid", "exclude", "d-cid", "l-cid");
  await seedSub("dot", "at_deadline", null, null); // null deadline SHA → skipped

  return { teacher, classroom, assignment };
}

function postGrader(assignmentId: string, cookie?: string) {
  return SELF.fetch(`https://example.com/api/assignments/${assignmentId}/grader`, {
    method: "POST",
    headers: cookie ? { "content-type": "application/json", cookie } : { "content-type": "application/json" },
  });
}

describe("POST grader", () => {
  it("builds the grader, sets grader_repo + status, and returns included/skipped", async () => {
    const { teacher, assignment } = await seedBoard({ githubId: 90, deadlineAt: PAST });
    const res = await postGrader(assignment.id, teacher.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        graderRepo: string;
        commitSha: string;
        included: { username: string; sha: string; source: string }[];
        skipped: { username: string | null; studentId: string; reason: string }[];
      };
    };
    expect(body.data.graderRepo).toBe("org/grader-hw1");

    const included = body.data.included.sort((a, b) => a.username.localeCompare(b.username));
    expect(included).toEqual([
      { username: "ann", sha: "d-ann", source: "deadline" },
      { username: "ben", sha: "l-ben", source: "latest" },
    ]);

    const reasons = Object.fromEntries(body.data.skipped.map((s) => [s.username, s.reason]));
    expect(reasons.cid).toBe("excluded");
    expect(reasons.dot).toBe("no-deadline-sha");

    const after = await getAssignmentById(env.DB, assignment.id);
    expect(after?.graderRepo).toBe("org/grader-hw1");
    expect(after?.status).toBe("built");
  });

  it("is idempotent: a second POST still returns built", async () => {
    const { teacher, assignment } = await seedBoard({ githubId: 91, deadlineAt: PAST });
    expect((await postGrader(assignment.id, teacher.cookie)).status).toBe(200);
    const second = await postGrader(assignment.id, teacher.cookie);
    expect(second.status).toBe(200);
    const after = await getAssignmentById(env.DB, assignment.id);
    expect(after?.status).toBe("built");
  });

  it("returns 400 when the deadline has not passed", async () => {
    const { teacher, assignment } = await seedBoard({ githubId: 92, deadlineAt: FUTURE });
    expect((await postGrader(assignment.id, teacher.cookie)).status).toBe(400);
  });

  it("returns 403 to a non-owner", async () => {
    const { assignment } = await seedBoard({ githubId: 93, deadlineAt: PAST });
    const intruder = await seedUserAndCookie({ githubId: 999, login: "intruder" });
    expect((await postGrader(assignment.id, intruder.cookie)).status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    const { assignment } = await seedBoard({ githubId: 94, deadlineAt: PAST });
    expect((await postGrader(assignment.id)).status).toBe(401);
  });
});
```

> **Confirm `clearInstallationTokenCache` is the real export name** before running — `grep -rn "clearInstallationTokenCache\|InstallationTokenCache" src/lib/github/app.ts test/integration`. The submissions-api integration test uses it in `beforeEach`; reuse that exact import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- grader-api`
Expected: FAIL — the endpoint does not exist (404/401 mismatches).

- [ ] **Step 3: Implement the endpoint**

Create `src/pages/api/assignments/[id]/grader.ts` (model the token-mint + deps wiring on `submissions/refresh.ts`):

```typescript
import type { APIRoute } from "astro";
import { getEnv } from "../../../../lib/config";
import { requireSession } from "../../../../lib/auth/require";
import { getAssignmentById, setGraderBuilt } from "../../../../lib/db/assignments";
import { getClassroomById } from "../../../../lib/db/classrooms";
import { listSubmissionsWithStudents } from "../../../../lib/db/submissions";
import { assertOwnsClassroom } from "../../../../lib/domain/authz";
import { getInstallationToken } from "../../../../lib/github/app";
import {
  createCommit,
  createMainRef,
  createTree,
  ensureOrgRepo,
  getMainRef,
  updateMainRef,
} from "../../../../lib/github/git-data";
import { buildGrader } from "../../../../lib/domain/grader-build";
import { AssignmentNotFoundError } from "../../../../lib/domain/evaluation";
import { NotFoundError, toResponse } from "../../../../lib/http/errors";
import { json, error } from "../../../../lib/http/json";

export const POST: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    await assertOwnsClassroom(env.DB, assignment.classroomId, session.userId);

    const token = await getInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });

    const result = await buildGrader(
      {
        token,
        loadAssignment: (id) => getAssignmentById(env.DB, id),
        loadClassroom: (id) => getClassroomById(env.DB, id),
        listSubmissionsWithStudents: (id) => listSubmissionsWithStudents(env.DB, id),
        setGraderBuilt: (id, repo) => setGraderBuilt(env.DB, id, repo),
        ensureOrgRepo,
        createTree,
        getMainRef,
        createCommit,
        createMainRef,
        updateMainRef,
      },
      { assignmentId: assignment.id, now: new Date().toISOString() },
    );

    return json({ assignmentId: assignment.id, ...result }, 200);
  } catch (err) {
    if (err instanceof AssignmentNotFoundError) return error(err.message, 404);
    return toResponse(err);
  }
};
```

> **Before running, verify three things by grep:** (1) `getClassroomById` is exported from `src/lib/db/classrooms.ts` and returns an object whose `githubOrg` field exists (the `ClassroomForBuild` shape needs `id` + `githubOrg`); (2) `getInstallationToken`'s option keys match `submissions/refresh.ts` exactly; (3) the `../` depth from `src/pages/api/assignments/[id]/grader.ts` to `src/lib/...` is four segments (same as `[id].ts` is three — this file is one level deeper).

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- grader-api`
Expected: PASS (all five cases).

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/assignments/[id]/grader.ts test/integration/grader-api.test.ts
git commit -m "feat(api): POST build grader (owner-only)"
```

---

## Task 14: Full suite + final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the entire unit suite**

Run: `yarn test:unit`
Expected: PASS (github-commits, grader, git-data, grader-build, evaluation, schemas).

- [ ] **Step 2: Run the entire integration suite**

Run: `yarn test:integration`
Expected: PASS, except the known-environmental `DEBUG_ROUTES` 404 test, which fails locally because `.dev.vars` sets `DEBUG_ROUTES=1` (per project memory — not a regression). Confirm every other test passes, including `submissions-db`, `decision-api`, `grader-api`.

- [ ] **Step 3: Confirm no leftover placeholders / type drift**

Run: `yarn build`
Expected: build (typecheck + bundle) succeeds.

- [ ] **Step 4: Final commit if anything was adjusted**

```bash
git add -A
git commit -m "test(phase-5): full suite green for grader builder + decisions"
```

---

## Self-Review Notes

- **Spec coverage:** Migration (§3) → Task 1. Phase 3 extensions (§3.1) → Tasks 2, 3, 9. Pin selection + builders (§4) → Task 6. Git Data wrappers (§5) → Task 7. Build orchestration (§6) → Task 8. Endpoints (§7) → Tasks 12, 13. DB helpers (§8) → Tasks 3, 4, 5. Testing (§9) → tests embedded per task + Task 14. File structure (§10) → all New/Modified files covered.
- **`latest_sha` immutability:** `freezeSubmission` refreshes `latest_sha` (not COALESCE); only `deadline_sha`/`deadline_commit_at` stay immutable — verified by the Task 3 tests.
- **`grade_decision` preservation:** INSERT omits it (DB default), ON CONFLICT does not touch it — verified by the Task 3 "freeze re-run preserves" test.
- **Type consistency:** `GraderEntry` ({ username, repoName, sha, source }) is the internal shape; `buildGrader`/endpoints expose only { username, sha, source } in `included`. `SubmissionForSelection` is the single input shape shared by `selectGraderEntries`, `listSubmissionsWithStudents`, and the `grader-build` deps. `freezeSubmission`/`refreshSubmissionStatus` gained `latestSha` consistently in the DB layer (Task 3) and the evaluation deps signatures (Task 9).
- **Error mapping:** 400 via `ValidationError` (deadline guard, nothing-to-build, invalid decision body); 404 via `NotFoundError`/`AssignmentNotFoundError`; 403 via `assertOwnsClassroom`; 502 via `GitHubApiError` through `toResponse`.
- **Verify-before-run callouts:** Tasks 12/13 include explicit grep checks for import depths and helper names (`parseBody`, `requireSession`, `assertOwnsClassroom`, `getClassroomById`, `getInstallationToken`, `clearInstallationTokenCache`) because those exact paths/signatures weren't all pinned during planning.
