# Classroom Clone — Phase 2 (Acceptance + Re-sync) Design

**Status:** Approved design, ready for implementation planning
**Date:** 2026-06-12
**Scope:** Phase 2 only, of the larger [classroom-clone build plan](../../plan/classroom-clone-build-plan.md). Builds on the merged [Phase 0 skeleton](2026-06-12-classroom-phase-0-skeleton-design.md) and [Phase 1 assignments + slug](2026-06-12-classroom-phase-1-assignments-slug-design.md).

---

## 1. Purpose & Exit Gate

Phase 2 is the first phase to **write to GitHub**. It lets a teacher pre-seed a class roster, lets a student accept an assignment (creating their repo from the template and granting push access), and gives the student an idempotent escape hatch to recover access when a collaborator invite expires.

**Phase 2 is done when:**
- A teacher (classroom owner) can pre-seed a roster of named entries.
- A student can accept an assignment — either **claiming** a seeded roster name (linking their GitHub account to it) or **skipping** the selection — which:
  1. creates `{slug}-{username}` from the template repo (private),
  2. adds them as a collaborator with `push`,
  3. records the repo in `repos`.
- A student who lost access (expired/never-clicked invite) recovers it via **re-sync**, which re-issues the invite idempotently.
- Unit and integration tests are green.

**Out of scope (deferred):**
- **No UI** — JSON endpoints only (frontend is Phase 6, shadcn — see [[frontend-shadcn]]).
- **No queue / fan-out** — acceptance and re-sync are per-student, synchronous, inline. Bulk rate-limit-safe processing is Phase 4.
- **No deadline reading / commit evaluation** — Phase 3.
- No roster editing/removal beyond seed + list; no de-enrollment.

---

## 2. Settled Decisions

Decided during brainstorming. Do not reintroduce alternatives without flagging.

| Decision | Choice | Rationale |
| --- | --- | --- |
| Enrollment | **Open + implicit roster, with optional claim** of a teacher-seeded entry | Any authenticated user can accept; they optionally link to a pre-seeded named row, else get a bare row. Matches the plan's "implicit linking" while giving teachers named rosters. |
| Roster→account link | Add `user_id` to `students` (stable identity), keep `github_username` | Usernames can change; the `users.id` link is stable. |
| Repo visibility | **Private** | Student work should not be public. |
| Processing | **Synchronous inline** (no queue) | One student acting on their own repo; low volume. Queues are for bulk ops (Phase 4). |
| GitHub failures | Map `GitHubApiError` → **502** | Distinguishes upstream GitHub failures from our own 4xx. |
| Roster-list privacy | `GET …/roster` exposes unclaimed **names** to any logged-in user | Acceptable: the accept URL is shared via the teacher's invite link, so in practice only enrolled students reach it. The assignment id + authentication is the de-facto gate (see §8). No separate invite-token mechanism (YAGNI). |

---

## 3. Schema Change (migration `0003_student_user_link.sql`)

```sql
ALTER TABLE students ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE UNIQUE INDEX students_classroom_user ON students(classroom_id, user_id);
```

- Links a roster entry to the **stable** authenticated identity (`users.id`), not just the mutable `github_username`.
- Pre-seeded rows have `user_id` **and** `github_username` NULL. SQLite treats NULLs as distinct in both the existing `UNIQUE(classroom_id, github_username)` and the new index, so many unclaimed rows coexist; the unique index prevents one account from claiming two rows in a classroom.
- Claiming sets `user_id` + `github_username` on the chosen row. The skip path inserts a fresh row with `user_id` + `github_username` set and `roster_identifier` NULL.

---

## 4. Architecture

Logic stays in framework-agnostic `src/lib/*`; Astro `src/pages/api/*` endpoints are thin adapters (authenticate → authorize → validate → domain/DB + GitHub → JSON), following Phase 0/1 patterns (typed row-mappers, `getInstallationToken()` + `githubRequest()`, typed errors + `toResponse`).

```
src/
├─ pages/api/
│  ├─ classrooms/[id]/students.ts     # POST seed roster (owner) · GET list roster (owner)
│  └─ assignments/[id]/
│     ├─ roster.ts                    # GET unclaimed roster options (any authed user)
│     ├─ accept.ts                    # POST accept (claim-or-skip + repo + collaborator)
│     └─ resync.ts                    # POST re-issue collaborator invite
├─ lib/
│  ├─ github/
│  │  └─ repos.ts                     # createRepoFromTemplate, addCollaborator (fetchImpl-injectable)
│  ├─ db/
│  │  ├─ students.ts                  # seed/list/find/claim/create
│  │  └─ repos.ts                     # getRepoByAssignmentStudent, recordRepo, touchPermissionSynced
│  ├─ domain/
│  │  └─ enrollment.ts                # resolveStudentForAccept(...) — claim-or-skip orchestration
│  └─ http/
│     ├─ errors.ts                    # + map GitHubApiError → 502 in toResponse
│     └─ schemas.ts                   # + seedRoster, acceptAssignment Valibot schemas
migrations/0003_student_user_link.sql
```

The two-call GitHub sequence and repo recording are orchestrated in the endpoint (or a thin `domain/acceptance.ts` service) over the injectable `github/repos.ts` and `db/*` modules, so the orchestration is testable.

---

## 5. Components & Contracts

### `src/lib/github/repos.ts` (pure, `fetchImpl`-injectable)
- `createRepoFromTemplate({ token, templateOwner, templateRepo, owner, name, isPrivate }) → { repoId, fullName, htmlUrl }`
  - `POST /repos/{templateOwner}/{templateRepo}/generate`, body `{ owner, name, private }`.
  - On `422` "name already exists" (partial-failure recovery), `GET /repos/{owner}/{name}` to recover `repoId`/`htmlUrl` and return as success.
- `addCollaborator({ token, owner, repo, username, permission }) → { status: "invited" | "already_member", invitationUrl?: string }`
  - `PUT /repos/{owner}/{repo}/collaborators/{username}`, body `{ permission }`.
  - `201` → an invitation was created (`status:"invited"`, capture `invitation.html_url`); `204` → already a collaborator (`status:"already_member"`).

### `src/lib/db/students.ts`
- `seedStudents(db, classroomId, identifiers[]) → Student[]` — bulk insert unclaimed rows.
- `listUnclaimedStudents(db, classroomId) → {id, rosterIdentifier}[]`.
- `listStudentsByClassroom(db, classroomId) → Student[]`.
- `findStudentByUser(db, classroomId, userId) → Student | null`.
- `claimStudent(db, studentId, classroomId, userId, githubUsername) → Student` — guarded UPDATE that only succeeds when the row is in the classroom and unclaimed (`user_id IS NULL`); otherwise `ConflictError`.
- `createStudent(db, { classroomId, userId, githubUsername }) → Student` — skip path.

### `src/lib/db/repos.ts`
- `getRepoByAssignmentStudent(db, assignmentId, studentId) → Repo | null`.
- `recordRepo(db, { assignmentId, studentId, repoName, repoId }) → Repo` — sets `accepted_at` + `permission_synced_at` = now.
- `touchPermissionSynced(db, repoId) → void`.

### `src/lib/domain/enrollment.ts`
- `resolveStudentForAccept(db, { classroomId, userId, githubUsername, rosterStudentId? }) → Student` — existing-by-`user_id` ⇒ reuse; else `rosterStudentId` ⇒ `claimStudent`; else `createStudent`.

### Endpoints
| Method · Path | Auth | Body | Success |
| --- | --- | --- | --- |
| `POST /api/classrooms/:id/students` | owner | `{ identifiers: string[] }` | `201 {data: students}` |
| `GET /api/classrooms/:id/students` | owner | — | `200 {data: students}` |
| `GET /api/assignments/:id/roster` | any authed | — | `200 {data: {options: [{id, rosterIdentifier}]}}` |
| `POST /api/assignments/:id/accept` | any authed (self) | `{ rosterStudentId?: string }` | `201 {data: {repoUrl, invitationUrl?, status}}` |
| `POST /api/assignments/:id/resync` | any authed (self) | — | `200 {data: {status, invitationUrl?}}` |

---

## 6. Data Flow

**Accept** — `POST /api/assignments/:id/accept`:
1. `requireSession` → else `401` (yields `userId`, `githubUsername`).
2. Load assignment (`404` if absent) and its classroom (for `github_org`).
3. `resolveStudentForAccept` (claim → `409` if already claimed; else create).
4. **Idempotency:** if `getRepoByAssignmentStudent` returns a row, return it (treat accept as already done).
5. `createRepoFromTemplate` — `name = repoNameFor(slug, githubUsername)`, `owner = classroom.githubOrg`, template split from `assignment.templateRepo`, `isPrivate = true`.
6. `addCollaborator(push)` — capture status + `invitationUrl`.
7. `recordRepo`.
8. `201 { repoUrl, invitationUrl?, status }`.

**Re-sync** — `POST /api/assignments/:id/resync`:
1. `requireSession` → else `401`.
2. Load assignment + classroom.
3. `findStudentByUser` → `404` "not enrolled" if none.
4. `getRepoByAssignmentStudent` → `404` "accept first" if none.
5. `addCollaborator(push)` again → `201` "invite re-sent" (`invitationUrl`) or `204` "already has access".
6. `touchPermissionSynced`.
7. `200 { status, invitationUrl? }`.

The accept URL is reached from the teacher's shared invite link; the GitHub App (installed on the classroom org with Administration/Contents/Members write) provides the token via `getInstallationToken()`.

## 7. Error Handling

Reuse typed domain errors + `toResponse`, **extended so `GitHubApiError → 502`** (safe message; never leak tokens). The create→collaborate→record sequence is not atomic, but idempotency makes retries safe: a re-accept recovers an orphaned GitHub repo via the `422` path and re-runs collaborator + record; re-sync independently repairs access. `claimStudent` races resolve via the guarded UPDATE (rows-affected check), not a check-then-write.

**Assumptions to verify in planning:** the GitHub App is installed on the classroom org and can read the template repo (same org, or otherwise accessible). A missing/unreadable template surfaces as a GitHub `404` → `502` with a clear message.

## 8. Security Model (roster visibility)

`GET /api/assignments/:id/roster` returns unclaimed student names to any authenticated user who knows the assignment id. The assignment id is distributed only via the teacher's shared invite link, so in practice only enrolled students reach it — authentication + knowledge of the id is the de-facto gate. Accept/re-sync always act on **the session user's own** identity (`github_username` from the session), never on behalf of another user. No separate invite token is introduced.

## 9. Testing (mirrors Phase 0/1 split)

**Unit (plain Vitest, injected `fetchImpl`):**
- `repos.ts`: `createRepoFromTemplate` request shape + `422`-recovery; `addCollaborator` `201`(invited)/`204`(already_member) interpretation; error mapping.
- Valibot `seedRoster` + `acceptAssignment` schemas (good/bad input, optional `rosterStudentId`).
- `resolveStudentForAccept` branch logic (reuse / claim / create) with an in-memory or mocked `db`.

**Integration (`@cloudflare/vitest-pool-workers` + migrated test D1; GitHub mocked via `cloudflare:test` `fetchMock`):**
- Seed roster persists unclaimed rows; non-owner → `403`; unauthenticated → `401`.
- `GET roster` returns unclaimed options.
- Accept **claim path**: sets `user_id` + `github_username` on the chosen row, creates repo + collaborator (mocked), records `repos`, returns `repoUrl` + `invitationUrl`.
- Accept **skip path**: creates a fresh student row.
- Accept **idempotent**: second accept returns the existing repo, no duplicate `repos` row.
- Accept **claim-already-claimed** → `409`.
- Re-sync: `201`→"invite re-sent" + url; `204`→"already has access"; updates `permission_synced_at`; no prior accept → `404`.
- Unauthenticated on every student endpoint → `401`.

---

## 10. Open Items for Implementation Planning

- Confirm `cloudflare:test` `fetchMock` reliably intercepts outbound `fetch` to `api.github.com` in the v4 pool, including the token-mint call — else thread `fetchImpl`/seed a cached token in tests. (See [[integration-harness-v4-api]].)
- Confirm the generate endpoint's exact `422` body for the "name already exists" case to key the recovery branch on (status + message match vs. a pre-flight `GET`).
- Decide whether seeding accepts duplicates idempotently (re-seeding the same identifier) or errors.
- Confirm collaborator `PUT` returns the invitation object (with `html_url`) on `201` for org-owned repos under installation-token auth.
- Decide the friendly `repoUrl` shape returned (html_url from generate vs. constructed `https://github.com/{org}/{name}`).
