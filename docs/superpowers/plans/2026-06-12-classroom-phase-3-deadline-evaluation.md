# Phase 3 — Lazy Deadline Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a teacher-triggered, lazy deadline engine that classifies each student repo as `on_time` / `late` / `missing` from immutable git history and freezes the result (including the pinned deadline commit SHA) into the `submissions` table.

**Architecture:** A pure classifier (`domain/deadline.ts`) consumes commit state read from GitHub (`github/commits.ts`). An orchestrator (`domain/evaluation.ts`) joins an assignment's repos to their students, evaluates each repo when the deadline has passed, and freezes/refreshes rows via `db/submissions.ts`. Two owner-only endpoints expose a lazy status board (GET) and a re-check (POST `/refresh`). No cron, no custom Worker entry, no permission downgrade. The `grace_minutes` column and all its references are removed.

**Tech Stack:** Astro API routes on `@astrojs/cloudflare`, Cloudflare D1 (SQLite), Valibot validation, Vitest (unit + `@cloudflare/vitest-pool-workers` integration). GitHub egress in integration tests is mocked by the global miniflare `outboundService` in `test/integration/github-mock.ts` (NOT `fetchMock`).

---

## Conventions for this plan

- All commands run from the repo root `/workspaces/classroom`.
- Unit tests: `yarn test:unit` (fast, mocked fetch, no build).
- Integration tests: `yarn test:integration` (runs `yarn build` first, then vitest-pool-workers).
- Typecheck: `yarn typecheck` (runs `tsc --noEmit` for src + `test/integration`).
- The success envelope is `{ data: ... }`; the failure envelope is `{ error: { message, fields? } }` (see `src/lib/http/json.ts`).
- D1 integration state persists across tests; `test/integration/apply-migrations.ts` resets tables in `beforeEach`. It already deletes `submissions` first — no change needed there.

---

## Task 1: Migration `0004` — drop grace, reshape submissions

**Files:**
- Create: `migrations/0004_deadline_evaluation.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0004_deadline_evaluation.sql`:

```sql
-- Phase 3: drop the unused grace window, and reshape `submissions` for lazy
-- deadline evaluation. `submissions` was created in 0001 but is not read or
-- written by any code yet, so this is plain DDL on an empty table.

ALTER TABLE assignments DROP COLUMN grace_minutes;

ALTER TABLE submissions RENAME COLUMN last_commit_sha TO deadline_sha;
ALTER TABLE submissions RENAME COLUMN last_commit_at TO deadline_commit_at;
ALTER TABLE submissions ADD COLUMN latest_commit_at TEXT;
```

- [ ] **Step 2: Apply the migration locally to verify the DDL is valid**

Run: `yarn db:migrate:local`
Expected: wrangler reports `0004_deadline_evaluation.sql` applied with no SQL error. (If `0004` shows as already-applied from a prior run, that is fine — the goal is to confirm it is syntactically valid and registered.)

- [ ] **Step 3: Commit**

```bash
git add migrations/0004_deadline_evaluation.sql
git commit -m "feat(db): migration 0004 — drop grace_minutes, reshape submissions"
```

---

## Task 2: Remove `grace_minutes` from the validation schema + its unit tests

**Files:**
- Modify: `src/lib/http/schemas.ts:39-43`
- Test: `test/unit/validation.test.ts`

- [ ] **Step 1: Update the unit tests to no longer reference grace**

In `test/unit/validation.test.ts`, replace the "accepts valid input and defaults grace_minutes to 0" test (lines 42-53) with:

```ts
  it("accepts valid input with no optional fields", async () => {
    const out = await parseBody(
      req({ slug: "hw1", title: "Homework 1", template_repo: "my-org/hw1-template" }),
      assignmentSchema,
    );
    expect(out).toEqual({
      slug: "hw1",
      title: "Homework 1",
      template_repo: "my-org/hw1-template",
    });
  });
```

Replace the "accepts an optional ISO-8601 UTC deadline and positive grace" test (lines 55-68) with:

```ts
  it("accepts an optional ISO-8601 UTC deadline", async () => {
    const out = await parseBody(
      req({
        slug: "hw1",
        title: "Homework 1",
        template_repo: "my-org/hw1-template",
        deadline_at: "2026-09-01T23:59:00Z",
      }),
      assignmentSchema,
    );
    expect(out.deadline_at).toBe("2026-09-01T23:59:00Z");
  });
```

Replace the "rejects a negative grace_minutes and a non-ISO deadline" test (lines 86-98) with:

```ts
  it("rejects a non-ISO deadline", async () => {
    const bad = await parseBody(
      req({ slug: "hw1", title: "t", template_repo: "o/n", deadline_at: "September 1st" }),
      assignmentSchema,
    ).catch((e) => e);
    expect(bad.fields).toHaveProperty("deadline_at");
  });
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `yarn test:unit -- validation`
Expected: FAIL — the new "accepts valid input with no optional fields" test fails because the schema still injects `grace_minutes: 0` (output has an extra key).

- [ ] **Step 3: Remove the `grace_minutes` field from the schema**

In `src/lib/http/schemas.ts`, delete the `grace_minutes` field (lines 39-42 inside `assignmentSchema`) so the object ends after `deadline_at`:

```ts
export const assignmentSchema = v.object({
  slug: v.pipe(
    v.string(),
    v.check(isValidSlug, "slug must be url-safe: lowercase, hyphen-separated, 1–60 chars"),
  ),
  title: v.pipe(v.string(), v.trim(), v.minLength(1, "title is required")),
  template_repo: v.pipe(
    v.string(),
    v.regex(TEMPLATE_REPO_RE, "template_repo must be in owner/name form"),
  ),
  deadline_at: v.optional(
    v.pipe(v.string(), v.isoTimestamp("deadline_at must be an ISO-8601 UTC timestamp")),
  ),
});
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `yarn test:unit -- validation`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/http/schemas.ts test/unit/validation.test.ts
git commit -m "refactor(schemas): drop grace_minutes from assignment validation"
```

---

## Task 3: Remove `grace_minutes` from the assignments DB layer + endpoint

**Files:**
- Modify: `src/lib/db/assignments.ts` (interface, row type, mapper, INSERT)
- Modify: `src/pages/api/classrooms/[id]/assignments.ts:19-26`

- [ ] **Step 1: Remove grace from `src/lib/db/assignments.ts`**

Remove `graceMinutes: number;` from the `Assignment` interface (line 11), remove `grace_minutes: number;` from `AssignmentRow` (line 25), remove `graceMinutes: row.grace_minutes,` from `toAssignment` (line 40), and update `createAssignment` to drop the column from the input type, the INSERT column list, the placeholders, and the bind. The function becomes:

```ts
export async function createAssignment(
  db: D1Database,
  input: {
    classroomId: string;
    slug: string;
    title: string;
    templateRepo: string;
    deadlineAt?: string;
  },
): Promise<Assignment> {
  try {
    const row = await db
      .prepare(
        `INSERT INTO assignments (id, classroom_id, slug, title, template_repo, deadline_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         RETURNING *`,
      )
      .bind(
        crypto.randomUUID(),
        input.classroomId,
        input.slug,
        input.title,
        input.templateRepo,
        input.deadlineAt ?? null,
      )
      .first<AssignmentRow>();
    if (!row) throw new Error("createAssignment: INSERT ... RETURNING produced no row");
    return toAssignment(row);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new ConflictError(`An assignment with slug "${input.slug}" already exists in this classroom`);
    }
    throw err;
  }
}
```

- [ ] **Step 2: Remove grace from the assignments endpoint**

In `src/pages/api/classrooms/[id]/assignments.ts`, remove `graceMinutes: body.grace_minutes,` (line 25). The `createAssignment` call becomes:

```ts
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: body.slug,
      title: body.title,
      templateRepo: body.template_repo,
      deadlineAt: body.deadline_at,
    });
```

- [ ] **Step 3: Typecheck**

Run: `yarn typecheck`
Expected: This will FAIL in `test/integration/*` files that still pass `graceMinutes` and in `test/integration/assignments-api.test.ts` which still asserts `graceMinutes`. That is expected — Task 4 fixes those. The `src/` compile (first `tsc` invocation) must pass; if it reports a `src/` error, fix it before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/assignments.ts src/pages/api/classrooms/[id]/assignments.ts
git commit -m "refactor(assignments): drop grace_minutes from db layer and endpoint"
```

---

## Task 4: Remove `grace_minutes` from the integration tests

**Files:**
- Modify: `test/integration/assignments-db.test.ts`
- Modify: `test/integration/assignments-api.test.ts:36-41`
- Modify: `test/integration/accept-api.test.ts:32`
- Modify: `test/integration/classrooms-api.test.ts:64`
- Modify: `test/integration/roster-api.test.ts:24`
- Modify: `test/integration/resync-api.test.ts:26,90,115`

- [ ] **Step 1: Update `assignments-db.test.ts`**

Remove every `graceMinutes: 0,` / `graceMinutes: 15,` line passed to `createAssignment` (lines 30, 64, 72, 85, 92, 104). Remove the `expect(assignment.graceMinutes).toBe(0);` assertion (line 39). Replace the "persists an optional deadline and grace" test (lines 43-55) with a deadline-only version:

```ts
  it("persists an optional deadline", async () => {
    const classroom = await seedClassroom();
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw2",
      title: "Homework 2",
      templateRepo: "my-org/hw2-template",
      deadlineAt: "2026-09-01T23:59:00Z",
    });
    expect(assignment.deadlineAt).toBe("2026-09-01T23:59:00Z");
  });
```

- [ ] **Step 2: Update `assignments-api.test.ts`**

In the "creates an assignment (201)" test, change the destructured response type (line 36) and drop the grace assertion (line 41):

```ts
    const { data } = (await res.json()) as {
      data: { slug: string; classroomId: string; status: string };
    };
    expect(data.slug).toBe("hw1");
    expect(data.classroomId).toBe(classroom.id);
    expect(data.status).toBe("open");
```

- [ ] **Step 3: Update the remaining three test files**

In `test/integration/accept-api.test.ts`, `classrooms-api.test.ts`, `roster-api.test.ts`, and `resync-api.test.ts`, delete every `graceMinutes: 0,` line inside `createAssignment({ ... })` calls (accept-api:32, classrooms-api:64, roster-api:24, resync-api:26/90/115). Leave the surrounding `deadlineAt`/`slug`/`title`/`templateRepo` lines intact.

- [ ] **Step 4: Typecheck**

Run: `yarn typecheck`
Expected: PASS (both `tsc` invocations clean).

- [ ] **Step 5: Run the full integration suite to confirm grace removal is green end-to-end**

Run: `yarn test:integration`
Expected: PASS. (The migration `0004` is applied by `applyD1Migrations` from the build-generated config, so the `assignments` table no longer has `grace_minutes` and `submissions` has the new shape.)

- [ ] **Step 6: Commit**

```bash
git add test/integration/
git commit -m "test: drop grace_minutes references from integration tests"
```

---

## Task 5: Classifier `domain/deadline.ts` (core deliverable)

**Files:**
- Create: `src/lib/domain/deadline.ts`
- Test: `test/unit/deadline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/deadline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifySubmission } from "../../src/lib/domain/deadline";

const DEADLINE = "2026-01-01T00:00:00Z";

describe("classifySubmission", () => {
  it("returns missing when there are no student commits", () => {
    expect(
      classifySubmission({ deadlineAt: DEADLINE, latestCommitAt: null, hasStudentCommits: false }),
    ).toBe("missing");
  });

  it("returns missing for template-only repos even if a commit timestamp is present", () => {
    expect(
      classifySubmission({
        deadlineAt: DEADLINE,
        latestCommitAt: "2025-12-30T00:00:00Z",
        hasStudentCommits: false,
      }),
    ).toBe("missing");
  });

  it("treats a commit exactly at the deadline as on_time", () => {
    expect(
      classifySubmission({ deadlineAt: DEADLINE, latestCommitAt: DEADLINE, hasStudentCommits: true }),
    ).toBe("on_time");
  });

  it("treats a commit one second before the deadline as on_time", () => {
    expect(
      classifySubmission({
        deadlineAt: DEADLINE,
        latestCommitAt: "2025-12-31T23:59:59Z",
        hasStudentCommits: true,
      }),
    ).toBe("on_time");
  });

  it("treats a commit one second after the deadline as late", () => {
    expect(
      classifySubmission({
        deadlineAt: DEADLINE,
        latestCommitAt: "2026-01-01T00:00:01Z",
        hasStudentCommits: true,
      }),
    ).toBe("late");
  });

  it("returns late when all student work is after the deadline", () => {
    expect(
      classifySubmission({
        deadlineAt: DEADLINE,
        latestCommitAt: "2026-02-01T12:00:00Z",
        hasStudentCommits: true,
      }),
    ).toBe("late");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit -- deadline`
Expected: FAIL with "Cannot find module '../../src/lib/domain/deadline'".

- [ ] **Step 3: Write the classifier**

Create `src/lib/domain/deadline.ts`:

```ts
export type SubmissionStatus = "on_time" | "late" | "missing";

/**
 * Pure deadline classifier. Timestamps are parsed to epoch ms and compared as
 * instants — never string-compared. The boundary is the deadline alone (grace
 * was dropped in Phase 3); a commit whose timestamp equals the deadline counts
 * as on_time (`<=`).
 */
export function classifySubmission(input: {
  deadlineAt: string;
  latestCommitAt: string | null;
  hasStudentCommits: boolean;
}): SubmissionStatus {
  if (!input.hasStudentCommits || input.latestCommitAt === null) return "missing";
  const deadline = Date.parse(input.deadlineAt);
  const latest = Date.parse(input.latestCommitAt);
  return latest <= deadline ? "on_time" : "late";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:unit -- deadline`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/deadline.ts test/unit/deadline.test.ts
git commit -m "feat(domain): add pure deadline classifier"
```

---

## Task 6: GitHub reads `github/commits.ts`

**Files:**
- Create: `src/lib/github/commits.ts`
- Test: `test/unit/github-commits.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/github-commits.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { readRepoCommitState } from "../../src/lib/github/commits";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DEADLINE = "2026-01-01T00:00:00Z";

function commit(sha: string, date: string) {
  return { sha, commit: { committer: { date } } };
}

describe("readRepoCommitState", () => {
  it("issues the two documented requests and maps an on-time repo", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("until=")) {
        return jsonResponse([commit("deadline-sha", "2025-12-31T00:00:00Z")]);
      }
      return jsonResponse([
        commit("latest-sha", "2025-12-31T00:00:00Z"),
        commit("template-sha", "2025-12-30T00:00:00Z"),
      ]);
    });

    const state = await readRepoCommitState({
      token: "ghs_x",
      owner: "org",
      repo: "hw1-ontime",
      deadlineAt: DEADLINE,
      fetchImpl,
    });

    const latestUrl = String((fetchImpl.mock.calls[0] as [string])[0]);
    const untilUrl = String((fetchImpl.mock.calls[1] as [string])[0]);
    expect(latestUrl).toBe("https://api.github.com/repos/org/hw1-ontime/commits?per_page=2");
    expect(untilUrl).toBe(
      `https://api.github.com/repos/org/hw1-ontime/commits?until=${encodeURIComponent(DEADLINE)}&per_page=1`,
    );
    expect(state).toEqual({
      latestCommitAt: "2025-12-31T00:00:00Z",
      hasStudentCommits: true,
      deadlineSha: "deadline-sha",
      deadlineCommitAt: "2025-12-31T00:00:00Z",
    });
  });

  it("maps a template-only repo as having no student commits", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("until=")) return jsonResponse([commit("template-sha", "2025-12-30T00:00:00Z")]);
      return jsonResponse([commit("template-sha", "2025-12-30T00:00:00Z")]);
    });

    const state = await readRepoCommitState({
      token: "ghs_x",
      owner: "org",
      repo: "hw1-missing",
      deadlineAt: DEADLINE,
      fetchImpl,
    });

    expect(state.hasStudentCommits).toBe(false);
    expect(state.latestCommitAt).toBe("2025-12-30T00:00:00Z");
    expect(state.deadlineSha).toBe("template-sha");
  });

  it("maps an empty repo (no commits) to nulls and no student commits", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));

    const state = await readRepoCommitState({
      token: "ghs_x",
      owner: "org",
      repo: "hw1-empty",
      deadlineAt: DEADLINE,
      fetchImpl,
    });

    expect(state).toEqual({
      latestCommitAt: null,
      hasStudentCommits: false,
      deadlineSha: null,
      deadlineCommitAt: null,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit -- github-commits`
Expected: FAIL with "Cannot find module '../../src/lib/github/commits'".

- [ ] **Step 3: Write the GitHub reader**

Create `src/lib/github/commits.ts`:

```ts
import { githubRequest } from "./client";

interface GitHubCommit {
  sha: string;
  commit: { committer: { date: string } };
}

export interface RepoCommitState {
  latestCommitAt: string | null;
  hasStudentCommits: boolean;
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
}

/**
 * Read a repo's commit state against its default branch (the commits API
 * defaults to the default branch when `sha` is omitted). Two calls:
 *   1. latest 2 commits → latestCommitAt + hasStudentCommits (> the single
 *      template-import commit, i.e. length >= 2).
 *   2. last commit at-or-before the deadline → the pinned deadline SHA.
 */
export async function readRepoCommitState(input: {
  token: string;
  owner: string;
  repo: string;
  deadlineAt: string;
  fetchImpl?: typeof fetch;
}): Promise<RepoCommitState> {
  const { token, owner, repo, deadlineAt, fetchImpl } = input;

  const latest = await githubRequest<GitHubCommit[]>(
    `/repos/${owner}/${repo}/commits?per_page=2`,
    { token, fetchImpl },
  );
  const latestCommitAt = latest.data[0]?.commit.committer.date ?? null;
  const hasStudentCommits = latest.data.length >= 2;

  const atDeadline = await githubRequest<GitHubCommit[]>(
    `/repos/${owner}/${repo}/commits?until=${encodeURIComponent(deadlineAt)}&per_page=1`,
    { token, fetchImpl },
  );
  const deadlineSha = atDeadline.data[0]?.sha ?? null;
  const deadlineCommitAt = atDeadline.data[0]?.commit.committer.date ?? null;

  return { latestCommitAt, hasStudentCommits, deadlineSha, deadlineCommitAt };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:unit -- github-commits`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/github/commits.ts test/unit/github-commits.test.ts
git commit -m "feat(github): read repo commit state for deadline evaluation"
```

---

## Task 7: Submissions DB layer `db/submissions.ts`

**Files:**
- Create: `src/lib/db/submissions.ts`
- Test: `test/integration/submissions-db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/integration/submissions-db.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import {
  freezeSubmission,
  getSubmission,
  listSubmissionsByAssignment,
  refreshSubmissionStatus,
} from "../../src/lib/db/submissions";
import { createStudent } from "../../src/lib/db/students";
import { seedUserAndCookie } from "./helpers";

async function seed() {
  const { user } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
  const classroom = await createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "test-org",
    timezone: "UTC",
    createdBy: user.id,
  });
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id,
    slug: "hw1",
    title: "HW 1",
    templateRepo: "test-org/hw1-template",
  });
  const { user: studentUser } = await seedUserAndCookie({ githubId: 2, login: "alice" });
  const student = await createStudent(env.DB, {
    classroomId: classroom.id,
    userId: studentUser.id,
    githubUsername: "alice",
  });
  return { assignment, student };
}

describe("submissions repository", () => {
  it("getSubmission returns null when there is no row", async () => {
    const { assignment, student } = await seed();
    expect(await getSubmission(env.DB, assignment.id, student.id)).toBeNull();
  });

  it("freezeSubmission inserts a frozen row, then preserves deadline_sha on a later freeze", async () => {
    const { assignment, student } = await seed();

    await freezeSubmission(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      deadlineSha: "sha-frozen",
      deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestCommitAt: "2025-12-31T00:00:00Z",
      status: "on_time",
    });

    const first = await getSubmission(env.DB, assignment.id, student.id);
    expect(first?.deadlineSha).toBe("sha-frozen");
    expect(first?.status).toBe("on_time");
    expect(first?.evaluatedAt).not.toBeNull();

    // A second freeze must NOT overwrite the immutable deadline_sha/commit_at,
    // but it does update the mutable latest_commit_at + status.
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      deadlineSha: "sha-different",
      deadlineCommitAt: "2030-01-01T00:00:00Z",
      latestCommitAt: "2026-02-01T00:00:00Z",
      status: "late",
    });

    const second = await getSubmission(env.DB, assignment.id, student.id);
    expect(second?.deadlineSha).toBe("sha-frozen");
    expect(second?.deadlineCommitAt).toBe("2025-12-31T00:00:00Z");
    expect(second?.latestCommitAt).toBe("2026-02-01T00:00:00Z");
    expect(second?.status).toBe("late");
  });

  it("refreshSubmissionStatus updates status + latest_commit_at, never deadline_sha", async () => {
    const { assignment, student } = await seed();
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      deadlineSha: "sha-frozen",
      deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestCommitAt: "2025-12-31T00:00:00Z",
      status: "on_time",
    });

    await refreshSubmissionStatus(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      latestCommitAt: "2026-02-01T00:00:00Z",
      status: "late",
    });

    const row = await getSubmission(env.DB, assignment.id, student.id);
    expect(row?.deadlineSha).toBe("sha-frozen");
    expect(row?.latestCommitAt).toBe("2026-02-01T00:00:00Z");
    expect(row?.status).toBe("late");
  });

  it("listSubmissionsByAssignment returns all rows for the assignment", async () => {
    const { assignment, student } = await seed();
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      deadlineSha: "sha-frozen",
      deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestCommitAt: "2025-12-31T00:00:00Z",
      status: "on_time",
    });
    const rows = await listSubmissionsByAssignment(env.DB, assignment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].studentId).toBe(student.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- submissions-db`
Expected: FAIL with "Cannot find module '../../src/lib/db/submissions'".

- [ ] **Step 3: Write the submissions repository**

Create `src/lib/db/submissions.ts`:

```ts
import type { D1Database } from "@cloudflare/workers-types";
import type { SubmissionStatus } from "../domain/deadline";

export interface Submission {
  assignmentId: string;
  studentId: string;
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
  latestCommitAt: string | null;
  status: string;
  evaluatedAt: string | null;
}

interface SubmissionRow {
  assignment_id: string;
  student_id: string;
  deadline_sha: string | null;
  deadline_commit_at: string | null;
  latest_commit_at: string | null;
  status: string;
  evaluated_at: string | null;
}

function toSubmission(row: SubmissionRow): Submission {
  return {
    assignmentId: row.assignment_id,
    studentId: row.student_id,
    deadlineSha: row.deadline_sha,
    deadlineCommitAt: row.deadline_commit_at,
    latestCommitAt: row.latest_commit_at,
    status: row.status,
    evaluatedAt: row.evaluated_at,
  };
}

export async function getSubmission(
  db: D1Database,
  assignmentId: string,
  studentId: string,
): Promise<Submission | null> {
  const row = await db
    .prepare("SELECT * FROM submissions WHERE assignment_id = ?1 AND student_id = ?2")
    .bind(assignmentId, studentId)
    .first<SubmissionRow>();
  return row ? toSubmission(row) : null;
}

export async function listSubmissionsByAssignment(
  db: D1Database,
  assignmentId: string,
): Promise<Submission[]> {
  const { results } = await db
    .prepare("SELECT * FROM submissions WHERE assignment_id = ?1")
    .bind(assignmentId)
    .all<SubmissionRow>();
  return results.map(toSubmission);
}

/**
 * Insert or update a frozen submission. `deadline_sha`/`deadline_commit_at` are
 * immutable once written: the UPSERT uses COALESCE so an existing (non-null)
 * pinned SHA is preserved while `latest_commit_at`/`status`/`evaluated_at` are
 * refreshed. The bare column names in DO UPDATE refer to the existing row.
 */
export async function freezeSubmission(
  db: D1Database,
  input: {
    assignmentId: string;
    studentId: string;
    deadlineSha: string | null;
    deadlineCommitAt: string | null;
    latestCommitAt: string | null;
    status: SubmissionStatus;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO submissions
         (assignment_id, student_id, deadline_sha, deadline_commit_at, latest_commit_at, status, evaluated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
       ON CONFLICT (assignment_id, student_id) DO UPDATE SET
         deadline_sha = COALESCE(deadline_sha, excluded.deadline_sha),
         deadline_commit_at = COALESCE(deadline_commit_at, excluded.deadline_commit_at),
         latest_commit_at = excluded.latest_commit_at,
         status = excluded.status,
         evaluated_at = excluded.evaluated_at`,
    )
    .bind(
      input.assignmentId,
      input.studentId,
      input.deadlineSha,
      input.deadlineCommitAt,
      input.latestCommitAt,
      input.status,
    )
    .run();
}

/** Re-check an already-frozen row: update status + latest_commit_at only. */
export async function refreshSubmissionStatus(
  db: D1Database,
  input: {
    assignmentId: string;
    studentId: string;
    latestCommitAt: string | null;
    status: SubmissionStatus;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE submissions
          SET status = ?3, latest_commit_at = ?4, evaluated_at = datetime('now')
        WHERE assignment_id = ?1 AND student_id = ?2`,
    )
    .bind(input.assignmentId, input.studentId, input.status, input.latestCommitAt)
    .run();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- submissions-db`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/submissions.ts test/integration/submissions-db.test.ts
git commit -m "feat(db): submissions repository with immutable deadline_sha"
```

---

## Task 8: Repo→student join helper in `db/repos.ts`

**Files:**
- Modify: `src/lib/db/repos.ts` (append a new query)
- Test: `test/integration/submissions-db.test.ts` (add one test)

- [ ] **Step 1: Write the failing test**

Append to `test/integration/submissions-db.test.ts` a new `describe` block (and add the import at the top: change the `db/repos` usage by importing `recordRepo` and the new helper):

Add to the imports at the top of the file:

```ts
import { listReposWithStudentsByAssignment, recordRepo } from "../../src/lib/db/repos";
```

Append this block at the end of the file:

```ts
describe("listReposWithStudentsByAssignment", () => {
  it("joins repos to their students with github_username", async () => {
    const { assignment, student } = await seed();
    await recordRepo(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      repoName: "hw1-alice",
      repoId: 123,
    });

    const rows = await listReposWithStudentsByAssignment(env.DB, assignment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      studentId: student.id,
      repoName: "hw1-alice",
      githubUsername: "alice",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- submissions-db`
Expected: FAIL — `listReposWithStudentsByAssignment` is not exported from `db/repos`.

- [ ] **Step 3: Add the join helper to `src/lib/db/repos.ts`**

Append to `src/lib/db/repos.ts`:

```ts
export interface RepoWithStudent {
  studentId: string;
  repoName: string;
  githubUsername: string | null;
}

/** All accepted repos for an assignment, joined to their students. */
export async function listReposWithStudentsByAssignment(
  db: D1Database,
  assignmentId: string,
): Promise<RepoWithStudent[]> {
  const { results } = await db
    .prepare(
      `SELECT r.student_id, r.repo_name, s.github_username
         FROM repos r
         JOIN students s ON s.id = r.student_id
        WHERE r.assignment_id = ?1
        ORDER BY s.github_username ASC`,
    )
    .bind(assignmentId)
    .all<{ student_id: string; repo_name: string; github_username: string | null }>();
  return results.map((r) => ({
    studentId: r.student_id,
    repoName: r.repo_name,
    githubUsername: r.github_username,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- submissions-db`
Expected: PASS (5 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/repos.ts test/integration/submissions-db.test.ts
git commit -m "feat(db): list repos joined to students for an assignment"
```

---

## Task 9: Evaluation orchestrator `domain/evaluation.ts`

**Files:**
- Create: `src/lib/domain/evaluation.ts`
- Test: `test/unit/evaluation.test.ts` (orchestrator unit test with injected deps)

This task uses a unit test with an in-memory fake `D1Database` and an injected `fetchImpl`, so the orchestration logic (due-state gating, freeze-vs-refresh, cache hit, per-repo error capture) is covered without the worker pool. The end-to-end wiring is covered by the integration test in Task 12.

- [ ] **Step 1: Write the failing test**

Create `test/unit/evaluation.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { evaluateAssignmentSubmissions } from "../../src/lib/domain/evaluation";

const DEADLINE = "2026-01-01T00:00:00Z";
const PAST_NOW = "2026-06-01T00:00:00Z";
const BEFORE_NOW = "2025-06-01T00:00:00Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function commit(sha: string, date: string) {
  return { sha, commit: { committer: { date } } };
}

// Minimal in-memory stand-ins for the db helpers the orchestrator calls. We
// inject them through `deps` so the orchestrator never touches a real D1.
function makeDeps(overrides: Partial<Parameters<typeof evaluateAssignmentSubmissions>[0]>) {
  const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("hw1-late")) {
      if (u.includes("until=")) return jsonResponse([commit("d-late", "2025-12-31T00:00:00Z")]);
      return jsonResponse([commit("l-late", "2026-02-01T00:00:00Z"), commit("tmpl", "2025-12-30T00:00:00Z")]);
    }
    // ontime
    if (u.includes("until=")) return jsonResponse([commit("d-ontime", "2025-12-31T00:00:00Z")]);
    return jsonResponse([commit("l-ontime", "2025-12-31T00:00:00Z"), commit("tmpl", "2025-12-30T00:00:00Z")]);
  });
  return {
    token: "ghs_x",
    fetchImpl,
    loadAssignment: vi.fn(async () => ({ id: "a1", classroomId: "c1", deadlineAt: DEADLINE })),
    loadClassroom: vi.fn(async () => ({ id: "c1", githubOrg: "org" })),
    listRepos: vi.fn(async () => [
      { studentId: "s1", repoName: "hw1-ontime", githubUsername: "ontime" },
      { studentId: "s2", repoName: "hw1-late", githubUsername: "late" },
    ]),
    getSubmission: vi.fn(async () => null),
    freezeSubmission: vi.fn(async () => {}),
    refreshSubmissionStatus: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("evaluateAssignmentSubmissions", () => {
  it("returns no-deadline without GitHub calls when the assignment has no deadline", async () => {
    const deps = makeDeps({ loadAssignment: vi.fn(async () => ({ id: "a1", classroomId: "c1", deadlineAt: null })) });
    const result = await evaluateAssignmentSubmissions(deps, { assignmentId: "a1", now: PAST_NOW, refresh: false });
    expect(result.dueState).toBe("no-deadline");
    expect(result.submissions.every((s) => s.status === null)).toBe(true);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.freezeSubmission).not.toHaveBeenCalled();
  });

  it("returns pending without freezing when now is before the deadline", async () => {
    const deps = makeDeps({});
    const result = await evaluateAssignmentSubmissions(deps, { assignmentId: "a1", now: BEFORE_NOW, refresh: false });
    expect(result.dueState).toBe("pending");
    expect(result.submissions.every((s) => s.status === "pending")).toBe(true);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.freezeSubmission).not.toHaveBeenCalled();
  });

  it("evaluates + freezes each repo past the deadline", async () => {
    const frozen: Record<string, string> = {};
    const deps = makeDeps({
      freezeSubmission: vi.fn(async (input: { studentId: string; status: string }) => {
        frozen[input.studentId] = input.status;
      }),
      // After a freeze, getSubmission should return the just-frozen row so the
      // view reflects it. First call (the gate read) returns null.
      getSubmission: vi.fn(async (_a: string, studentId: string) =>
        frozen[studentId]
          ? {
              assignmentId: "a1",
              studentId,
              deadlineSha: "d",
              deadlineCommitAt: "2025-12-31T00:00:00Z",
              latestCommitAt: "x",
              status: frozen[studentId],
              evaluatedAt: "2026-06-01T00:00:00Z",
            }
          : null,
      ),
    });
    const result = await evaluateAssignmentSubmissions(deps, { assignmentId: "a1", now: PAST_NOW, refresh: false });
    expect(result.dueState).toBe("evaluated");
    expect(frozen).toEqual({ s1: "on_time", s2: "late" });
    expect(result.errors).toEqual([]);
  });

  it("uses the cached row (no GitHub call) for an already-evaluated repo when refresh is false", async () => {
    const deps = makeDeps({
      listRepos: vi.fn(async () => [{ studentId: "s1", repoName: "hw1-ontime", githubUsername: "ontime" }]),
      getSubmission: vi.fn(async () => ({
        assignmentId: "a1",
        studentId: "s1",
        deadlineSha: "frozen",
        deadlineCommitAt: "2025-12-31T00:00:00Z",
        latestCommitAt: "2025-12-31T00:00:00Z",
        status: "on_time",
        evaluatedAt: "2026-05-01T00:00:00Z",
      })),
    });
    const result = await evaluateAssignmentSubmissions(deps, { assignmentId: "a1", now: PAST_NOW, refresh: false });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.freezeSubmission).not.toHaveBeenCalled();
    expect(result.submissions[0].status).toBe("on_time");
  });

  it("records a per-repo error and continues when a repo's GitHub read fails", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("hw1-late")) return jsonResponse({ message: "not found" }, 404);
        if (String(url).includes("until=")) return jsonResponse([commit("d-ontime", "2025-12-31T00:00:00Z")]);
        return jsonResponse([commit("l-ontime", "2025-12-31T00:00:00Z"), commit("tmpl", "2025-12-30T00:00:00Z")]);
      }),
    });
    const result = await evaluateAssignmentSubmissions(deps, { assignmentId: "a1", now: PAST_NOW, refresh: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].repoName).toBe("hw1-late");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit -- evaluation`
Expected: FAIL with "Cannot find module '../../src/lib/domain/evaluation'".

- [ ] **Step 3: Write the orchestrator**

Create `src/lib/domain/evaluation.ts`. It is fully injectable: the DB helpers and `fetchImpl` arrive through `deps`, so the same function is unit-tested with fakes and wired to the real helpers in the endpoints (Task 10/11).

```ts
import { GitHubApiError } from "../github/client";
import { readRepoCommitState } from "../github/commits";
import { classifySubmission } from "./deadline";

interface AssignmentLite {
  id: string;
  classroomId: string;
  deadlineAt: string | null;
}
interface ClassroomLite {
  id: string;
  githubOrg: string;
}
interface RepoLite {
  studentId: string;
  repoName: string;
  githubUsername: string | null;
}
interface SubmissionLite {
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
  latestCommitAt: string | null;
  status: string;
  evaluatedAt: string | null;
}

export interface EvaluationDeps {
  token: string;
  fetchImpl?: typeof fetch;
  loadAssignment: (id: string) => Promise<AssignmentLite | null>;
  loadClassroom: (id: string) => Promise<ClassroomLite | null>;
  listRepos: (assignmentId: string) => Promise<RepoLite[]>;
  getSubmission: (assignmentId: string, studentId: string) => Promise<SubmissionLite | null>;
  freezeSubmission: (input: {
    assignmentId: string;
    studentId: string;
    deadlineSha: string | null;
    deadlineCommitAt: string | null;
    latestCommitAt: string | null;
    status: "on_time" | "late" | "missing";
  }) => Promise<void>;
  refreshSubmissionStatus: (input: {
    assignmentId: string;
    studentId: string;
    latestCommitAt: string | null;
    status: "on_time" | "late" | "missing";
  }) => Promise<void>;
}

export type DueState = "no-deadline" | "pending" | "evaluated";

export interface SubmissionView {
  studentId: string;
  githubUsername: string | null;
  repoName: string;
  status: string | null;
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
  latestCommitAt: string | null;
  evaluatedAt: string | null;
}

export interface EvaluationResult {
  dueState: DueState;
  submissions: SubmissionView[];
  errors: { studentId: string; repoName: string; message: string }[];
}

function blankView(repo: RepoLite, status: string | null): SubmissionView {
  return {
    studentId: repo.studentId,
    githubUsername: repo.githubUsername,
    repoName: repo.repoName,
    status,
    deadlineSha: null,
    deadlineCommitAt: null,
    latestCommitAt: null,
    evaluatedAt: null,
  };
}

function rowView(repo: RepoLite, row: SubmissionLite): SubmissionView {
  return {
    studentId: repo.studentId,
    githubUsername: repo.githubUsername,
    repoName: repo.repoName,
    status: row.status,
    deadlineSha: row.deadlineSha,
    deadlineCommitAt: row.deadlineCommitAt,
    latestCommitAt: row.latestCommitAt,
    evaluatedAt: row.evaluatedAt,
  };
}

/** The assignment id was not found. Endpoints map this to a 404. */
export class AssignmentNotFoundError extends Error {
  constructor() {
    super("Assignment not found");
    this.name = "AssignmentNotFoundError";
  }
}

export async function evaluateAssignmentSubmissions(
  deps: EvaluationDeps,
  input: { assignmentId: string; now: string; refresh: boolean },
): Promise<EvaluationResult> {
  const assignment = await deps.loadAssignment(input.assignmentId);
  if (!assignment) throw new AssignmentNotFoundError();

  const repos = await deps.listRepos(assignment.id);

  if (assignment.deadlineAt === null) {
    return { dueState: "no-deadline", submissions: repos.map((r) => blankView(r, null)), errors: [] };
  }
  if (Date.parse(input.now) < Date.parse(assignment.deadlineAt)) {
    return { dueState: "pending", submissions: repos.map((r) => blankView(r, "pending")), errors: [] };
  }

  const classroom = await deps.loadClassroom(assignment.classroomId);
  if (!classroom) throw new AssignmentNotFoundError();

  const submissions: SubmissionView[] = [];
  const errors: EvaluationResult["errors"] = [];

  for (const repo of repos) {
    const existing = await deps.getSubmission(assignment.id, repo.studentId);
    const alreadyEvaluated = Boolean(existing?.evaluatedAt);

    if (alreadyEvaluated && !input.refresh) {
      submissions.push(rowView(repo, existing!));
      continue;
    }

    try {
      const state = await readRepoCommitState({
        token: deps.token,
        owner: classroom.githubOrg,
        repo: repo.repoName,
        deadlineAt: assignment.deadlineAt,
        fetchImpl: deps.fetchImpl,
      });
      const status = classifySubmission({
        deadlineAt: assignment.deadlineAt,
        latestCommitAt: state.latestCommitAt,
        hasStudentCommits: state.hasStudentCommits,
      });

      if (alreadyEvaluated) {
        await deps.refreshSubmissionStatus({
          assignmentId: assignment.id,
          studentId: repo.studentId,
          latestCommitAt: state.latestCommitAt,
          status,
        });
      } else {
        await deps.freezeSubmission({
          assignmentId: assignment.id,
          studentId: repo.studentId,
          deadlineSha: state.deadlineSha,
          deadlineCommitAt: state.deadlineCommitAt,
          latestCommitAt: state.latestCommitAt,
          status,
        });
      }

      const row = await deps.getSubmission(assignment.id, repo.studentId);
      submissions.push(row ? rowView(repo, row) : blankView(repo, status));
    } catch (err) {
      // A single repo's GitHub failure (404 deleted, transient) is captured and
      // does not abort the others. Non-GitHub errors propagate.
      if (err instanceof GitHubApiError) {
        errors.push({
          studentId: repo.studentId,
          repoName: repo.repoName,
          message: `GitHub request failed (${err.status})`,
        });
        continue;
      }
      throw err;
    }
  }

  return { dueState: "evaluated", submissions, errors };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:unit -- evaluation`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/evaluation.ts test/unit/evaluation.test.ts
git commit -m "feat(domain): lazy submission evaluation orchestrator"
```

---

## Task 10: GET status-board endpoint

**Files:**
- Create: `src/pages/api/assignments/[id]/submissions.ts`

The endpoint resolves the user, authorizes via the assignment's classroom, mints an installation token, and wires the real DB helpers into `EvaluationDeps`. The integration test in Task 12 exercises it; this task wires and typechecks it.

- [ ] **Step 1: Write the GET endpoint**

Create `src/pages/api/assignments/[id]/submissions.ts`:

```ts
import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { getAssignmentById } from "../../../../lib/db/assignments";
import { getClassroomById } from "../../../../lib/db/classrooms";
import { listReposWithStudentsByAssignment } from "../../../../lib/db/repos";
import {
  freezeSubmission,
  getSubmission,
  refreshSubmissionStatus,
} from "../../../../lib/db/submissions";
import { assertOwnsClassroom } from "../../../../lib/domain/authz";
import {
  AssignmentNotFoundError,
  type EvaluationDeps,
  evaluateAssignmentSubmissions,
} from "../../../../lib/domain/evaluation";
import { getInstallationToken } from "../../../../lib/github/app";
import { NotFoundError, toResponse } from "../../../../lib/http/errors";
import { error, json } from "../../../../lib/http/json";

/** Build the EvaluationDeps that bind the orchestrator to D1 + the GitHub token. */
export function buildEvaluationDeps(db: EnvDb, token: string): EvaluationDeps {
  return {
    token,
    loadAssignment: (id) => getAssignmentById(db, id),
    loadClassroom: (id) => getClassroomById(db, id),
    listRepos: (assignmentId) => listReposWithStudentsByAssignment(db, assignmentId),
    getSubmission: (assignmentId, studentId) => getSubmission(db, assignmentId, studentId),
    freezeSubmission: (input) => freezeSubmission(db, input),
    refreshSubmissionStatus: (input) => refreshSubmissionStatus(db, input),
  };
}

type EnvDb = ReturnType<typeof getEnv>["DB"];

export const GET: APIRoute = async ({ params, cookies }) => {
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

    const result = await evaluateAssignmentSubmissions(buildEvaluationDeps(env.DB, token), {
      assignmentId: assignment.id,
      now: new Date().toISOString(),
      refresh: false,
    });

    return json({ assignmentId: assignment.id, ...result }, 200);
  } catch (err) {
    if (err instanceof AssignmentNotFoundError) return error(err.message, 404);
    return toResponse(err);
  }
};
```

- [ ] **Step 2: Typecheck**

Run: `yarn typecheck`
Expected: PASS. (If `tsc` complains that `EnvDb` is used before its declaration, move the `type EnvDb = ...` line above `buildEvaluationDeps`.)

- [ ] **Step 3: Commit**

```bash
git add src/pages/api/assignments/[id]/submissions.ts
git commit -m "feat(api): GET assignment submissions status board (lazy eval)"
```

---

## Task 11: POST `/refresh` endpoint

**Files:**
- Create: `src/pages/api/assignments/[id]/submissions/refresh.ts`

Astro file routing: a file at `submissions/refresh.ts` serves `/api/assignments/:id/submissions/refresh`, coexisting with `submissions.ts` (which serves `/api/assignments/:id/submissions`). This keeps the URL exactly as the spec requires.

- [ ] **Step 1: Write the POST endpoint**

Create `src/pages/api/assignments/[id]/submissions/refresh.ts`:

```ts
import type { APIRoute } from "astro";
import { requireSession } from "../../../../../lib/auth/require";
import { getEnv } from "../../../../../lib/config";
import { getAssignmentById } from "../../../../../lib/db/assignments";
import { assertOwnsClassroom } from "../../../../../lib/domain/authz";
import {
  AssignmentNotFoundError,
  evaluateAssignmentSubmissions,
} from "../../../../../lib/domain/evaluation";
import { getInstallationToken } from "../../../../../lib/github/app";
import { NotFoundError, toResponse } from "../../../../../lib/http/errors";
import { error, json } from "../../../../../lib/http/json";
import { buildEvaluationDeps } from "../submissions";

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

    const result = await evaluateAssignmentSubmissions(buildEvaluationDeps(env.DB, token), {
      assignmentId: assignment.id,
      now: new Date().toISOString(),
      refresh: true,
    });

    return json({ assignmentId: assignment.id, ...result }, 200);
  } catch (err) {
    if (err instanceof AssignmentNotFoundError) return error(err.message, 404);
    return toResponse(err);
  }
};
```

- [ ] **Step 2: Typecheck**

Run: `yarn typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/pages/api/assignments/[id]/submissions/refresh.ts
git commit -m "feat(api): POST assignment submissions refresh (re-check late-ness)"
```

---

## Task 12: GitHub mock + end-to-end integration test

**Files:**
- Modify: `test/integration/github-mock.ts` (add a `/commits` responder)
- Create: `test/integration/submissions-api.test.ts`

- [ ] **Step 1: Add the commits responder to the GitHub mock**

In `test/integration/github-mock.ts`, insert this block **before** the final `return new Response("unmocked GitHub request...", { status: 501 });` line:

```ts
  // Commits read for deadline evaluation. Deterministic by repo name (mirrors
  // the "member" convention above): a repo name containing "late" has its
  // latest commit AFTER the deadline; "missing" has only the single
  // template-import commit (no student commits); anything else ("ontime") has
  // its latest commit BEFORE the deadline. Tests seed deadline_at = the fixed
  // DEADLINE below. The `until=` request returns the last commit at-or-before
  // the deadline (the pinned deadline SHA).
  const commits = path.match(/^\/repos\/([^/]+)\/([^/]+)\/commits$/);
  if (method === "GET" && commits) {
    const repo = commits[2];
    const until = url.searchParams.has("until");
    const mk = (sha: string, date: string) => ({ sha, commit: { committer: { date } } });
    const BEFORE = "2025-12-31T00:00:00Z"; // before DEADLINE 2026-01-01T00:00:00Z
    const AFTER = "2026-02-01T00:00:00Z"; //  after  DEADLINE
    const TEMPLATE = "2025-12-30T00:00:00Z";

    if (/missing/i.test(repo)) {
      // Only the template-import commit (length 1 → hasStudentCommits false).
      return jsonResponse(200, [mk("template-sha", TEMPLATE)]);
    }
    if (/late/i.test(repo)) {
      if (until) return jsonResponse(200, [mk("deadline-late-sha", BEFORE)]);
      return jsonResponse(200, [mk("latest-late-sha", AFTER), mk("template-sha", TEMPLATE)]);
    }
    // ontime (default)
    if (until) return jsonResponse(200, [mk("deadline-ontime-sha", BEFORE)]);
    return jsonResponse(200, [mk("latest-ontime-sha", BEFORE), mk("template-sha", TEMPLATE)]);
  }
```

- [ ] **Step 2: Write the failing integration test**

Create `test/integration/submissions-api.test.ts`:

```ts
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { recordRepo } from "../../src/lib/db/repos";
import { createStudent } from "../../src/lib/db/students";
import { clearInstallationTokenCache } from "../../src/lib/github/app";
import { seedUserAndCookie } from "./helpers";

beforeEach(() => clearInstallationTokenCache());

const PAST_DEADLINE = "2026-01-01T00:00:00Z";

interface SubmissionView {
  studentId: string;
  repoName: string;
  status: string | null;
  deadlineSha: string | null;
  evaluatedAt: string | null;
  latestCommitAt: string | null;
}
interface Board {
  data: { assignmentId: string; dueState: string; submissions: SubmissionView[]; errors: unknown[] };
}

/** Seed an owned classroom + assignment + two accepted repos (ontime, late). */
async function seedBoard(opts: { deadlineAt?: string; githubId: number } = { githubId: 1 }) {
  const teacher = await seedUserAndCookie({ githubId: opts.githubId, login: `teacher-${opts.githubId}` });
  const classroom = await createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "test-org",
    timezone: "UTC",
    createdBy: teacher.user.id,
  });
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id,
    slug: "hw1",
    title: "HW 1",
    templateRepo: "test-org/hw1-template",
    deadlineAt: opts.deadlineAt,
  });

  async function seedRepo(username: string) {
    const u = await seedUserAndCookie({ githubId: opts.githubId * 100 + username.length, login: username });
    const student = await createStudent(env.DB, {
      classroomId: classroom.id,
      userId: u.user.id,
      githubUsername: username,
    });
    await recordRepo(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      repoName: `hw1-${username}`,
      repoId: 1000 + username.length,
    });
    return student;
  }

  const ontime = await seedRepo("ontime");
  const late = await seedRepo("late");
  return { teacher, classroom, assignment, ontime, late };
}

function getBoard(assignmentId: string, cookie?: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/assignments/${assignmentId}/submissions`, {
    headers: cookie ? { cookie } : {},
  });
}
function postRefresh(assignmentId: string, cookie: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/assignments/${assignmentId}/submissions/refresh`, {
    method: "POST",
    headers: { cookie },
  });
}

describe("GET /api/assignments/:id/submissions", () => {
  it("evaluates + freezes each repo past the deadline", async () => {
    const { teacher, assignment, ontime, late } = await seedBoard({ deadlineAt: PAST_DEADLINE, githubId: 1 });

    const res = await getBoard(assignment.id, teacher.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Board;
    expect(body.data.dueState).toBe("evaluated");

    const byStudent = Object.fromEntries(body.data.submissions.map((s) => [s.studentId, s]));
    expect(byStudent[ontime.id].status).toBe("on_time");
    expect(byStudent[late.id].status).toBe("late");
    for (const s of body.data.submissions) {
      expect(s.deadlineSha).not.toBeNull();
      expect(s.evaluatedAt).not.toBeNull();
    }
  });

  it("is a cache hit on a second GET (evaluated_at unchanged)", async () => {
    const { teacher, assignment, ontime } = await seedBoard({ deadlineAt: PAST_DEADLINE, githubId: 2 });

    const first = (await (await getBoard(assignment.id, teacher.cookie)).json()) as Board;
    const firstEvaluatedAt = first.data.submissions.find((s) => s.studentId === ontime.id)!.evaluatedAt;

    const second = (await (await getBoard(assignment.id, teacher.cookie)).json()) as Board;
    const secondEvaluatedAt = second.data.submissions.find((s) => s.studentId === ontime.id)!.evaluatedAt;

    // State, not call counts: a re-evaluation would have rewritten evaluated_at.
    expect(secondEvaluatedAt).toBe(firstEvaluatedAt);
  });

  it("surfaces a null-deadline assignment as no-deadline with null statuses", async () => {
    const { teacher, assignment } = await seedBoard({ githubId: 3 }); // no deadlineAt
    const body = (await (await getBoard(assignment.id, teacher.cookie)).json()) as Board;
    expect(body.data.dueState).toBe("no-deadline");
    expect(body.data.submissions.every((s) => s.status === null)).toBe(true);
  });

  it("returns 403 to a non-owner and 404 for an unknown assignment", async () => {
    const { assignment } = await seedBoard({ deadlineAt: PAST_DEADLINE, githubId: 4 });
    const intruder = await seedUserAndCookie({ githubId: 999, login: "intruder" });
    expect((await getBoard(assignment.id, intruder.cookie)).status).toBe(403);
    expect(
      (await getBoard("00000000-0000-0000-0000-000000000000", intruder.cookie)).status,
    ).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    const { assignment } = await seedBoard({ deadlineAt: PAST_DEADLINE, githubId: 5 });
    expect((await getBoard(assignment.id)).status).toBe(401);
  });
});

describe("POST /api/assignments/:id/submissions/refresh", () => {
  it("re-checks late-ness on a frozen row, flipping status while preserving deadline_sha", async () => {
    const { teacher, assignment, late } = await seedBoard({ deadlineAt: PAST_DEADLINE, githubId: 6 });

    // Pre-freeze the "late" repo's row AS on_time, as if a first evaluation
    // ran while the latest commit was still before the deadline. The mock now
    // reports this repo (name contains "late") as late, so refresh must flip it
    // while keeping the immutable deadline_sha.
    await env.DB.prepare(
      `INSERT INTO submissions
         (assignment_id, student_id, deadline_sha, deadline_commit_at, latest_commit_at, status, evaluated_at)
       VALUES (?1, ?2, 'frozen-sha', '2025-12-31T00:00:00Z', '2025-12-31T00:00:00Z', 'on_time', '2026-01-02T00:00:00Z')`,
    )
      .bind(assignment.id, late.id)
      .run();

    const res = await postRefresh(assignment.id, teacher.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Board;

    const lateRow = body.data.submissions.find((s) => s.studentId === late.id)!;
    expect(lateRow.status).toBe("late");
    expect(lateRow.deadlineSha).toBe("frozen-sha"); // preserved
    expect(lateRow.latestCommitAt).toBe("2026-02-01T00:00:00Z"); // updated by refresh
  });
});
```

- [ ] **Step 3: Run the test to verify it fails (then passes)**

Run: `yarn test:integration -- submissions-api`
Expected: First run may FAIL only if the mock/test are out of sync; with both Step 1 and Step 2 in place it should PASS (7 tests). If it fails, read the failure — common causes: the `/commits` block placed after the 501 fallthrough (move it before), or a repo name not matching the `late`/`missing`/`ontime` convention.

- [ ] **Step 4: Commit**

```bash
git add test/integration/github-mock.ts test/integration/submissions-api.test.ts
git commit -m "test(api): end-to-end submissions status board + refresh"
```

---

## Task 13: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole project**

Run: `yarn typecheck`
Expected: PASS (both `tsc` invocations clean).

- [ ] **Step 2: Run the unit suite**

Run: `yarn test:unit`
Expected: PASS — including `deadline`, `github-commits`, `evaluation`, and the updated `validation` tests.

- [ ] **Step 3: Run the integration suite**

Run: `yarn test:integration`
Expected: PASS — including `submissions-db`, `submissions-api`, and all grace-stripped tests. (Note: per the project's memory, the `index-page` DEBUG_ROUTES 404 test can fail locally due to `.dev.vars` setting `DEBUG_ROUTES=1`; that is environmental, not a regression from this work.)

- [ ] **Step 4: Final commit (if any uncommitted formatting remains)**

```bash
git status
# If clean, nothing to do. Otherwise:
git add -A
git commit -m "chore: phase 3 deadline evaluation cleanup"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Migration `0004` (Task 1); grace removal across schema/db/endpoint/tests (Tasks 2–4); classifier (Task 5); GitHub reads (Task 6); submissions DB with immutable `deadline_sha` (Task 7); repo↔student join (Task 8); orchestrator with due-state gating, freeze/refresh, cache, per-repo error capture (Task 9); GET + POST endpoints, owner-only (Tasks 10–11); GitHub mock + integration tests covering freeze, cache-hit-by-state, refresh-flip, 403/404/401/no-deadline (Task 12).
- **Type consistency:** `SubmissionStatus = "on_time" | "late" | "missing"` is defined once in `deadline.ts` and reused. `EvaluationDeps`/`buildEvaluationDeps` bind the real DB helpers; the orchestrator's `*Lite` interfaces are structurally satisfied by `Assignment`/`Classroom`/`RepoWithStudent`/`Submission` (extra fields are allowed by structural typing). `freezeSubmission`/`refreshSubmissionStatus` signatures match between `db/submissions.ts` and the `EvaluationDeps` contract.
- **Per-repo error policy:** GitHub failures for one repo are captured in `errors[]` and do not abort the loop (§6). A token-mint `GitHubApiError` thrown in the endpoint (outside the loop) still surfaces as 502 via `toResponse` (§8.3), reconciling the two spec passages.
- **Immutability:** `deadline_sha`/`deadline_commit_at` are written once; `freezeSubmission`'s `COALESCE` guard and `refreshSubmissionStatus`'s narrow UPDATE both enforce it, verified by `submissions-db.test.ts` and the refresh integration test.
