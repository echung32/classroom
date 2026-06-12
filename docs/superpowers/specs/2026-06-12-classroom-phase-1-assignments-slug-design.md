# Classroom Clone — Phase 1 (Assignments + Slug) Design

**Status:** Approved design, ready for implementation planning
**Date:** 2026-06-12
**Scope:** Phase 1 only, of the larger [classroom-clone build plan](../../plan/classroom-clone-build-plan.md). Builds directly on the merged [Phase 0 skeleton](2026-06-12-classroom-phase-0-skeleton-design.md).

---

## 1. Purpose & Exit Gate

Phase 1 adds the first authenticated **write** surface: teachers create classrooms and assignments. It establishes the slug naming system that every later bulk operation depends on, and the repo-name helper that Phase 2 (acceptance) will use to create student repos.

**Phase 1 is done when:**
- An authenticated user can create a classroom (they become its owner) and create an assignment within it, both persisted to D1.
- Slug rules are enforced: url-safe charset and per-classroom uniqueness (`409` on conflict).
- The `{slug}-{username}` repo-name pattern is computable and unit-tested.
- Owner-scoped authorization is enforced on all classroom/assignment endpoints.
- Unit tests (pure logic) and integration tests (Worker boundary + D1) are green.

**Explicitly out of scope (deferred):**
- **No GitHub API calls.** `template_repo` is shape-validated only — its existence on GitHub is *not* checked. Repo creation, collaborators, and template verification all begin in Phase 2.
- **No UI.** All teacher/student views are Phase 6, built with shadcn (see §9). Phase 1 ships JSON API endpoints only.
- No roster/students, acceptance, deadlines, queues, or grader builder.

---

## 2. Settled Decisions

Decided during brainstorming. Do not reintroduce alternatives without flagging.

| Decision | Choice | Rationale |
| --- | --- | --- |
| Phase scope | **Backend only**, UI deferred to Phase 6 | Keeps the phase focused and faithful to the build plan. |
| Authorization | **Owner-scoped** — add `created_by` to `classrooms`; only the owner can read/write its assignments | Prevents an any-user free-for-all without building full roles/teams. |
| Validation | **Valibot** schemas for request bodies + slug | Schema ergonomics with a much smaller bundle than Zod; acceptable as the first runtime dep in this layer. |
| Repo-name casing | `repoNameFor` **lowercases the username** | GitHub usernames are case-insensitive; lowercasing yields a deterministic repo name. |
| GitHub interaction | **None in Phase 1** | `template_repo` validated as `owner/name` shape only; existence checks move to Phase 2. *(Confirmed: Phase 0 implemented only OAuth login; no other GitHub work exists yet.)* |

---

## 3. Schema Change (migration `0002_classroom_owner.sql`)

```sql
ALTER TABLE classrooms ADD COLUMN created_by TEXT REFERENCES users(id);
```

- Nullable at the DB level — SQLite cannot add a `NOT NULL` column without a default — but the application **always** sets it on insert.
- No backfill: no classrooms exist yet (Phase 0 only wrote `users`).
- The existing `migrations/0001_init.sql` already created `classrooms`, `assignments`, `students`, `repos`, `submissions`; Phase 1 only adds this column and exercises `classrooms` + `assignments`.

---

## 4. Architecture

All logic stays in framework-agnostic `src/lib/*` modules following the Phase 0 patterns (typed D1 row-mappers with `?n` bindings and `RETURNING *`, `getEnv()` for bindings, pure domain modules). Astro `src/pages/api/*` endpoints are thin adapters: authenticate → authorize → validate → call domain/DB → shape JSON.

```
src/
├─ pages/api/
│  ├─ classrooms/
│  │  ├─ index.ts                 # POST  /api/classrooms
│  │  ├─ [id].ts                  # GET   /api/classrooms/:id  (detail + assignments)
│  │  └─ [id]/assignments.ts      # POST  /api/classrooms/:id/assignments
│  └─ assignments/
│     └─ [id].ts                  # GET   /api/assignments/:id
├─ lib/
│  ├─ domain/
│  │  ├─ slug.ts                  # isValidSlug, normalizeToSlug, repoNameFor (pure)
│  │  └─ authz.ts                 # assertOwnsClassroom → typed errors
│  ├─ http/
│  │  ├─ json.ts                  # json()/error() response helpers + status conventions
│  │  ├─ validation.ts            # Valibot parseBody() → typed value | 400
│  │  ├─ schemas.ts               # Valibot schemas: classroom, assignment bodies
│  │  └─ errors.ts                # ValidationError/ForbiddenError/NotFoundError/ConflictError + toResponse()
│  ├─ auth/
│  │  └─ require.ts               # requireSession(cookies, secret) → SessionPayload | null
│  └─ db/
│     ├─ classrooms.ts            # createClassroom, getClassroomById
│     └─ assignments.ts           # createAssignment, getAssignmentById, listAssignmentsByClassroom
migrations/0002_classroom_owner.sql
```

`auth/require.ts` extracts the session-reading logic currently inlined in `src/pages/index.astro`; that page may be refactored to use it (small, in-scope cleanup) but no behavior changes.

---

## 5. Components & Contracts

### `domain/slug.ts` (pure)
- `isValidSlug(s: string): boolean` — matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`, length 1–60, lowercase, no leading/trailing/double hyphens.
- `normalizeToSlug(s: string): string` — best-effort slugify of a title (lowercase, spaces→hyphens, strip invalid chars, collapse hyphens) for convenience; callers still validate the result.
- `repoNameFor(slug: string, username: string): string` — returns `` `${slug}-${username.toLowerCase()}` ``.

### `domain/authz.ts`
- `assertOwnsClassroom(db, classroomId, userId): Promise<Classroom>` — loads the classroom; throws `NotFoundError` if absent, `ForbiddenError` if `created_by !== userId`; returns it otherwise.

### `http/validation.ts` + `http/schemas.ts` (Valibot)
- `parseBody<T>(request, schema): Promise<T>` — parses JSON, runs the Valibot schema, throws `ValidationError` (field-keyed messages) on failure.
- Classroom schema: `{ name: non-empty string, github_org: non-empty string, timezone?: valid IANA tz (default "UTC") }`. Timezone validity checked via `Intl.DateTimeFormat`/`Intl.supportedValuesOf`.
- Assignment schema: `{ slug: string (also run through isValidSlug), title: non-empty string, template_repo: "owner/name" shape, deadline_at?: ISO-8601 UTC string, grace_minutes?: int ≥ 0 (default 0) }`.

### `http/json.ts` + `http/errors.ts`
- `json(data, status=200)`, `error(message, status, fields?)`.
- Typed errors mapped by `toResponse(err)`: `ValidationError→400`, unauthenticated→`401`, `ForbiddenError→403`, `NotFoundError→404`, `ConflictError→409`. Convention: create→`201 {data}`, read→`200 {data}`, failures→`{error:{message, fields?}}`.

### `auth/require.ts`
- `requireSession(cookies, secret): Promise<SessionPayload | null>` — reads + verifies the session cookie (reusing Phase 0 `verifySession`). Endpoints turn `null` into `401`.

### `db/classrooms.ts`, `db/assignments.ts`
- `createClassroom(db, {name, githubOrg, timezone, createdBy}) → Classroom`
- `getClassroomById(db, id) → Classroom | null`
- `createAssignment(db, {classroomId, slug, title, templateRepo, deadlineAt, graceMinutes}) → Assignment` — the `UNIQUE(classroom_id, slug)` violation is caught and rethrown as `ConflictError`.
- `getAssignmentById(db, id) → Assignment | null`
- `listAssignmentsByClassroom(db, classroomId) → Assignment[]`

---

## 6. Data Flow

**Create assignment** — `POST /api/classrooms/:id/assignments`:
1. `requireSession` → else `401`.
2. `assertOwnsClassroom(db, :id, userId)` → else `404`/`403`.
3. `parseBody(request, assignmentSchema)` + `isValidSlug` → else `400`.
4. `createAssignment(...)` → DB `UNIQUE` conflict → `409`.
5. `201 { data: assignment }`.

The repo name is *computable* anytime via `repoNameFor(assignment.slug, username)` but is **not persisted** in Phase 1 — `repos` rows are created during acceptance (Phase 2).

**Read classroom** — `GET /api/classrooms/:id`: `requireSession` → `assertOwnsClassroom` → `listAssignmentsByClassroom` → `200 { data: { classroom, assignments } }`.

---

## 7. Error Handling

Helpers and repositories throw typed domain errors; each endpoint wraps its body in a single `try/catch` that delegates to `toResponse(err)`. Slug uniqueness is enforced authoritatively by the DB constraint (caught → `409`) rather than a pre-check, avoiding a check-then-insert race. Validation errors carry per-field messages so a future UI can surface them.

---

## 8. Testing (mirrors Phase 0 split)

**Unit (plain Vitest, no runtime):**
- `isValidSlug` boundaries: valid slugs, rejects uppercase / leading / trailing / double hyphens / empty / >60 chars / invalid chars.
- `normalizeToSlug` produces valid slugs from messy titles.
- `repoNameFor` lowercases username; composes `{slug}-{username}`.
- Valibot schemas: classroom + assignment accept good input, reject each bad field (bad tz, bad `template_repo` shape, negative grace, non-ISO deadline).

**Integration (`@cloudflare/vitest-pool-workers` + migrated test D1):**
- Create classroom persists with `created_by` = current user.
- Create assignment persists; response is `201` with the row.
- Duplicate slug in same classroom → `409`; same slug in a *different* classroom → allowed.
- Non-owner hitting classroom/assignment endpoints → `403`; unknown id → `404`.
- Unauthenticated request → `401`.
- `GET /api/classrooms/:id` returns the classroom with its nested assignments.

---

## 9. Recorded for Later Phases (not built now)

- **Frontend library:** the Phase 6 UI (and any earlier UI) will use **shadcn/ui** (already a devDependency; MCP server configured in `.mcp.json`). React + Tailwind will be wired into Astro at that point; nothing frontend is built in Phase 1.
- Roster/students linking, acceptance flow, template-repo existence verification → Phase 2.

---

## 10. Open Items for Implementation Planning

- Confirm the Astro file-based routing path for the nested `POST /api/classrooms/[id]/assignments` (directory vs `[id]/assignments.ts`) and that dynamic params resolve as expected under `@astrojs/cloudflare`.
- Decide exact Valibot version/import style and whether schemas live in one `schemas.ts` or beside each endpoint.
- Confirm SQLite error shape for the `UNIQUE` violation so `createAssignment` reliably maps it to `ConflictError` (message match vs. pre-flight `SELECT`).
- Decide whether `src/pages/index.astro` is refactored onto `requireSession` now or left until a UI phase (cosmetic; no behavior change).
