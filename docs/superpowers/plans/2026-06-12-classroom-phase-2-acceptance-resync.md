# Classroom Phase 2 (Acceptance + Re-sync) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a teacher pre-seed a class roster, let a student accept an assignment (create their repo from the template + grant push access), and give the student an idempotent re-sync escape hatch to recover access.

**Architecture:** Phase 0/1 patterns continue: framework-agnostic logic in `src/lib/*` (typed row-mappers, `fetchImpl`-injectable GitHub helpers, typed errors + `toResponse`), with thin Astro `src/pages/api/*` adapters (authenticate → authorize → validate → DB/GitHub → JSON envelope). Acceptance and re-sync are synchronous and per-student (no queue). This is the first phase that writes to GitHub.

**Tech Stack:** Astro (Workers SSR) · Cloudflare D1 · Valibot · GitHub App installation token (`getInstallationToken` + `githubRequest`) · Vitest (unit) + `@cloudflare/vitest-pool-workers` (integration, GitHub mocked with `cloudflare:test` `fetchMock`).

---

## Planning Decisions (resolving spec §10 open items)

These were left open in the design; this plan commits to the following so tasks contain no ambiguity:

1. **Integration-test GitHub mocking** — Use `cloudflare:test` `fetchMock` to intercept all outbound `api.github.com` traffic, including the installation-token mint (`POST /app/installations/{id}/access_tokens`). Because `mintInstallationToken` first builds a real RS256 JWT (via `crypto.subtle`), the integration test bindings must carry a **real throwaway PKCS#8 RSA key** (Task 9 generates it). `clearInstallationTokenCache()` is called in `beforeEach` so each test mints exactly once. Endpoints do **not** thread `fetchImpl`; they rely on the global `fetch` that `fetchMock` intercepts.

2. **`422` "name already exists" recovery** — Key the recovery branch on **HTTP status `422` alone**, not on fragile body-message matching. On `422` from `…/generate`, issue `GET /repos/{owner}/{name}`; if it returns the repo, treat the generate as recovered; if that GET itself fails, rethrow the original error.

3. **Seeding duplicates** — `seedStudents` is **idempotent and additive**: it dedupes identifiers within the request and skips identifiers that already exist as a `roster_identifier` in the classroom. Re-seeding the same list is a safe no-op. It returns the **full current roster** for the classroom.

4. **Collaborator `201` invitation** — `addCollaborator` captures `invitation.html_url` from the `201` body when present; if absent, `invitationUrl` is simply `undefined` (never throws on a missing field).

5. **`repoUrl` shape** — On the create path, return the authoritative `html_url` from the generate/recovery response. On the idempotent already-accepted path (no stored URL), construct `https://github.com/{org}/{repoName}` via `repoUrlFor`.

---

## File Structure

**New files:**
- `migrations/0003_student_user_link.sql` — add `students.user_id` + unique `(classroom_id, user_id)` index.
- `src/lib/github/repos.ts` — `createRepoFromTemplate`, `addCollaborator` (both `fetchImpl`-injectable).
- `src/lib/db/students.ts` — `Student` type/mapper + seed/list/find/claim/create.
- `src/lib/db/repos.ts` — `Repo` type/mapper + `getRepoByAssignmentStudent`, `recordRepo`, `touchPermissionSynced`.
- `src/lib/domain/enrollment.ts` — `resolveStudentForAccept` (claim-or-skip orchestration).
- `src/pages/api/classrooms/[id]/students.ts` — `POST` seed roster · `GET` list roster (owner).
- `src/pages/api/assignments/[id]/roster.ts` — `GET` unclaimed options (any authed).
- `src/pages/api/assignments/[id]/accept.ts` — `POST` accept.
- `src/pages/api/assignments/[id]/resync.ts` — `POST` re-issue invite.
- `test/unit/github-repos.test.ts`, `test/unit/schemas-phase2.test.ts`, `test/unit/errors-github.test.ts`, `test/unit/enrollment.test.ts`.
- `test/integration/students-api.test.ts`, `test/integration/roster-api.test.ts`, `test/integration/accept-api.test.ts`, `test/integration/resync-api.test.ts`.
- `test/integration/github-mock.ts` — `fetchMock` helpers for the GitHub endpoints.

**Modified files:**
- `src/lib/http/schemas.ts` — add `seedRosterSchema`, `acceptAssignmentSchema`.
- `src/lib/http/errors.ts` — map `GitHubApiError → 502` in `toResponse`.
- `src/lib/domain/slug.ts` — add `splitRepo`, `repoUrlFor` helpers.
- `vitest.integration.config.ts` — add real test PKCS#8 key to bindings.

> **Import-depth note:** every new endpoint sits at `src/pages/api/.../[id]/<file>.ts` (one dir deeper than `assignments/[id].ts`), so all of them import lib with `../../../../lib/...` (four `..`), exactly like the existing `classrooms/[id]/assignments.ts`.

---

## Task 1: Migration — link students to a stable user identity

**Files:**
- Create: `migrations/0003_student_user_link.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0003_student_user_link.sql`:

```sql
-- Phase 2: link a roster entry to the stable authenticated identity (users.id),
-- not just the mutable github_username.
ALTER TABLE students ADD COLUMN user_id TEXT REFERENCES users(id);

-- One account can claim at most one roster row per classroom. SQLite treats NULLs
-- as distinct, so many unclaimed (user_id IS NULL) rows still coexist.
CREATE UNIQUE INDEX students_classroom_user ON students(classroom_id, user_id);
```

- [ ] **Step 2: Apply the migration locally to verify it parses**

Run: `yarn wrangler d1 migrations apply DB --local`
Expected: migration `0003_student_user_link.sql` reported as applied with no SQL error. (If the binding name differs, use the name from `wrangler.jsonc`; the point is only to confirm the SQL is valid.)

- [ ] **Step 3: Commit**

```bash
git add migrations/0003_student_user_link.sql
git commit -m "feat: add students.user_id link + unique (classroom_id, user_id) index"
```

---

## Task 2: Map `GitHubApiError` → 502 in `toResponse`

**Files:**
- Modify: `src/lib/http/errors.ts`
- Test: `test/unit/errors-github.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/errors-github.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../../src/lib/github/client";
import { ConflictError, NotFoundError, toResponse } from "../../src/lib/http/errors";

describe("toResponse — GitHubApiError mapping", () => {
  it("maps a GitHubApiError to 502 with a safe message (no upstream body leaked)", async () => {
    const err = new GitHubApiError("token=ghs_secret leaked detail", 404, {
      remaining: null,
      reset: null,
      retryAfterSeconds: null,
    });
    const res = toResponse(err);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Upstream GitHub request failed");
    expect(body.error.message).not.toContain("ghs_secret");
  });

  it("still maps existing domain errors to their own codes", async () => {
    expect(toResponse(new NotFoundError("x")).status).toBe(404);
    expect(toResponse(new ConflictError("x")).status).toBe(409);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run -c vitest.unit.config.ts test/unit/errors-github.test.ts`
Expected: FAIL — the GitHubApiError case returns 500, not 502.

- [ ] **Step 3: Add the mapping**

In `src/lib/http/errors.ts`, add the import at the top (alongside the existing imports):

```typescript
import { GitHubApiError } from "../github/client";
```

Then in `toResponse`, add this branch **before** the final `console.error(...)` / `return error("Internal Server Error", 500)` fallback:

```typescript
  if (err instanceof GitHubApiError) {
    // Log the real upstream detail server-side; never return it (it may contain tokens).
    console.error("github upstream error:", err.status, err.message);
    return error("Upstream GitHub request failed", 502);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run -c vitest.unit.config.ts test/unit/errors-github.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/http/errors.ts test/unit/errors-github.test.ts
git commit -m "feat: map GitHubApiError to 502 in toResponse"
```

---

## Task 3: Valibot schemas — `seedRoster` + `acceptAssignment`

**Files:**
- Modify: `src/lib/http/schemas.ts`
- Test: `test/unit/schemas-phase2.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/schemas-phase2.test.ts`:

```typescript
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { acceptAssignmentSchema, seedRosterSchema } from "../../src/lib/http/schemas";

describe("seedRosterSchema", () => {
  it("accepts a non-empty list of trimmed identifiers", () => {
    const out = v.parse(seedRosterSchema, { identifiers: ["  alice  ", "bob"] });
    expect(out.identifiers).toEqual(["alice", "bob"]);
  });

  it("rejects an empty identifiers array", () => {
    expect(() => v.parse(seedRosterSchema, { identifiers: [] })).toThrow();
  });

  it("rejects an empty-string identifier", () => {
    expect(() => v.parse(seedRosterSchema, { identifiers: ["ok", "  "] })).toThrow();
  });

  it("rejects a missing identifiers field", () => {
    expect(() => v.parse(seedRosterSchema, {})).toThrow();
  });
});

describe("acceptAssignmentSchema", () => {
  it("accepts an empty body (skip path)", () => {
    const out = v.parse(acceptAssignmentSchema, {});
    expect(out.rosterStudentId).toBeUndefined();
  });

  it("accepts a valid uuid rosterStudentId (claim path)", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const out = v.parse(acceptAssignmentSchema, { rosterStudentId: id });
    expect(out.rosterStudentId).toBe(id);
  });

  it("rejects a non-uuid rosterStudentId", () => {
    expect(() => v.parse(acceptAssignmentSchema, { rosterStudentId: "not-a-uuid" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run -c vitest.unit.config.ts test/unit/schemas-phase2.test.ts`
Expected: FAIL — `seedRosterSchema` / `acceptAssignmentSchema` are not exported.

- [ ] **Step 3: Add the schemas**

In `src/lib/http/schemas.ts` (which already does `import * as v from "valibot";`), append:

```typescript
export const seedRosterSchema = v.object({
  identifiers: v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.minLength(1, "identifier must not be empty"))),
    v.minLength(1, "identifiers must contain at least one entry"),
  ),
});

export const acceptAssignmentSchema = v.object({
  rosterStudentId: v.optional(v.pipe(v.string(), v.uuid("rosterStudentId must be a valid id"))),
});

export type SeedRosterBody = v.InferOutput<typeof seedRosterSchema>;
export type AcceptAssignmentBody = v.InferOutput<typeof acceptAssignmentSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run -c vitest.unit.config.ts test/unit/schemas-phase2.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/http/schemas.ts test/unit/schemas-phase2.test.ts
git commit -m "feat: add seedRoster and acceptAssignment Valibot schemas"
```

---

## Task 4: `github/repos.ts` — `createRepoFromTemplate` (+ 422 recovery)

**Files:**
- Create: `src/lib/github/repos.ts`
- Test: `test/unit/github-repos.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/github-repos.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createRepoFromTemplate } from "../../src/lib/github/repos";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createRepoFromTemplate", () => {
  it("POSTs to the generate endpoint with the right body and maps the result", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 42, full_name: "org/hw1-octocat", html_url: "https://github.com/org/hw1-octocat" }, 201),
    );

    const result = await createRepoFromTemplate({
      token: "ghs_x",
      templateOwner: "org",
      templateRepo: "hw1-template",
      owner: "org",
      name: "hw1-octocat",
      isPrivate: true,
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/org/hw1-template/generate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ owner: "org", name: "hw1-octocat", private: true });
    expect(result).toEqual({ repoId: 42, fullName: "org/hw1-octocat", htmlUrl: "https://github.com/org/hw1-octocat" });
  });

  it("recovers from a 422 (name already exists) by GETting the existing repo", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "name already exists on this account" }, 422))
      .mockResolvedValueOnce(
        jsonResponse({ id: 7, full_name: "org/hw1-octocat", html_url: "https://github.com/org/hw1-octocat" }, 200),
      );

    const result = await createRepoFromTemplate({
      token: "ghs_x",
      templateOwner: "org",
      templateRepo: "hw1-template",
      owner: "org",
      name: "hw1-octocat",
      isPrivate: true,
      fetchImpl,
    });

    expect((fetchImpl.mock.calls[1] as [string])[0]).toBe("https://api.github.com/repos/org/hw1-octocat");
    expect(result.repoId).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run -c vitest.unit.config.ts test/unit/github-repos.test.ts`
Expected: FAIL — module `src/lib/github/repos.ts` does not exist.

- [ ] **Step 3: Implement `createRepoFromTemplate`**

Create `src/lib/github/repos.ts`:

```typescript
import { GitHubApiError, githubRequest } from "./client";

interface GitHubRepo {
  id: number;
  full_name: string;
  html_url: string;
}

export interface CreateRepoResult {
  repoId: number;
  fullName: string;
  htmlUrl: string;
}

export async function createRepoFromTemplate(input: {
  token: string;
  templateOwner: string;
  templateRepo: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  fetchImpl?: typeof fetch;
}): Promise<CreateRepoResult> {
  const { token, templateOwner, templateRepo, owner, name, isPrivate, fetchImpl } = input;
  try {
    const { data } = await githubRequest<GitHubRepo>(
      `/repos/${templateOwner}/${templateRepo}/generate`,
      { method: "POST", token, body: { owner, name, private: isPrivate }, fetchImpl },
    );
    return { repoId: data.id, fullName: data.full_name, htmlUrl: data.html_url };
  } catch (err) {
    // Partial-failure recovery: the repo already exists from a prior attempt.
    // Key on status 422 alone, then confirm via GET (body messages are fragile).
    if (err instanceof GitHubApiError && err.status === 422) {
      const { data } = await githubRequest<GitHubRepo>(`/repos/${owner}/${name}`, { token, fetchImpl });
      return { repoId: data.id, fullName: data.full_name, htmlUrl: data.html_url };
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run -c vitest.unit.config.ts test/unit/github-repos.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/github/repos.ts test/unit/github-repos.test.ts
git commit -m "feat: add createRepoFromTemplate with 422 recovery"
```

---

## Task 5: `github/repos.ts` — `addCollaborator` (201 invited / 204 already_member)

**Files:**
- Modify: `src/lib/github/repos.ts`
- Test: `test/unit/github-repos.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `test/unit/github-repos.test.ts`:

```typescript
import { addCollaborator } from "../../src/lib/github/repos";

describe("addCollaborator", () => {
  it("PUTs the permission and returns invited + invitationUrl on 201", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ html_url: "https://github.com/org/hw1-octocat/invitations" }, 201),
    );

    const result = await addCollaborator({
      token: "ghs_x",
      owner: "org",
      repo: "hw1-octocat",
      username: "octocat",
      permission: "push",
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/org/hw1-octocat/collaborators/octocat");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ permission: "push" });
    expect(result).toEqual({
      status: "invited",
      invitationUrl: "https://github.com/org/hw1-octocat/invitations",
    });
  });

  it("returns already_member on 204 (no body)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    const result = await addCollaborator({
      token: "ghs_x",
      owner: "org",
      repo: "hw1-octocat",
      username: "octocat",
      permission: "push",
      fetchImpl,
    });

    expect(result).toEqual({ status: "already_member" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run -c vitest.unit.config.ts test/unit/github-repos.test.ts`
Expected: FAIL — `addCollaborator` is not exported.

- [ ] **Step 3: Implement `addCollaborator`**

Append to `src/lib/github/repos.ts`:

```typescript
export interface AddCollaboratorResult {
  status: "invited" | "already_member";
  invitationUrl?: string;
}

export async function addCollaborator(input: {
  token: string;
  owner: string;
  repo: string;
  username: string;
  permission: string;
  fetchImpl?: typeof fetch;
}): Promise<AddCollaboratorResult> {
  const { token, owner, repo, username, permission, fetchImpl } = input;
  const { data, status } = await githubRequest<{ html_url?: string } | undefined>(
    `/repos/${owner}/${repo}/collaborators/${username}`,
    { method: "PUT", token, body: { permission }, fetchImpl },
  );
  // 201 → a repository invitation was created; 204 → already a collaborator.
  if (status === 201) {
    return { status: "invited", invitationUrl: data?.html_url };
  }
  return { status: "already_member" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run -c vitest.unit.config.ts test/unit/github-repos.test.ts`
Expected: PASS (all four cases in the file).

- [ ] **Step 5: Commit**

```bash
git add src/lib/github/repos.ts test/unit/github-repos.test.ts
git commit -m "feat: add addCollaborator (201 invited / 204 already_member)"
```

---

## Task 6: `db/students.ts` + roster seed/list endpoints

This task is integration-driven: the failing integration test exercises the new endpoints, which in turn drive `db/students.ts` (D1-backed code is covered through endpoints, matching the Phase 0/1 split).

**Files:**
- Create: `src/lib/db/students.ts`
- Create: `src/pages/api/classrooms/[id]/students.ts`
- Test: `test/integration/students-api.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/students-api.test.ts`:

```typescript
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createClassroom } from "../../src/lib/db/classrooms";
import { seedUserAndCookie } from "./helpers";
import { env } from "cloudflare:test";

async function makeClassroom(ownerId: string) {
  return createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "test-org",
    timezone: "UTC",
    createdBy: ownerId,
  });
}

describe("POST/GET /api/classrooms/:id/students", () => {
  it("seeds unclaimed roster rows and lists them (201/200)", async () => {
    const { user, cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const classroom = await makeClassroom(user.id);

    const seedRes = await SELF.fetch(`https://example.com/api/classrooms/${classroom.id}/students`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ identifiers: ["alice", "bob"] }),
    });
    expect(seedRes.status).toBe(201);
    const seeded = (await seedRes.json()) as { data: Array<{ rosterIdentifier: string; userId: string | null }> };
    expect(seeded.data.map((s) => s.rosterIdentifier).sort()).toEqual(["alice", "bob"]);
    expect(seeded.data.every((s) => s.userId === null)).toBe(true);

    const listRes = await SELF.fetch(`https://example.com/api/classrooms/${classroom.id}/students`, {
      headers: { cookie },
    });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { data: unknown[] };
    expect(listed.data).toHaveLength(2);
  });

  it("is idempotent — re-seeding the same identifiers adds no duplicates", async () => {
    const { user, cookie } = await seedUserAndCookie({ githubId: 2, login: "teacher2" });
    const classroom = await makeClassroom(user.id);
    const body = JSON.stringify({ identifiers: ["alice", "alice", "bob"] });

    await SELF.fetch(`https://example.com/api/classrooms/${classroom.id}/students`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body,
    });
    const res = await SELF.fetch(`https://example.com/api/classrooms/${classroom.id}/students`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body,
    });
    const out = (await res.json()) as { data: unknown[] };
    expect(out.data).toHaveLength(2);
  });

  it("rejects a non-owner (403)", async () => {
    const owner = await seedUserAndCookie({ githubId: 3, login: "owner" });
    const stranger = await seedUserAndCookie({ githubId: 4, login: "stranger" });
    const classroom = await makeClassroom(owner.user.id);

    const res = await SELF.fetch(`https://example.com/api/classrooms/${classroom.id}/students`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: stranger.cookie },
      body: JSON.stringify({ identifiers: ["x"] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request (401)", async () => {
    const { user } = await seedUserAndCookie({ githubId: 5, login: "owner2" });
    const classroom = await makeClassroom(user.id);
    const res = await SELF.fetch(`https://example.com/api/classrooms/${classroom.id}/students`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifiers: ["x"] }),
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:integration test/integration/students-api.test.ts`
Expected: FAIL — the `/students` route 404s (endpoint not created yet). (`yarn test:integration` runs `yarn build` first, so the new route gets compiled into the worker.)

- [ ] **Step 3: Implement `db/students.ts`**

Create `src/lib/db/students.ts`:

```typescript
import type { D1Database } from "@cloudflare/workers-types";
import { ConflictError } from "../http/errors";

export interface Student {
  id: string;
  classroomId: string;
  rosterIdentifier: string | null;
  githubUsername: string | null;
  userId: string | null;
  createdAt: string;
}

interface StudentRow {
  id: string;
  classroom_id: string;
  roster_identifier: string | null;
  github_username: string | null;
  user_id: string | null;
  created_at: string;
}

function toStudent(row: StudentRow): Student {
  return {
    id: row.id,
    classroomId: row.classroom_id,
    rosterIdentifier: row.roster_identifier,
    githubUsername: row.github_username,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

export async function listStudentsByClassroom(db: D1Database, classroomId: string): Promise<Student[]> {
  const { results } = await db
    .prepare("SELECT * FROM students WHERE classroom_id = ?1 ORDER BY created_at ASC")
    .bind(classroomId)
    .all<StudentRow>();
  return results.map(toStudent);
}

export async function listUnclaimedStudents(
  db: D1Database,
  classroomId: string,
): Promise<{ id: string; rosterIdentifier: string | null }[]> {
  const { results } = await db
    .prepare(
      "SELECT id, roster_identifier FROM students WHERE classroom_id = ?1 AND user_id IS NULL ORDER BY roster_identifier ASC",
    )
    .bind(classroomId)
    .all<{ id: string; roster_identifier: string | null }>();
  return results.map((r) => ({ id: r.id, rosterIdentifier: r.roster_identifier }));
}

export async function seedStudents(
  db: D1Database,
  classroomId: string,
  identifiers: string[],
): Promise<Student[]> {
  // Dedupe within the request, then skip identifiers that already exist in this classroom.
  const unique = [...new Set(identifiers)];
  const { results: existingRows } = await db
    .prepare(
      "SELECT roster_identifier FROM students WHERE classroom_id = ?1 AND roster_identifier IS NOT NULL",
    )
    .bind(classroomId)
    .all<{ roster_identifier: string }>();
  const existing = new Set(existingRows.map((r) => r.roster_identifier));
  const toInsert = unique.filter((id) => !existing.has(id));

  if (toInsert.length > 0) {
    await db.batch(
      toInsert.map((identifier) =>
        db
          .prepare("INSERT INTO students (id, classroom_id, roster_identifier) VALUES (?1, ?2, ?3)")
          .bind(crypto.randomUUID(), classroomId, identifier),
      ),
    );
  }

  return listStudentsByClassroom(db, classroomId);
}

export async function findStudentByUser(
  db: D1Database,
  classroomId: string,
  userId: string,
): Promise<Student | null> {
  const row = await db
    .prepare("SELECT * FROM students WHERE classroom_id = ?1 AND user_id = ?2")
    .bind(classroomId, userId)
    .first<StudentRow>();
  return row ? toStudent(row) : null;
}

export async function claimStudent(
  db: D1Database,
  studentId: string,
  classroomId: string,
  userId: string,
  githubUsername: string,
): Promise<Student> {
  // Guarded UPDATE: only succeeds when the row is in this classroom AND still unclaimed.
  // Races and a "claim a second row" attempt both resolve here, not via check-then-write.
  let row: StudentRow | null;
  try {
    row = await db
      .prepare(
        `UPDATE students
            SET user_id = ?3, github_username = ?4
          WHERE id = ?1 AND classroom_id = ?2 AND user_id IS NULL
        RETURNING *`,
      )
      .bind(studentId, classroomId, userId, githubUsername)
      .first<StudentRow>();
  } catch (err) {
    // Unique (classroom_id, user_id): this account already claimed another row.
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new ConflictError("You have already claimed a roster entry in this classroom");
    }
    throw err;
  }
  if (!row) throw new ConflictError("This roster entry has already been claimed");
  return toStudent(row);
}

export async function createStudent(
  db: D1Database,
  input: { classroomId: string; userId: string; githubUsername: string },
): Promise<Student> {
  try {
    const row = await db
      .prepare(
        `INSERT INTO students (id, classroom_id, user_id, github_username)
         VALUES (?1, ?2, ?3, ?4)
       RETURNING *`,
      )
      .bind(crypto.randomUUID(), input.classroomId, input.userId, input.githubUsername)
      .first<StudentRow>();
    if (!row) throw new Error("createStudent: INSERT ... RETURNING produced no row");
    return toStudent(row);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new ConflictError("You are already enrolled in this classroom");
    }
    throw err;
  }
}
```

- [ ] **Step 4: Implement the endpoints**

Create `src/pages/api/classrooms/[id]/students.ts`:

```typescript
import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { listStudentsByClassroom, seedStudents } from "../../../../lib/db/students";
import { assertOwnsClassroom } from "../../../../lib/domain/authz";
import { toResponse } from "../../../../lib/http/errors";
import { error, json } from "../../../../lib/http/json";
import { seedRosterSchema } from "../../../../lib/http/schemas";
import { parseBody } from "../../../../lib/http/validation";

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const classroom = await assertOwnsClassroom(env.DB, params.id!, session.userId);
    const body = await parseBody(request, seedRosterSchema);
    const students = await seedStudents(env.DB, classroom.id, body.identifiers);
    return json(students, 201);
  } catch (err) {
    return toResponse(err);
  }
};

export const GET: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const classroom = await assertOwnsClassroom(env.DB, params.id!, session.userId);
    const students = await listStudentsByClassroom(env.DB, classroom.id);
    return json(students, 200);
  } catch (err) {
    return toResponse(err);
  }
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test:integration test/integration/students-api.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/students.ts src/pages/api/classrooms/\[id\]/students.ts test/integration/students-api.test.ts
git commit -m "feat: add roster seed/list endpoints + db/students"
```

---

## Task 7: `GET /api/assignments/:id/roster` — unclaimed options

**Files:**
- Create: `src/pages/api/assignments/[id]/roster.ts`
- Test: `test/integration/roster-api.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/roster-api.test.ts`:

```typescript
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { seedStudents } from "../../src/lib/db/students";
import { seedUserAndCookie } from "./helpers";

describe("GET /api/assignments/:id/roster", () => {
  it("returns unclaimed roster options to any authenticated user", async () => {
    const teacher = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "test-org",
      timezone: "UTC",
      createdBy: teacher.user.id,
    });
    await seedStudents(env.DB, classroom.id, ["alice", "bob"]);
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "HW 1",
      templateRepo: "test-org/hw1-template",
      deadlineAt: undefined,
      graceMinutes: 0,
    });

    const student = await seedUserAndCookie({ githubId: 2, login: "student" });
    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/roster`, {
      headers: { cookie: student.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { options: Array<{ id: string; rosterIdentifier: string }> } };
    expect(body.data.options.map((o) => o.rosterIdentifier).sort()).toEqual(["alice", "bob"]);
  });

  it("404s for an unknown assignment", async () => {
    const { cookie } = await seedUserAndCookie({ githubId: 3, login: "x" });
    const res = await SELF.fetch(
      "https://example.com/api/assignments/11111111-1111-4111-8111-111111111111/roster",
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });

  it("401s when unauthenticated", async () => {
    const res = await SELF.fetch(
      "https://example.com/api/assignments/11111111-1111-4111-8111-111111111111/roster",
    );
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:integration test/integration/roster-api.test.ts`
Expected: FAIL — `/roster` route 404s for the seeded assignment too (endpoint not created).

- [ ] **Step 3: Implement the endpoint**

Create `src/pages/api/assignments/[id]/roster.ts`:

```typescript
import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { getAssignmentById } from "../../../../lib/db/assignments";
import { listUnclaimedStudents } from "../../../../lib/db/students";
import { NotFoundError, toResponse } from "../../../../lib/http/errors";
import { error, json } from "../../../../lib/http/json";

export const GET: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    const options = await listUnclaimedStudents(env.DB, assignment.classroomId);
    return json({ options }, 200);
  } catch (err) {
    return toResponse(err);
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:integration test/integration/roster-api.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/assignments/\[id\]/roster.ts test/integration/roster-api.test.ts
git commit -m "feat: add GET assignments/:id/roster (unclaimed options)"
```

---

## Task 8: `domain/enrollment.ts` — `resolveStudentForAccept`

**Files:**
- Create: `src/lib/domain/enrollment.ts`
- Test: `test/unit/enrollment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/enrollment.test.ts` (uses `vi.mock` to stub the db layer so the orchestration is testable without D1):

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/db/students", () => ({
  findStudentByUser: vi.fn(),
  claimStudent: vi.fn(),
  createStudent: vi.fn(),
}));

import { claimStudent, createStudent, findStudentByUser } from "../../src/lib/db/students";
import { resolveStudentForAccept } from "../../src/lib/domain/enrollment";

const db = {} as never; // never touched: the db functions are mocked

beforeEach(() => {
  vi.mocked(findStudentByUser).mockReset();
  vi.mocked(claimStudent).mockReset();
  vi.mocked(createStudent).mockReset();
});

describe("resolveStudentForAccept", () => {
  it("reuses an existing student linked by user_id", async () => {
    const existing = { id: "s1" } as never;
    vi.mocked(findStudentByUser).mockResolvedValue(existing);

    const result = await resolveStudentForAccept(db, {
      classroomId: "c1",
      userId: "u1",
      githubUsername: "octocat",
      rosterStudentId: "r1",
    });

    expect(result).toBe(existing);
    expect(claimStudent).not.toHaveBeenCalled();
    expect(createStudent).not.toHaveBeenCalled();
  });

  it("claims the chosen roster row when none exists and rosterStudentId is given", async () => {
    vi.mocked(findStudentByUser).mockResolvedValue(null);
    const claimed = { id: "s2" } as never;
    vi.mocked(claimStudent).mockResolvedValue(claimed);

    const result = await resolveStudentForAccept(db, {
      classroomId: "c1",
      userId: "u1",
      githubUsername: "octocat",
      rosterStudentId: "r1",
    });

    expect(result).toBe(claimed);
    expect(claimStudent).toHaveBeenCalledWith(db, "r1", "c1", "u1", "octocat");
    expect(createStudent).not.toHaveBeenCalled();
  });

  it("creates a fresh student (skip path) when none exists and no rosterStudentId", async () => {
    vi.mocked(findStudentByUser).mockResolvedValue(null);
    const created = { id: "s3" } as never;
    vi.mocked(createStudent).mockResolvedValue(created);

    const result = await resolveStudentForAccept(db, {
      classroomId: "c1",
      userId: "u1",
      githubUsername: "octocat",
    });

    expect(result).toBe(created);
    expect(createStudent).toHaveBeenCalledWith(db, {
      classroomId: "c1",
      userId: "u1",
      githubUsername: "octocat",
    });
    expect(claimStudent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run -c vitest.unit.config.ts test/unit/enrollment.test.ts`
Expected: FAIL — `src/lib/domain/enrollment.ts` does not exist.

- [ ] **Step 3: Implement `resolveStudentForAccept`**

Create `src/lib/domain/enrollment.ts`:

```typescript
import type { D1Database } from "@cloudflare/workers-types";
import { claimStudent, createStudent, findStudentByUser, type Student } from "../db/students";

export async function resolveStudentForAccept(
  db: D1Database,
  input: { classroomId: string; userId: string; githubUsername: string; rosterStudentId?: string },
): Promise<Student> {
  const { classroomId, userId, githubUsername, rosterStudentId } = input;

  // Already enrolled (stable user_id link) → reuse, regardless of any roster selection.
  const existing = await findStudentByUser(db, classroomId, userId);
  if (existing) return existing;

  // Claiming a teacher-seeded row, or the skip path (fresh bare row).
  if (rosterStudentId) {
    return claimStudent(db, rosterStudentId, classroomId, userId, githubUsername);
  }
  return createStudent(db, { classroomId, userId, githubUsername });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run -c vitest.unit.config.ts test/unit/enrollment.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/enrollment.ts test/unit/enrollment.test.ts
git commit -m "feat: add resolveStudentForAccept enrollment orchestration"
```

---

## Task 9: Integration GitHub-mock harness + `db/repos.ts` + `accept` endpoint

This is the central task. It (a) wires up a real test signing key + `fetchMock` helpers, (b) adds the `splitRepo`/`repoUrlFor` slug helpers, (c) adds `db/repos.ts`, and (d) adds the accept endpoint, all driven by the accept integration tests.

**Files:**
- Modify: `vitest.integration.config.ts`
- Create: `test/integration/github-mock.ts`
- Modify: `src/lib/domain/slug.ts`
- Create: `src/lib/db/repos.ts`
- Create: `src/pages/api/assignments/[id]/accept.ts`
- Test: `test/integration/accept-api.test.ts`

- [ ] **Step 1: Generate a throwaway PKCS#8 RSA key for the test bindings**

Run: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`
Expected: a `-----BEGIN PRIVATE KEY-----` … `-----END PRIVATE KEY-----` block (PKCS#8, unencrypted). Copy the full block for the next step. This key is test-only (it never authenticates against real GitHub — the token mint is mocked) so committing it is acceptable.

- [ ] **Step 2: Add the test key to the integration bindings**

In `vitest.integration.config.ts`, replace the existing `GITHUB_APP_PRIVATE_KEY` binding value with the generated PEM using a template literal. The binding currently reads `GITHUB_APP_PRIVATE_KEY: "unused-in-integration-tests"`; change it to:

```typescript
        GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ...   // ← paste the full key body
...AAAA==
-----END PRIVATE KEY-----`,
```

(Keep all other bindings — `GITHUB_APP_ID: "12345"`, `GITHUB_APP_INSTALLATION_ID: "67890"`, etc. — unchanged. The mint path uses installation id `67890`.)

- [ ] **Step 3: Create the `fetchMock` helper module**

Create `test/integration/github-mock.ts`:

```typescript
import { fetchMock } from "cloudflare:test";

const GITHUB_API = "https://api.github.com";

/** Intercept the installation-token mint (real JWT is built, but the POST is faked). */
export function mockInstallationToken(): void {
  fetchMock
    .get(GITHUB_API)
    .intercept({ path: "/app/installations/67890/access_tokens", method: "POST" })
    .reply(201, { token: "ghs_test_token", expires_at: "2099-01-01T00:00:00Z" });
}

export function mockGenerateRepo(input: {
  templateOwner: string;
  templateRepo: string;
  owner: string;
  name: string;
  repoId?: number;
}): void {
  const { templateOwner, templateRepo, owner, name, repoId = 100 } = input;
  fetchMock
    .get(GITHUB_API)
    .intercept({ path: `/repos/${templateOwner}/${templateRepo}/generate`, method: "POST" })
    .reply(201, {
      id: repoId,
      full_name: `${owner}/${name}`,
      html_url: `https://github.com/${owner}/${name}`,
    });
}

/** Collaborator PUT → 201 (invited) with an invitation url. */
export function mockAddCollaboratorInvited(input: { owner: string; name: string; username: string }): void {
  const { owner, name, username } = input;
  fetchMock
    .get(GITHUB_API)
    .intercept({ path: `/repos/${owner}/${name}/collaborators/${username}`, method: "PUT" })
    .reply(201, { html_url: `https://github.com/${owner}/${name}/invitations` });
}

/** Collaborator PUT → 204 (already a member). */
export function mockAddCollaboratorAlreadyMember(input: {
  owner: string;
  name: string;
  username: string;
}): void {
  const { owner, name, username } = input;
  fetchMock
    .get(GITHUB_API)
    .intercept({ path: `/repos/${owner}/${name}/collaborators/${username}`, method: "PUT" })
    .reply(204, "");
}
```

- [ ] **Step 4: Add `splitRepo` + `repoUrlFor` to `slug.ts`**

Append to `src/lib/domain/slug.ts`:

```typescript
/** Split an "owner/name" repo reference into its two parts. */
export function splitRepo(fullName: string): [owner: string, repo: string] {
  const slash = fullName.indexOf("/");
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}

/** Construct a github.com html url for a repo we own. */
export function repoUrlFor(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}
```

- [ ] **Step 5: Implement `db/repos.ts`**

Create `src/lib/db/repos.ts`:

```typescript
import type { D1Database } from "@cloudflare/workers-types";

export interface Repo {
  id: string;
  assignmentId: string;
  studentId: string;
  repoName: string;
  repoId: number | null;
  acceptedAt: string | null;
  permissionSyncedAt: string | null;
}

interface RepoRow {
  id: string;
  assignment_id: string;
  student_id: string;
  repo_name: string;
  repo_id: number | null;
  accepted_at: string | null;
  permission_synced_at: string | null;
}

function toRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    studentId: row.student_id,
    repoName: row.repo_name,
    repoId: row.repo_id,
    acceptedAt: row.accepted_at,
    permissionSyncedAt: row.permission_synced_at,
  };
}

export async function getRepoByAssignmentStudent(
  db: D1Database,
  assignmentId: string,
  studentId: string,
): Promise<Repo | null> {
  const row = await db
    .prepare("SELECT * FROM repos WHERE assignment_id = ?1 AND student_id = ?2")
    .bind(assignmentId, studentId)
    .first<RepoRow>();
  return row ? toRepo(row) : null;
}

export async function recordRepo(
  db: D1Database,
  input: { assignmentId: string; studentId: string; repoName: string; repoId: number },
): Promise<Repo> {
  const row = await db
    .prepare(
      `INSERT INTO repos (id, assignment_id, student_id, repo_name, repo_id, accepted_at, permission_synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))
     RETURNING *`,
    )
    .bind(crypto.randomUUID(), input.assignmentId, input.studentId, input.repoName, input.repoId)
    .first<RepoRow>();
  if (!row) throw new Error("recordRepo: INSERT ... RETURNING produced no row");
  return toRepo(row);
}

export async function touchPermissionSynced(db: D1Database, repoRowId: string): Promise<void> {
  await db
    .prepare("UPDATE repos SET permission_synced_at = datetime('now') WHERE id = ?1")
    .bind(repoRowId)
    .run();
}
```

- [ ] **Step 6: Write the failing accept integration test**

Create `test/integration/accept-api.test.ts`:

```typescript
import { SELF, env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearInstallationTokenCache } from "../../src/lib/github/app";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { getRepoByAssignmentStudent } from "../../src/lib/db/repos";
import { listStudentsByClassroom, seedStudents } from "../../src/lib/db/students";
import { seedUserAndCookie } from "./helpers";
import {
  mockAddCollaboratorInvited,
  mockGenerateRepo,
  mockInstallationToken,
} from "./github-mock";

beforeAll(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(() => clearInstallationTokenCache());

async function setup(opts: { githubId: number; login: string; seed?: string[] }) {
  const teacher = await seedUserAndCookie({ githubId: opts.githubId, login: `teacher-${opts.login}` });
  const classroom = await createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "test-org",
    timezone: "UTC",
    createdBy: teacher.user.id,
  });
  if (opts.seed) await seedStudents(env.DB, classroom.id, opts.seed);
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id,
    slug: "hw1",
    title: "HW 1",
    templateRepo: "test-org/hw1-template",
    deadlineAt: undefined,
    graceMinutes: 0,
  });
  return { classroom, assignment };
}

describe("POST /api/assignments/:id/accept", () => {
  it("claim path: links the chosen roster row, creates repo + collaborator, records repo", async () => {
    const { classroom, assignment } = await setup({ githubId: 10, login: "claim", seed: ["alice"] });
    const student = await seedUserAndCookie({ githubId: 11, login: "octocat" });
    const options = await listStudentsByClassroom(env.DB, classroom.id);
    const rosterStudentId = options[0].id;

    mockInstallationToken();
    mockGenerateRepo({
      templateOwner: "test-org",
      templateRepo: "hw1-template",
      owner: "test-org",
      name: "hw1-octocat",
    });
    mockAddCollaboratorInvited({ owner: "test-org", name: "hw1-octocat", username: "octocat" });

    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: student.cookie },
      body: JSON.stringify({ rosterStudentId }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { repoUrl: string; invitationUrl?: string; status: string } };
    expect(body.data.repoUrl).toBe("https://github.com/test-org/hw1-octocat");
    expect(body.data.invitationUrl).toBe("https://github.com/test-org/hw1-octocat/invitations");
    expect(body.data.status).toBe("invited");

    // The roster row is now linked to the student's stable identity.
    const linked = (await listStudentsByClassroom(env.DB, classroom.id))[0];
    expect(linked.id).toBe(rosterStudentId);
    expect(linked.userId).toBe(student.user.id);
    expect(linked.githubUsername).toBe("octocat");

    // A repos row exists.
    const repo = await getRepoByAssignmentStudent(env.DB, assignment.id, rosterStudentId);
    expect(repo?.repoName).toBe("hw1-octocat");
  });

  it("skip path: creates a fresh student row when no rosterStudentId is given", async () => {
    const { classroom, assignment } = await setup({ githubId: 20, login: "skip" });
    const student = await seedUserAndCookie({ githubId: 21, login: "skipper" });

    mockInstallationToken();
    mockGenerateRepo({
      templateOwner: "test-org",
      templateRepo: "hw1-template",
      owner: "test-org",
      name: "hw1-skipper",
    });
    mockAddCollaboratorInvited({ owner: "test-org", name: "hw1-skipper", username: "skipper" });

    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: student.cookie },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    const roster = await listStudentsByClassroom(env.DB, classroom.id);
    expect(roster).toHaveLength(1);
    expect(roster[0].userId).toBe(student.user.id);
    expect(roster[0].rosterIdentifier).toBeNull();
  });

  it("idempotent: a second accept returns the existing repo with no GitHub calls and no duplicate row", async () => {
    const { classroom, assignment } = await setup({ githubId: 30, login: "idem" });
    const student = await seedUserAndCookie({ githubId: 31, login: "twice" });

    mockInstallationToken();
    mockGenerateRepo({
      templateOwner: "test-org",
      templateRepo: "hw1-template",
      owner: "test-org",
      name: "hw1-twice",
    });
    mockAddCollaboratorInvited({ owner: "test-org", name: "hw1-twice", username: "twice" });

    const first = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: student.cookie },
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(201);

    // No new interceptors registered → the second accept must not call GitHub at all.
    const second = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: student.cookie },
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(201);
    const body = (await second.json()) as { data: { repoUrl: string; status: string } };
    expect(body.data.repoUrl).toBe("https://github.com/test-org/hw1-twice");
    expect(body.data.status).toBe("already_accepted");

    const roster = await listStudentsByClassroom(env.DB, classroom.id);
    expect(roster).toHaveLength(1);
  });

  it("claim-already-claimed → 409", async () => {
    const { classroom, assignment } = await setup({ githubId: 40, login: "conflict", seed: ["dupe"] });
    const rosterStudentId = (await listStudentsByClassroom(env.DB, classroom.id))[0].id;

    // First student claims it.
    const first = await seedUserAndCookie({ githubId: 41, login: "first" });
    mockInstallationToken();
    mockGenerateRepo({
      templateOwner: "test-org",
      templateRepo: "hw1-template",
      owner: "test-org",
      name: "hw1-first",
    });
    mockAddCollaboratorInvited({ owner: "test-org", name: "hw1-first", username: "first" });
    const claimRes = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: first.cookie },
      body: JSON.stringify({ rosterStudentId }),
    });
    expect(claimRes.status).toBe(201);

    // Second student tries to claim the same row → 409, no GitHub calls.
    const second = await seedUserAndCookie({ githubId: 42, login: "second" });
    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: second.cookie },
      body: JSON.stringify({ rosterStudentId }),
    });
    expect(res.status).toBe(409);
  });

  it("401s when unauthenticated", async () => {
    const { assignment } = await setup({ githubId: 50, login: "unauth" });
    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `yarn test:integration test/integration/accept-api.test.ts`
Expected: FAIL — `/accept` route 404s (endpoint not created).

- [ ] **Step 8: Implement the accept endpoint**

Create `src/pages/api/assignments/[id]/accept.ts`:

```typescript
import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { getAssignmentById } from "../../../../lib/db/assignments";
import { getClassroomById } from "../../../../lib/db/classrooms";
import { getRepoByAssignmentStudent, recordRepo } from "../../../../lib/db/repos";
import { resolveStudentForAccept } from "../../../../lib/domain/enrollment";
import { repoNameFor, repoUrlFor, splitRepo } from "../../../../lib/domain/slug";
import { getInstallationToken } from "../../../../lib/github/app";
import { addCollaborator, createRepoFromTemplate } from "../../../../lib/github/repos";
import { NotFoundError, toResponse } from "../../../../lib/http/errors";
import { error, json } from "../../../../lib/http/json";
import { acceptAssignmentSchema } from "../../../../lib/http/schemas";
import { parseBody } from "../../../../lib/http/validation";

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const body = await parseBody(request, acceptAssignmentSchema);

    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    const classroom = await getClassroomById(env.DB, assignment.classroomId);
    if (!classroom) throw new NotFoundError("Classroom not found");

    const student = await resolveStudentForAccept(env.DB, {
      classroomId: assignment.classroomId,
      userId: session.userId,
      githubUsername: session.githubUsername,
      rosterStudentId: body.rosterStudentId,
    });

    // Idempotency: if a repo already exists for (assignment, student), accept is already done.
    const existing = await getRepoByAssignmentStudent(env.DB, assignment.id, student.id);
    if (existing) {
      return json(
        { repoUrl: repoUrlFor(classroom.githubOrg, existing.repoName), status: "already_accepted" },
        201,
      );
    }

    const token = await getInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });

    const [templateOwner, templateRepo] = splitRepo(assignment.templateRepo);
    const repoName = repoNameFor(assignment.slug, session.githubUsername);

    const created = await createRepoFromTemplate({
      token,
      templateOwner,
      templateRepo,
      owner: classroom.githubOrg,
      name: repoName,
      isPrivate: true,
    });

    const collab = await addCollaborator({
      token,
      owner: classroom.githubOrg,
      repo: repoName,
      username: session.githubUsername,
      permission: "push",
    });

    await recordRepo(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      repoName,
      repoId: created.repoId,
    });

    return json(
      { repoUrl: created.htmlUrl, invitationUrl: collab.invitationUrl, status: collab.status },
      201,
    );
  } catch (err) {
    return toResponse(err);
  }
};
```

- [ ] **Step 9: Run test to verify it passes**

Run: `yarn test:integration test/integration/accept-api.test.ts`
Expected: PASS (all five cases). If `fetchMock.assertNoPendingInterceptors()` fails on the idempotent test, that confirms a GitHub call was made on the second accept — the idempotency short-circuit must run before `getInstallationToken`.

- [ ] **Step 10: Commit**

```bash
git add vitest.integration.config.ts test/integration/github-mock.ts src/lib/domain/slug.ts src/lib/db/repos.ts src/pages/api/assignments/\[id\]/accept.ts test/integration/accept-api.test.ts
git commit -m "feat: add assignment accept endpoint + repos db + github mock harness"
```

---

## Task 10: `POST /api/assignments/:id/resync` — re-issue collaborator invite

**Files:**
- Create: `src/pages/api/assignments/[id]/resync.ts`
- Test: `test/integration/resync-api.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/resync-api.test.ts`:

```typescript
import { SELF, env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearInstallationTokenCache } from "../../src/lib/github/app";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { getRepoByAssignmentStudent } from "../../src/lib/db/repos";
import { listStudentsByClassroom } from "../../src/lib/db/students";
import { seedUserAndCookie } from "./helpers";
import {
  mockAddCollaboratorAlreadyMember,
  mockAddCollaboratorInvited,
  mockGenerateRepo,
  mockInstallationToken,
} from "./github-mock";

beforeAll(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(() => clearInstallationTokenCache());

async function setupAccepted(opts: { githubId: number; login: string }) {
  const teacher = await seedUserAndCookie({ githubId: opts.githubId, login: `teacher-${opts.login}` });
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
    deadlineAt: undefined,
    graceMinutes: 0,
  });
  const student = await seedUserAndCookie({ githubId: opts.githubId + 1, login: opts.login });
  // Accept first so a repos row exists.
  mockInstallationToken();
  mockGenerateRepo({
    templateOwner: "test-org",
    templateRepo: "hw1-template",
    owner: "test-org",
    name: `hw1-${opts.login}`,
  });
  mockAddCollaboratorInvited({ owner: "test-org", name: `hw1-${opts.login}`, username: opts.login });
  await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: student.cookie },
    body: JSON.stringify({}),
  });
  clearInstallationTokenCache();
  return { classroom, assignment, student };
}

describe("POST /api/assignments/:id/resync", () => {
  it("re-issues the invite (201 → invited) and bumps permission_synced_at", async () => {
    const { classroom, assignment, student } = await setupAccepted({ githubId: 60, login: "resync1" });
    const studentRow = (await listStudentsByClassroom(env.DB, classroom.id))[0];
    const before = await getRepoByAssignmentStudent(env.DB, assignment.id, studentRow.id);

    mockInstallationToken();
    mockAddCollaboratorInvited({ owner: "test-org", name: "hw1-resync1", username: "resync1" });

    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/resync`, {
      method: "POST",
      headers: { cookie: student.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; invitationUrl?: string } };
    expect(body.data.status).toBe("invited");
    expect(body.data.invitationUrl).toBe("https://github.com/test-org/hw1-resync1/invitations");

    const after = await getRepoByAssignmentStudent(env.DB, assignment.id, studentRow.id);
    expect(after?.permissionSyncedAt).not.toBe(before?.permissionSyncedAt);
  });

  it("returns already_member (204 → 200) when access already exists", async () => {
    const { assignment, student } = await setupAccepted({ githubId: 70, login: "resync2" });

    mockInstallationToken();
    mockAddCollaboratorAlreadyMember({ owner: "test-org", name: "hw1-resync2", username: "resync2" });

    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/resync`, {
      method: "POST",
      headers: { cookie: student.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; invitationUrl?: string } };
    expect(body.data.status).toBe("already_member");
    expect(body.data.invitationUrl).toBeUndefined();
  });

  it("404s when the student never accepted (no repo row)", async () => {
    const teacher = await seedUserAndCookie({ githubId: 80, login: "teacher-noaccept" });
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
      deadlineAt: undefined,
      graceMinutes: 0,
    });
    const student = await seedUserAndCookie({ githubId: 81, login: "noaccept" });

    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/resync`, {
      method: "POST",
      headers: { cookie: student.cookie },
    });
    expect(res.status).toBe(404);
  });

  it("401s when unauthenticated", async () => {
    const res = await SELF.fetch(
      "https://example.com/api/assignments/11111111-1111-4111-8111-111111111111/resync",
      { method: "POST" },
    );
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:integration test/integration/resync-api.test.ts`
Expected: FAIL — `/resync` route 404s (endpoint not created).

- [ ] **Step 3: Implement the resync endpoint**

Create `src/pages/api/assignments/[id]/resync.ts`:

```typescript
import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { getAssignmentById } from "../../../../lib/db/assignments";
import { getClassroomById } from "../../../../lib/db/classrooms";
import { getRepoByAssignmentStudent, touchPermissionSynced } from "../../../../lib/db/repos";
import { findStudentByUser } from "../../../../lib/db/students";
import { getInstallationToken } from "../../../../lib/github/app";
import { addCollaborator } from "../../../../lib/github/repos";
import { NotFoundError, toResponse } from "../../../../lib/http/errors";
import { error, json } from "../../../../lib/http/json";

export const POST: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    const classroom = await getClassroomById(env.DB, assignment.classroomId);
    if (!classroom) throw new NotFoundError("Classroom not found");

    const student = await findStudentByUser(env.DB, assignment.classroomId, session.userId);
    if (!student) throw new NotFoundError("You are not enrolled in this classroom");

    const repo = await getRepoByAssignmentStudent(env.DB, assignment.id, student.id);
    if (!repo) throw new NotFoundError("Accept the assignment first");

    const token = await getInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });

    const collab = await addCollaborator({
      token,
      owner: classroom.githubOrg,
      repo: repo.repoName,
      username: session.githubUsername,
      permission: "push",
    });

    await touchPermissionSynced(env.DB, repo.id);

    return json({ status: collab.status, invitationUrl: collab.invitationUrl }, 200);
  } catch (err) {
    return toResponse(err);
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:integration test/integration/resync-api.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/assignments/\[id\]/resync.ts test/integration/resync-api.test.ts
git commit -m "feat: add assignment resync endpoint (idempotent invite re-issue)"
```

---

## Task 11: Full-suite green + lint

**Files:** none (verification only)

- [ ] **Step 1: Run the unit suite**

Run: `yarn test:unit`
Expected: PASS — all unit files including the four new Phase 2 ones.

- [ ] **Step 2: Run the integration suite**

Run: `yarn test:integration`
Expected: PASS — students, roster, accept, resync, plus all pre-existing integration tests. (Note the known-local-only failure: the `DEBUG_ROUTES` index-page 404 test fails locally because `.dev.vars` sets `DEBUG_ROUTES=1`; this is environmental, not a regression — see the project memory note. All other tests must pass.)

- [ ] **Step 3: Lint / typecheck (whatever the repo defines)**

Run: `yarn lint` (and/or `yarn astro check` if defined in `package.json`)
Expected: no new errors. Fix any type errors surfaced in the new files before finishing.

- [ ] **Step 4: Final verification commit (only if Step 3 required fixes)**

```bash
git add -A
git commit -m "chore: phase 2 lint/typecheck fixes"
```

---

## Self-Review (spec coverage)

- **§3 schema** → Task 1 (migration `0003`, `user_id` + unique index).
- **§5 `github/repos.ts`** → Tasks 4–5 (`createRepoFromTemplate` + 422 recovery; `addCollaborator` 201/204).
- **§5 `db/students.ts`** → Task 6 (seed/list/findByUser/claim/create; idempotent seed per Decision 3).
- **§5 `db/repos.ts`** → Task 9 (get/record/touch).
- **§5 `domain/enrollment.ts`** → Task 8 (`resolveStudentForAccept` reuse/claim/create).
- **§5 endpoints** → seed/list (Task 6), roster (Task 7), accept (Task 9), resync (Task 10).
- **§6 accept data flow** (401 → load assignment/classroom → resolve → idempotency → generate → collaborator → record → 201) → Task 9 endpoint, in that order.
- **§6 resync data flow** (401 → load → findByUser 404 → repo 404 → addCollaborator → touch → 200) → Task 10 endpoint, in that order.
- **§7 error handling** (`GitHubApiError → 502`; idempotent retry safety; guarded-UPDATE claim race) → Task 2 (502 mapping), Task 9 (idempotency short-circuit + 422 recovery), Task 6 (`claimStudent` guarded UPDATE).
- **§8 security** (roster visible to any authed; accept/resync act on session identity only) → Tasks 7/9/10 use `session.userId`/`session.githubUsername`, never a caller-supplied identity.
- **§9 testing** (unit: repos shapes + 422; schemas; enrollment branches — integration: seed/roster/accept-claim/accept-skip/idempotent/409/resync 201+204+404/401) → every listed case is present across Tasks 2–10.
- **§10 open items** → resolved in the Planning Decisions section (fetchMock + real test key; 422-on-status recovery; idempotent seeding; capture `html_url`; `repoUrl` from `html_url`/constructed fallback).
