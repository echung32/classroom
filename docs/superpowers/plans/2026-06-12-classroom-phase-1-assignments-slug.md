# Classroom Phase 1 — Assignments + Slug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first authenticated write surface — teachers create classrooms and owner-scoped assignments, persisted to D1, with the slug naming system every later bulk operation depends on.

**Architecture:** All logic lives in framework-agnostic `src/lib/*` modules (pure domain, HTTP helpers, Valibot validation, typed D1 row-mappers). Astro `src/pages/api/*` endpoints are thin adapters: authenticate → authorize → validate → call domain/DB → shape JSON. Typed domain errors bubble to a single per-endpoint `try/catch` that maps them to status codes. No GitHub calls and no UI in this phase.

**Tech Stack:** Astro 6 + `@astrojs/cloudflare` (SSR Worker), Cloudflare D1, Valibot (request/slug validation), Vitest (unit) + `@cloudflare/vitest-pool-workers` v4 (integration against a migrated test D1).

---

## Resolved Open Items (from spec §10)

These were confirmed against the live codebase before planning — do not re-litigate:

1. **Nested routing.** Astro file-based routing allows a `[id].ts` file and an `[id]/` directory to coexist under the same parent. `src/pages/api/classrooms/[id].ts` (detail) and `src/pages/api/classrooms/[id]/assignments.ts` (create assignment) both resolve; dynamic params arrive as `params.id` (typed `string | undefined`, so assert with `params.id!`).
2. **Valibot.** Not yet installed → added as the first runtime dependency in this layer (`yarn add valibot`, v1.x). Import style: `import * as v from "valibot"`. All schemas live in a single `src/lib/http/schemas.ts`.
3. **UNIQUE error shape.** D1 surfaces constraint violations as an `Error` whose `.message` contains `"UNIQUE constraint failed"`. `createAssignment` catches and matches `/UNIQUE constraint failed/` → rethrows `ConflictError`. No pre-flight `SELECT` (avoids a check-then-insert race).
4. **`index.astro` refactor.** Done now (Task 14) — purely cosmetic, swaps inline cookie/verify for `requireSession`; the existing `index-page` integration test guards behavior.

---

## File Structure

**New runtime modules (`src/lib/`):**
- `domain/slug.ts` — `isValidSlug`, `normalizeToSlug`, `repoNameFor` (pure, no deps).
- `domain/authz.ts` — `assertOwnsClassroom` (loads classroom, throws typed errors).
- `http/json.ts` — `json(data, status)` / `error(message, status, fields?)` response helpers.
- `http/errors.ts` — `ValidationError` / `ForbiddenError` / `NotFoundError` / `ConflictError` + `toResponse(err)`.
- `http/schemas.ts` — Valibot `classroomSchema` + `assignmentSchema`.
- `http/validation.ts` — `parseBody(request, schema)` → typed value or `ValidationError`.
- `auth/require.ts` — `requireSession(cookies, secret)` → `SessionPayload | null`.
- `db/classrooms.ts` — `createClassroom`, `getClassroomById` (typed row-mappers).
- `db/assignments.ts` — `createAssignment`, `getAssignmentById`, `listAssignmentsByClassroom`.

**New endpoints (`src/pages/api/`):**
- `classrooms/index.ts` — `POST /api/classrooms`.
- `classrooms/[id].ts` — `GET /api/classrooms/:id` (detail + nested assignments).
- `classrooms/[id]/assignments.ts` — `POST /api/classrooms/:id/assignments`.
- `assignments/[id].ts` — `GET /api/assignments/:id`.

**Migration:** `migrations/0002_classroom_owner.sql` — adds `classrooms.created_by`.

**Tests:** unit specs under `test/unit/`, integration specs + a shared `test/integration/helpers.ts` under `test/integration/`.

**Modified:** `package.json` (valibot dep), `src/pages/index.astro` (cosmetic refactor).

---

## Task 1: Project setup — Valibot dependency + owner migration

**Files:**
- Modify: `package.json` (via `yarn add`)
- Create: `migrations/0002_classroom_owner.sql`

- [ ] **Step 1: Install Valibot**

Run: `yarn add valibot`
Expected: `valibot` appears under `dependencies` in `package.json`; `yarn.lock` updates.

- [ ] **Step 2: Create the migration**

Create `migrations/0002_classroom_owner.sql`:

```sql
-- Phase 1: classroom ownership. Nullable at the DB level because SQLite cannot
-- add a NOT NULL column without a default, but the application ALWAYS sets it
-- on insert (createClassroom). No backfill: Phase 0 only wrote `users`.
ALTER TABLE classrooms ADD COLUMN created_by TEXT REFERENCES users(id);
```

- [ ] **Step 3: Verify the migration applies locally**

Run: `yarn db:migrate:local`
Expected: wrangler reports `0002_classroom_owner.sql` applied (or "already applied" on re-run). No SQL error.

- [ ] **Step 4: Commit**

```bash
git add package.json yarn.lock migrations/0002_classroom_owner.sql
git commit -m "chore: add valibot dep and classroom owner migration"
```

---

## Task 2: `domain/slug.ts` — pure slug helpers

**Files:**
- Create: `src/lib/domain/slug.ts`
- Test: `test/unit/slug.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/slug.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { isValidSlug, normalizeToSlug, repoNameFor } from "../../src/lib/domain/slug";

describe("isValidSlug", () => {
  it("accepts lowercase alphanumeric hyphen-separated slugs", () => {
    expect(isValidSlug("hw1")).toBe(true);
    expect(isValidSlug("intro-to-loops")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
    expect(isValidSlug("project2-final")).toBe(true);
  });

  it("rejects uppercase, edge hyphens, double hyphens, empty, and >60 chars", () => {
    expect(isValidSlug("HW1")).toBe(false);
    expect(isValidSlug("-lead")).toBe(false);
    expect(isValidSlug("trail-")).toBe(false);
    expect(isValidSlug("double--hyphen")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("a".repeat(61))).toBe(false);
    expect(isValidSlug("has space")).toBe(false);
    expect(isValidSlug("under_score")).toBe(false);
  });

  it("accepts exactly 60 chars", () => {
    expect(isValidSlug("a".repeat(60))).toBe(true);
  });
});

describe("normalizeToSlug", () => {
  it("slugifies messy titles into valid slugs", () => {
    expect(normalizeToSlug("Intro To Loops")).toBe("intro-to-loops");
    expect(normalizeToSlug("  HW #1: Arrays!  ")).toBe("hw-1-arrays");
    expect(normalizeToSlug("a___b")).toBe("a-b");
    expect(isValidSlug(normalizeToSlug("Project 2 — Final!!!"))).toBe(true);
  });
});

describe("repoNameFor", () => {
  it("composes {slug}-{username} and lowercases the username", () => {
    expect(repoNameFor("hw1", "OctoCat")).toBe("hw1-octocat");
    expect(repoNameFor("intro-to-loops", "alice")).toBe("intro-to-loops-alice");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit -- slug`
Expected: FAIL — cannot resolve `../../src/lib/domain/slug`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/domain/slug.ts`:

```typescript
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** url-safe charset, lowercase, no leading/trailing/double hyphens, length 1–60. */
export function isValidSlug(s: string): boolean {
  return s.length >= 1 && s.length <= 60 && SLUG_RE.test(s);
}

/** Best-effort slugify of a title. Callers still validate the result with isValidSlug. */
export function normalizeToSlug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // runs of invalid chars collapse to one hyphen
    .replace(/^-+|-+$/g, ""); // strip leading/trailing hyphens
}

/** Deterministic per-student repo name. GitHub usernames are case-insensitive. */
export function repoNameFor(slug: string, username: string): string {
  return `${slug}-${username.toLowerCase()}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:unit -- slug`
Expected: PASS (all three describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/slug.ts test/unit/slug.test.ts
git commit -m "feat: add pure slug domain helpers"
```

---

## Task 3: `http/json.ts` + `http/errors.ts` — response helpers + typed errors

**Files:**
- Create: `src/lib/http/json.ts`
- Create: `src/lib/http/errors.ts`
- Test: `test/unit/http.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/http.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { error, json } from "../../src/lib/http/json";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  toResponse,
} from "../../src/lib/http/errors";

describe("json", () => {
  it("wraps data under `data` with the given status and JSON content-type", async () => {
    const res = json({ id: "x" }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ data: { id: "x" } });
  });

  it("defaults to status 200", () => {
    expect(json({ ok: true }).status).toBe(200);
  });
});

describe("error", () => {
  it("shapes failures under `error` with message and optional fields", async () => {
    expect(await error("nope", 403).then((r) => r.json())).toEqual({ error: { message: "nope" } });
    const withFields = error("bad", 400, { name: "required" });
    expect(withFields.status).toBe(400);
    expect(await withFields.json()).toEqual({ error: { message: "bad", fields: { name: "required" } } });
  });
});

describe("toResponse", () => {
  it("maps each typed error to its status", async () => {
    expect(toResponse(new ValidationError("v", { f: "x" })).status).toBe(400);
    expect(toResponse(new ForbiddenError("f")).status).toBe(403);
    expect(toResponse(new NotFoundError("n")).status).toBe(404);
    expect(toResponse(new ConflictError("c")).status).toBe(409);
  });

  it("carries ValidationError field messages through to the body", async () => {
    const res = toResponse(new ValidationError("Validation failed", { slug: "invalid" }));
    expect(await res.json()).toEqual({
      error: { message: "Validation failed", fields: { slug: "invalid" } },
    });
  });

  it("maps unknown errors to a 500 without leaking the message", async () => {
    const res = toResponse(new Error("secret internal detail"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: "Internal Server Error" } });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit -- http`
Expected: FAIL — cannot resolve `../../src/lib/http/json`.

- [ ] **Step 3: Write `json.ts`**

Create `src/lib/http/json.ts`:

```typescript
const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Success envelope: `{ data }`. create → 201, read → 200. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: JSON_HEADERS });
}

/** Failure envelope: `{ error: { message, fields? } }`. */
export function error(message: string, status: number, fields?: Record<string, string>): Response {
  const body = fields ? { error: { message, fields } } : { error: { message } };
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
```

- [ ] **Step 4: Write `errors.ts`**

Create `src/lib/http/errors.ts`:

```typescript
import { error } from "./json";

/** Request body / slug failed validation. `fields` is per-field messages for a future UI. */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** Map a thrown domain error to an HTTP response. Unknown errors → 500 (message hidden). */
export function toResponse(err: unknown): Response {
  if (err instanceof ValidationError) return error(err.message, 400, err.fields);
  if (err instanceof ForbiddenError) return error(err.message, 403);
  if (err instanceof NotFoundError) return error(err.message, 404);
  if (err instanceof ConflictError) return error(err.message, 409);
  console.error("unhandled endpoint error:", err instanceof Error ? err.message : String(err));
  return error("Internal Server Error", 500);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn test:unit -- http`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/http/json.ts src/lib/http/errors.ts test/unit/http.test.ts
git commit -m "feat: add HTTP response helpers and typed domain errors"
```

---

## Task 4: `http/schemas.ts` + `http/validation.ts` — Valibot schemas + parseBody

**Files:**
- Create: `src/lib/http/schemas.ts`
- Create: `src/lib/http/validation.ts`
- Test: `test/unit/validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/validation.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/lib/http/errors";
import { assignmentSchema, classroomSchema } from "../../src/lib/http/schemas";
import { parseBody } from "../../src/lib/http/validation";

function req(body: unknown): Request {
  return new Request("https://x/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("parseBody + classroomSchema", () => {
  it("accepts valid input and defaults timezone to UTC", async () => {
    const out = await parseBody(req({ name: "CS101", github_org: "my-org" }), classroomSchema);
    expect(out).toEqual({ name: "CS101", github_org: "my-org", timezone: "UTC" });
  });

  it("accepts a valid IANA timezone", async () => {
    const out = await parseBody(
      req({ name: "CS101", github_org: "my-org", timezone: "America/New_York" }),
      classroomSchema,
    );
    expect(out.timezone).toBe("America/New_York");
  });

  it("rejects a blank name, blank org, and bad timezone with field messages", async () => {
    await expect(parseBody(req({ name: "", github_org: "o" }), classroomSchema)).rejects.toMatchObject({
      name: "ValidationError",
    });
    const err = await parseBody(
      req({ name: "CS101", github_org: "my-org", timezone: "Mars/Phobos" }),
      classroomSchema,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fields).toHaveProperty("timezone");
  });
});

describe("parseBody + assignmentSchema", () => {
  it("accepts valid input and defaults grace_minutes to 0", async () => {
    const out = await parseBody(
      req({ slug: "hw1", title: "Homework 1", template_repo: "my-org/hw1-template" }),
      assignmentSchema,
    );
    expect(out).toEqual({
      slug: "hw1",
      title: "Homework 1",
      template_repo: "my-org/hw1-template",
      grace_minutes: 0,
    });
  });

  it("accepts an optional ISO-8601 UTC deadline and positive grace", async () => {
    const out = await parseBody(
      req({
        slug: "hw1",
        title: "Homework 1",
        template_repo: "my-org/hw1-template",
        deadline_at: "2026-09-01T23:59:00Z",
        grace_minutes: 15,
      }),
      assignmentSchema,
    );
    expect(out.deadline_at).toBe("2026-09-01T23:59:00Z");
    expect(out.grace_minutes).toBe(15);
  });

  it("rejects an invalid slug", async () => {
    const err = await parseBody(
      req({ slug: "Bad Slug", title: "t", template_repo: "o/n" }),
      assignmentSchema,
    ).catch((e) => e);
    expect(err.fields).toHaveProperty("slug");
  });

  it("rejects a template_repo that is not owner/name", async () => {
    const err = await parseBody(
      req({ slug: "hw1", title: "t", template_repo: "no-slash" }),
      assignmentSchema,
    ).catch((e) => e);
    expect(err.fields).toHaveProperty("template_repo");
  });

  it("rejects a negative grace_minutes and a non-ISO deadline", async () => {
    const neg = await parseBody(
      req({ slug: "hw1", title: "t", template_repo: "o/n", grace_minutes: -1 }),
      assignmentSchema,
    ).catch((e) => e);
    expect(neg.fields).toHaveProperty("grace_minutes");

    const bad = await parseBody(
      req({ slug: "hw1", title: "t", template_repo: "o/n", deadline_at: "September 1st" }),
      assignmentSchema,
    ).catch((e) => e);
    expect(bad.fields).toHaveProperty("deadline_at");
  });

  it("throws ValidationError on a non-JSON body", async () => {
    const bad = new Request("https://x/api", { method: "POST", body: "not json{" });
    await expect(parseBody(bad, assignmentSchema)).rejects.toBeInstanceOf(ValidationError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit -- validation`
Expected: FAIL — cannot resolve `../../src/lib/http/schemas`.

- [ ] **Step 3: Write `schemas.ts`**

Create `src/lib/http/schemas.ts`:

```typescript
import * as v from "valibot";
import { isValidSlug } from "../domain/slug";

/** True if `tz` is a timezone the runtime's Intl accepts. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// owner/name — GitHub-ish chars only, exactly one slash. Existence NOT checked (Phase 2).
const TEMPLATE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const classroomSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "name is required")),
  github_org: v.pipe(v.string(), v.trim(), v.minLength(1, "github_org is required")),
  timezone: v.optional(
    v.pipe(v.string(), v.check(isValidTimezone, "timezone must be a valid IANA timezone")),
    "UTC",
  ),
});

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
  grace_minutes: v.optional(
    v.pipe(v.number(), v.integer("grace_minutes must be an integer"), v.minValue(0, "grace_minutes must be >= 0")),
    0,
  ),
});

export type ClassroomBody = v.InferOutput<typeof classroomSchema>;
export type AssignmentBody = v.InferOutput<typeof assignmentSchema>;
```

- [ ] **Step 4: Write `validation.ts`**

Create `src/lib/http/validation.ts`:

```typescript
import * as v from "valibot";
import { ValidationError } from "./errors";

/** Parse a JSON request body against a Valibot schema. Throws ValidationError on failure. */
export async function parseBody<S extends v.GenericSchema>(
  request: Request,
  schema: S,
): Promise<v.InferOutput<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }

  const result = v.safeParse(schema, raw);
  if (result.success) return result.output;

  // Flatten per-field issues into { field: firstMessage } for a future UI.
  const flat = v.flatten(result.issues);
  const fields: Record<string, string> = {};
  for (const [key, messages] of Object.entries(flat.nested ?? {})) {
    if (messages && messages.length > 0) fields[key] = messages[0];
  }
  throw new ValidationError("Validation failed", fields);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn test:unit -- validation`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/http/schemas.ts src/lib/http/validation.ts test/unit/validation.test.ts
git commit -m "feat: add valibot schemas and parseBody validation"
```

---

## Task 5: `auth/require.ts` — requireSession

**Files:**
- Create: `src/lib/auth/require.ts`
- Test: `test/unit/require.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/require.test.ts`:

```typescript
import type { AstroCookies } from "astro";
import { describe, expect, it } from "vitest";
import { requireSession } from "../../src/lib/auth/require";
import { SESSION_COOKIE_NAME, signSession } from "../../src/lib/auth/session";

const SECRET = "unit-test-secret";

// Minimal AstroCookies stand-in: only `get` is exercised by requireSession.
function cookiesWith(value?: string): AstroCookies {
  return {
    get: (name: string) => (name === SESSION_COOKIE_NAME && value ? { value } : undefined),
  } as unknown as AstroCookies;
}

describe("requireSession", () => {
  it("returns the payload for a valid session cookie", async () => {
    const token = await signSession({ userId: "u1", githubUsername: "octocat" }, SECRET);
    const payload = await requireSession(cookiesWith(token), SECRET);
    expect(payload?.userId).toBe("u1");
    expect(payload?.githubUsername).toBe("octocat");
  });

  it("returns null when the cookie is absent", async () => {
    expect(await requireSession(cookiesWith(undefined), SECRET)).toBeNull();
  });

  it("returns null when the cookie signature is invalid", async () => {
    const token = await signSession({ userId: "u1", githubUsername: "octocat" }, SECRET);
    expect(await requireSession(cookiesWith(token), "wrong-secret")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:unit -- require`
Expected: FAIL — cannot resolve `../../src/lib/auth/require`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/auth/require.ts`:

```typescript
import type { AstroCookies } from "astro";
import { SESSION_COOKIE_NAME, type SessionPayload, verifySession } from "./session";

/** Read + verify the session cookie. Endpoints turn `null` into a 401. */
export async function requireSession(
  cookies: AstroCookies,
  secret: string,
): Promise<SessionPayload | null> {
  const value = cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!value) return null;
  return verifySession(value, secret);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:unit -- require`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/require.ts test/unit/require.test.ts
git commit -m "feat: add requireSession session-reading helper"
```

---

## Task 6: Integration test helper — seedUserAndCookie

This shared helper seeds a real user (so `created_by`'s FK and authorization checks have a valid owner) and returns a signed session cookie. Used by every integration test from here on.

**Files:**
- Create: `test/integration/helpers.ts`
- Test: `test/integration/helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/integration/helpers.test.ts`:

```typescript
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifySession } from "../../src/lib/auth/session";
import { seedUserAndCookie } from "./helpers";

describe("seedUserAndCookie", () => {
  it("persists a user and returns a matching signed session cookie", async () => {
    const { user, cookie } = await seedUserAndCookie({ githubId: 42, login: "octocat" });

    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(cookie.startsWith("session=")).toBe(true);

    const token = cookie.slice("session=".length);
    const payload = await verifySession(token, env.SESSION_SECRET);
    expect(payload?.userId).toBe(user.id);
    expect(payload?.githubUsername).toBe("octocat");

    const row = await env.DB.prepare("SELECT id FROM users WHERE github_id = 42").first<{ id: string }>();
    expect(row?.id).toBe(user.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- helpers`
Expected: FAIL — cannot resolve `./helpers`.

- [ ] **Step 3: Write the helper**

Create `test/integration/helpers.ts`:

```typescript
import { env } from "cloudflare:test";
import { SESSION_COOKIE_NAME, signSession } from "../../src/lib/auth/session";
import { type User, upsertUser } from "../../src/lib/db/users";

/** Seed a user in the test D1 and return a Cookie header carrying their signed session. */
export async function seedUserAndCookie(input: {
  githubId: number;
  login: string;
}): Promise<{ user: User; cookie: string }> {
  const user = await upsertUser(env.DB, { githubId: input.githubId, githubUsername: input.login });
  const token = await signSession(
    { userId: user.id, githubUsername: user.githubUsername },
    env.SESSION_SECRET,
  );
  return { user, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- helpers`
Expected: PASS. (Reminder: `test:integration` runs `yarn build` first; this is expected and may take ~20–40s.)

- [ ] **Step 5: Commit**

```bash
git add test/integration/helpers.ts test/integration/helpers.test.ts
git commit -m "test: add seedUserAndCookie integration helper"
```

---

## Task 7: `db/classrooms.ts` — createClassroom + getClassroomById

**Files:**
- Create: `src/lib/db/classrooms.ts`
- Test: `test/integration/classrooms-db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/integration/classrooms-db.test.ts`:

```typescript
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createClassroom, getClassroomById } from "../../src/lib/db/classrooms";
import { seedUserAndCookie } from "./helpers";

describe("classrooms repository", () => {
  it("createClassroom inserts a row with a uuid, defaults, and created_by", async () => {
    const { user } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "America/New_York",
      createdBy: user.id,
    });

    expect(classroom.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(classroom.name).toBe("CS101");
    expect(classroom.githubOrg).toBe("my-org");
    expect(classroom.timezone).toBe("America/New_York");
    expect(classroom.createdBy).toBe(user.id);
    expect(classroom.createdAt).toBeTruthy();
  });

  it("getClassroomById returns the classroom or null", async () => {
    const { user } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const created = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: user.id,
    });
    expect(await getClassroomById(env.DB, created.id)).toEqual(created);
    expect(await getClassroomById(env.DB, "missing-id")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- classrooms-db`
Expected: FAIL — cannot resolve `../../src/lib/db/classrooms`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/classrooms.ts`:

```typescript
import type { D1Database } from "@cloudflare/workers-types";

export interface Classroom {
  id: string;
  name: string;
  githubOrg: string;
  timezone: string;
  createdBy: string | null;
  createdAt: string;
}

interface ClassroomRow {
  id: string;
  name: string;
  github_org: string;
  timezone: string;
  created_by: string | null;
  created_at: string;
}

function toClassroom(row: ClassroomRow): Classroom {
  return {
    id: row.id,
    name: row.name,
    githubOrg: row.github_org,
    timezone: row.timezone,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function createClassroom(
  db: D1Database,
  input: { name: string; githubOrg: string; timezone: string; createdBy: string },
): Promise<Classroom> {
  const row = await db
    .prepare(
      `INSERT INTO classrooms (id, name, github_org, timezone, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5)
       RETURNING *`,
    )
    .bind(crypto.randomUUID(), input.name, input.githubOrg, input.timezone, input.createdBy)
    .first<ClassroomRow>();
  if (!row) throw new Error("createClassroom: INSERT ... RETURNING produced no row");
  return toClassroom(row);
}

export async function getClassroomById(db: D1Database, id: string): Promise<Classroom | null> {
  const row = await db
    .prepare("SELECT * FROM classrooms WHERE id = ?1")
    .bind(id)
    .first<ClassroomRow>();
  return row ? toClassroom(row) : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- classrooms-db`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/classrooms.ts test/integration/classrooms-db.test.ts
git commit -m "feat: add classrooms repository"
```

---

## Task 8: `db/assignments.ts` — create/get/list + ConflictError on duplicate slug

**Files:**
- Create: `src/lib/db/assignments.ts`
- Test: `test/integration/assignments-db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/integration/assignments-db.test.ts`:

```typescript
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createAssignment,
  getAssignmentById,
  listAssignmentsByClassroom,
} from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { ConflictError } from "../../src/lib/http/errors";
import { seedUserAndCookie } from "./helpers";

async function seedClassroom(githubId = 1, login = "teacher") {
  const { user } = await seedUserAndCookie({ githubId, login });
  return createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "my-org",
    timezone: "UTC",
    createdBy: user.id,
  });
}

describe("assignments repository", () => {
  it("createAssignment persists a row with defaults", async () => {
    const classroom = await seedClassroom();
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "Homework 1",
      templateRepo: "my-org/hw1-template",
      graceMinutes: 0,
    });

    expect(assignment.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(assignment.classroomId).toBe(classroom.id);
    expect(assignment.slug).toBe("hw1");
    expect(assignment.title).toBe("Homework 1");
    expect(assignment.templateRepo).toBe("my-org/hw1-template");
    expect(assignment.deadlineAt).toBeNull();
    expect(assignment.graceMinutes).toBe(0);
    expect(assignment.status).toBe("open");
  });

  it("persists an optional deadline and grace", async () => {
    const classroom = await seedClassroom();
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw2",
      title: "Homework 2",
      templateRepo: "my-org/hw2-template",
      deadlineAt: "2026-09-01T23:59:00Z",
      graceMinutes: 15,
    });
    expect(assignment.deadlineAt).toBe("2026-09-01T23:59:00Z");
    expect(assignment.graceMinutes).toBe(15);
  });

  it("throws ConflictError on a duplicate slug in the same classroom", async () => {
    const classroom = await seedClassroom();
    await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "First",
      templateRepo: "my-org/hw1-template",
      graceMinutes: 0,
    });
    await expect(
      createAssignment(env.DB, {
        classroomId: classroom.id,
        slug: "hw1",
        title: "Dup",
        templateRepo: "my-org/hw1-template",
        graceMinutes: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows the same slug in a different classroom", async () => {
    const a = await seedClassroom(1, "teacher-a");
    const b = await seedClassroom(2, "teacher-b");
    await createAssignment(env.DB, {
      classroomId: a.id,
      slug: "hw1",
      title: "A",
      templateRepo: "my-org/hw1-template",
      graceMinutes: 0,
    });
    const second = await createAssignment(env.DB, {
      classroomId: b.id,
      slug: "hw1",
      title: "B",
      templateRepo: "my-org/hw1-template",
      graceMinutes: 0,
    });
    expect(second.slug).toBe("hw1");
  });

  it("getAssignmentById and listAssignmentsByClassroom read back rows", async () => {
    const classroom = await seedClassroom();
    const created = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "Homework 1",
      templateRepo: "my-org/hw1-template",
      graceMinutes: 0,
    });
    expect(await getAssignmentById(env.DB, created.id)).toEqual(created);
    expect(await getAssignmentById(env.DB, "missing-id")).toBeNull();

    const list = await listAssignmentsByClassroom(env.DB, classroom.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
    expect(await listAssignmentsByClassroom(env.DB, "missing-id")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- assignments-db`
Expected: FAIL — cannot resolve `../../src/lib/db/assignments`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/assignments.ts`:

```typescript
import type { D1Database } from "@cloudflare/workers-types";
import { ConflictError } from "../http/errors";

export interface Assignment {
  id: string;
  classroomId: string;
  slug: string;
  title: string;
  templateRepo: string;
  deadlineAt: string | null;
  graceMinutes: number;
  status: string;
  graderRepo: string | null;
  closedAt: string | null;
  createdAt: string;
}

interface AssignmentRow {
  id: string;
  classroom_id: string;
  slug: string;
  title: string;
  template_repo: string;
  deadline_at: string | null;
  grace_minutes: number;
  status: string;
  grader_repo: string | null;
  closed_at: string | null;
  created_at: string;
}

function toAssignment(row: AssignmentRow): Assignment {
  return {
    id: row.id,
    classroomId: row.classroom_id,
    slug: row.slug,
    title: row.title,
    templateRepo: row.template_repo,
    deadlineAt: row.deadline_at,
    graceMinutes: row.grace_minutes,
    status: row.status,
    graderRepo: row.grader_repo,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

export async function createAssignment(
  db: D1Database,
  input: {
    classroomId: string;
    slug: string;
    title: string;
    templateRepo: string;
    deadlineAt?: string;
    graceMinutes: number;
  },
): Promise<Assignment> {
  try {
    const row = await db
      .prepare(
        `INSERT INTO assignments (id, classroom_id, slug, title, template_repo, deadline_at, grace_minutes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         RETURNING *`,
      )
      .bind(
        crypto.randomUUID(),
        input.classroomId,
        input.slug,
        input.title,
        input.templateRepo,
        input.deadlineAt ?? null,
        input.graceMinutes,
      )
      .first<AssignmentRow>();
    if (!row) throw new Error("createAssignment: INSERT ... RETURNING produced no row");
    return toAssignment(row);
  } catch (err) {
    // The UNIQUE(classroom_id, slug) constraint is the authoritative slug-uniqueness
    // check (no pre-flight SELECT → no check-then-insert race). D1 surfaces it as an
    // Error whose message contains "UNIQUE constraint failed".
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new ConflictError(`An assignment with slug "${input.slug}" already exists in this classroom`);
    }
    throw err;
  }
}

export async function getAssignmentById(db: D1Database, id: string): Promise<Assignment | null> {
  const row = await db
    .prepare("SELECT * FROM assignments WHERE id = ?1")
    .bind(id)
    .first<AssignmentRow>();
  return row ? toAssignment(row) : null;
}

export async function listAssignmentsByClassroom(
  db: D1Database,
  classroomId: string,
): Promise<Assignment[]> {
  const { results } = await db
    .prepare("SELECT * FROM assignments WHERE classroom_id = ?1 ORDER BY created_at ASC")
    .bind(classroomId)
    .all<AssignmentRow>();
  return results.map(toAssignment);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- assignments-db`
Expected: PASS (including the ConflictError and cross-classroom cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/assignments.ts test/integration/assignments-db.test.ts
git commit -m "feat: add assignments repository with conflict mapping"
```

---

## Task 9: `domain/authz.ts` — assertOwnsClassroom

**Files:**
- Create: `src/lib/domain/authz.ts`
- Test: `test/integration/authz.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/integration/authz.test.ts`:

```typescript
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { assertOwnsClassroom } from "../../src/lib/domain/authz";
import { createClassroom } from "../../src/lib/db/classrooms";
import { ForbiddenError, NotFoundError } from "../../src/lib/http/errors";
import { seedUserAndCookie } from "./helpers";

describe("assertOwnsClassroom", () => {
  it("returns the classroom when the user owns it", async () => {
    const { user } = await seedUserAndCookie({ githubId: 1, login: "owner" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: user.id,
    });
    const result = await assertOwnsClassroom(env.DB, classroom.id, user.id);
    expect(result.id).toBe(classroom.id);
  });

  it("throws NotFoundError for an unknown classroom id", async () => {
    const { user } = await seedUserAndCookie({ githubId: 1, login: "owner" });
    await expect(assertOwnsClassroom(env.DB, "missing-id", user.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws ForbiddenError when the user is not the owner", async () => {
    const { user: owner } = await seedUserAndCookie({ githubId: 1, login: "owner" });
    const { user: other } = await seedUserAndCookie({ githubId: 2, login: "intruder" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: owner.id,
    });
    await expect(assertOwnsClassroom(env.DB, classroom.id, other.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- authz`
Expected: FAIL — cannot resolve `../../src/lib/domain/authz`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/domain/authz.ts`:

```typescript
import type { D1Database } from "@cloudflare/workers-types";
import { type Classroom, getClassroomById } from "../db/classrooms";
import { ForbiddenError, NotFoundError } from "../http/errors";

/** Owner-scoped guard. Throws NotFoundError if absent, ForbiddenError if not the owner. */
export async function assertOwnsClassroom(
  db: D1Database,
  classroomId: string,
  userId: string,
): Promise<Classroom> {
  const classroom = await getClassroomById(db, classroomId);
  if (!classroom) throw new NotFoundError("Classroom not found");
  if (classroom.createdBy !== userId) throw new ForbiddenError("You do not own this classroom");
  return classroom;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- authz`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/authz.ts test/integration/authz.test.ts
git commit -m "feat: add owner-scoped classroom authorization guard"
```

---

## Task 10: `POST /api/classrooms` endpoint

**Files:**
- Create: `src/pages/api/classrooms/index.ts`
- Test: `test/integration/classrooms-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/integration/classrooms-api.test.ts`:

```typescript
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedUserAndCookie } from "./helpers";

function post(body: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch("https://example.com/api/classrooms", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/classrooms", () => {
  it("creates a classroom owned by the current user (201)", async () => {
    const { user, cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const res = await post({ name: "CS101", github_org: "my-org" }, cookie);
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string; createdBy: string; timezone: string } };
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.createdBy).toBe(user.id);
    expect(data.timezone).toBe("UTC");
  });

  it("rejects an unauthenticated request (401)", async () => {
    const res = await post({ name: "CS101", github_org: "my-org" });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid body with field messages (400)", async () => {
    const { cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const res = await post({ name: "", github_org: "my-org" }, cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { fields?: Record<string, string> } };
    expect(body.error.fields).toHaveProperty("name");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- classrooms-api`
Expected: FAIL — `POST /api/classrooms` returns 404 (route does not exist yet).

- [ ] **Step 3: Write the endpoint**

Create `src/pages/api/classrooms/index.ts`:

```typescript
import type { APIRoute } from "astro";
import { requireSession } from "../../../lib/auth/require";
import { getEnv } from "../../../lib/config";
import { createClassroom } from "../../../lib/db/classrooms";
import { toResponse } from "../../../lib/http/errors";
import { error, json } from "../../../lib/http/json";
import { classroomSchema } from "../../../lib/http/schemas";
import { parseBody } from "../../../lib/http/validation";

export const POST: APIRoute = async ({ request, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const body = await parseBody(request, classroomSchema);
    const classroom = await createClassroom(env.DB, {
      name: body.name,
      githubOrg: body.github_org,
      timezone: body.timezone,
      createdBy: session.userId,
    });
    return json(classroom, 201);
  } catch (err) {
    return toResponse(err);
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- classrooms-api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/classrooms/index.ts test/integration/classrooms-api.test.ts
git commit -m "feat: add POST /api/classrooms endpoint"
```

---

## Task 11: `GET /api/classrooms/:id` endpoint (detail + nested assignments)

**Files:**
- Create: `src/pages/api/classrooms/[id].ts`
- Test: extend `test/integration/classrooms-api.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/integration/classrooms-api.test.ts` (add the import of `createClassroom` and `createAssignment` at the top, then this block):

```typescript
// add to the imports at the top of the file:
//   import { env } from "cloudflare:test";
//   import { createClassroom } from "../../src/lib/db/classrooms";
//   import { createAssignment } from "../../src/lib/db/assignments";

describe("GET /api/classrooms/:id", () => {
  function get(id: string, cookie?: string): Promise<Response> {
    return SELF.fetch(`https://example.com/api/classrooms/${id}`, {
      headers: cookie ? { cookie } : {},
    });
  }

  it("returns the classroom with its nested assignments (200)", async () => {
    const { user, cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: user.id,
    });
    await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "Homework 1",
      templateRepo: "my-org/hw1-template",
      graceMinutes: 0,
    });

    const res = await get(classroom.id, cookie);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { classroom: { id: string }; assignments: { slug: string }[] };
    };
    expect(data.classroom.id).toBe(classroom.id);
    expect(data.assignments).toHaveLength(1);
    expect(data.assignments[0].slug).toBe("hw1");
  });

  it("returns 401 when unauthenticated", async () => {
    const { user } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: user.id,
    });
    expect((await get(classroom.id)).status).toBe(401);
  });

  it("returns 404 for an unknown classroom id", async () => {
    const { cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    expect((await get("00000000-0000-0000-0000-000000000000", cookie)).status).toBe(404);
  });

  it("returns 403 when the caller is not the owner", async () => {
    const { user: owner } = await seedUserAndCookie({ githubId: 1, login: "owner" });
    const { cookie: intruderCookie } = await seedUserAndCookie({ githubId: 2, login: "intruder" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: owner.id,
    });
    expect((await get(classroom.id, intruderCookie)).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- classrooms-api`
Expected: FAIL — `GET /api/classrooms/:id` returns 404 (route missing).

- [ ] **Step 3: Write the endpoint**

Create `src/pages/api/classrooms/[id].ts`:

```typescript
import type { APIRoute } from "astro";
import { requireSession } from "../../../lib/auth/require";
import { getEnv } from "../../../lib/config";
import { listAssignmentsByClassroom } from "../../../lib/db/assignments";
import { assertOwnsClassroom } from "../../../lib/domain/authz";
import { toResponse } from "../../../lib/http/errors";
import { error, json } from "../../../lib/http/json";

export const GET: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const classroom = await assertOwnsClassroom(env.DB, params.id!, session.userId);
    const assignments = await listAssignmentsByClassroom(env.DB, classroom.id);
    return json({ classroom, assignments }, 200);
  } catch (err) {
    return toResponse(err);
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- classrooms-api`
Expected: PASS (both `POST` and `GET` describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/classrooms/[id].ts test/integration/classrooms-api.test.ts
git commit -m "feat: add GET /api/classrooms/:id detail endpoint"
```

---

## Task 12: `POST /api/classrooms/:id/assignments` endpoint

**Files:**
- Create: `src/pages/api/classrooms/[id]/assignments.ts`
- Test: `test/integration/assignments-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/integration/assignments-api.test.ts`:

```typescript
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createClassroom } from "../../src/lib/db/classrooms";
import { seedUserAndCookie } from "./helpers";

function postAssignment(classroomId: string, body: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/classrooms/${classroomId}/assignments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function ownedClassroom(githubId = 1, login = "teacher") {
  const { user, cookie } = await seedUserAndCookie({ githubId, login });
  const classroom = await createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "my-org",
    timezone: "UTC",
    createdBy: user.id,
  });
  return { classroom, cookie };
}

const VALID = { slug: "hw1", title: "Homework 1", template_repo: "my-org/hw1-template" };

describe("POST /api/classrooms/:id/assignments", () => {
  it("creates an assignment (201) with the persisted row", async () => {
    const { classroom, cookie } = await ownedClassroom();
    const res = await postAssignment(classroom.id, VALID, cookie);
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { slug: string; classroomId: string; status: string; graceMinutes: number };
    };
    expect(data.slug).toBe("hw1");
    expect(data.classroomId).toBe(classroom.id);
    expect(data.status).toBe("open");
    expect(data.graceMinutes).toBe(0);
  });

  it("rejects a duplicate slug in the same classroom (409)", async () => {
    const { classroom, cookie } = await ownedClassroom();
    await postAssignment(classroom.id, VALID, cookie);
    const res = await postAssignment(classroom.id, VALID, cookie);
    expect(res.status).toBe(409);
  });

  it("allows the same slug in a different classroom (201)", async () => {
    const a = await ownedClassroom(1, "teacher-a");
    const b = await ownedClassroom(2, "teacher-b");
    expect((await postAssignment(a.classroom.id, VALID, a.cookie)).status).toBe(201);
    expect((await postAssignment(b.classroom.id, VALID, b.cookie)).status).toBe(201);
  });

  it("rejects an unauthenticated request (401)", async () => {
    const { classroom } = await ownedClassroom();
    expect((await postAssignment(classroom.id, VALID)).status).toBe(401);
  });

  it("returns 404 for an unknown classroom and 403 for a non-owner", async () => {
    const { classroom } = await ownedClassroom(1, "owner");
    const { cookie: intruder } = await seedUserAndCookie({ githubId: 2, login: "intruder" });
    expect(
      (await postAssignment("00000000-0000-0000-0000-000000000000", VALID, intruder)).status,
    ).toBe(404);
    expect((await postAssignment(classroom.id, VALID, intruder)).status).toBe(403);
  });

  it("rejects an invalid slug with a field message (400)", async () => {
    const { classroom, cookie } = await ownedClassroom();
    const res = await postAssignment(classroom.id, { ...VALID, slug: "Bad Slug" }, cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { fields?: Record<string, string> } };
    expect(body.error.fields).toHaveProperty("slug");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- assignments-api`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Write the endpoint**

Create `src/pages/api/classrooms/[id]/assignments.ts`:

```typescript
import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { createAssignment } from "../../../../lib/db/assignments";
import { assertOwnsClassroom } from "../../../../lib/domain/authz";
import { toResponse } from "../../../../lib/http/errors";
import { error, json } from "../../../../lib/http/json";
import { assignmentSchema } from "../../../../lib/http/schemas";
import { parseBody } from "../../../../lib/http/validation";

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const classroom = await assertOwnsClassroom(env.DB, params.id!, session.userId);
    const body = await parseBody(request, assignmentSchema);
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: body.slug,
      title: body.title,
      templateRepo: body.template_repo,
      deadlineAt: body.deadline_at,
      graceMinutes: body.grace_minutes,
    });
    return json(assignment, 201);
  } catch (err) {
    return toResponse(err);
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- assignments-api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/pages/api/classrooms/[id]/assignments.ts" test/integration/assignments-api.test.ts
git commit -m "feat: add POST /api/classrooms/:id/assignments endpoint"
```

---

## Task 13: `GET /api/assignments/:id` endpoint

**Files:**
- Create: `src/pages/api/assignments/[id].ts`
- Test: extend `test/integration/assignments-api.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/integration/assignments-api.test.ts` (reuses the existing `ownedClassroom`, `postAssignment`, `seedUserAndCookie`, `VALID`, `env`, `SELF`):

```typescript
describe("GET /api/assignments/:id", () => {
  function getAssignment(id: string, cookie?: string): Promise<Response> {
    return SELF.fetch(`https://example.com/api/assignments/${id}`, {
      headers: cookie ? { cookie } : {},
    });
  }

  async function createOne() {
    const { classroom, cookie } = await ownedClassroom();
    const created = await postAssignment(classroom.id, VALID, cookie);
    const { data } = (await created.json()) as { data: { id: string } };
    return { assignmentId: data.id, cookie };
  }

  it("returns the assignment to its owner (200)", async () => {
    const { assignmentId, cookie } = await createOne();
    const res = await getAssignment(assignmentId, cookie);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string; slug: string } };
    expect(data.id).toBe(assignmentId);
    expect(data.slug).toBe("hw1");
  });

  it("returns 401 when unauthenticated", async () => {
    const { assignmentId } = await createOne();
    expect((await getAssignment(assignmentId)).status).toBe(401);
  });

  it("returns 404 for an unknown assignment id", async () => {
    const { cookie } = await seedUserAndCookie({ githubId: 9, login: "someone" });
    expect((await getAssignment("00000000-0000-0000-0000-000000000000", cookie)).status).toBe(404);
  });

  it("returns 403 when the caller does not own the parent classroom", async () => {
    const { assignmentId } = await createOne();
    const { cookie: intruder } = await seedUserAndCookie({ githubId: 2, login: "intruder" });
    expect((await getAssignment(assignmentId, intruder)).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration -- assignments-api`
Expected: FAIL — `GET /api/assignments/:id` returns 404 (route missing).

- [ ] **Step 3: Write the endpoint**

Create `src/pages/api/assignments/[id].ts`:

```typescript
import type { APIRoute } from "astro";
import { requireSession } from "../../../lib/auth/require";
import { getEnv } from "../../../lib/config";
import { getAssignmentById } from "../../../lib/db/assignments";
import { assertOwnsClassroom } from "../../../lib/domain/authz";
import { NotFoundError, toResponse } from "../../../lib/http/errors";
import { error, json } from "../../../lib/http/json";

export const GET: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    // Authorize through the parent classroom (owner-scoped). Throws 404/403.
    await assertOwnsClassroom(env.DB, assignment.classroomId, session.userId);
    return json(assignment, 200);
  } catch (err) {
    return toResponse(err);
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration -- assignments-api`
Expected: PASS (all four describe blocks in the file).

- [ ] **Step 5: Commit**

```bash
git add "src/pages/api/assignments/[id].ts" test/integration/assignments-api.test.ts
git commit -m "feat: add GET /api/assignments/:id endpoint"
```

---

## Task 14: Cosmetic refactor — `index.astro` onto `requireSession`

No behavior change. The existing `test/integration/index-page.test.ts` guards it.

**Files:**
- Modify: `src/pages/index.astro:1-9`

- [ ] **Step 1: Apply the refactor**

In `src/pages/index.astro`, replace the frontmatter (lines 1–9):

```astro
---
import { getEnv } from "../lib/config";
import { SESSION_COOKIE_NAME, verifySession } from "../lib/auth/session";

const env = getEnv();
const cookie = Astro.cookies.get(SESSION_COOKIE_NAME)?.value;
const session = cookie ? await verifySession(cookie, env.SESSION_SECRET) : null;
const error = Astro.url.searchParams.get("error");
---
```

with:

```astro
---
import { getEnv } from "../lib/config";
import { requireSession } from "../lib/auth/require";

const env = getEnv();
const session = await requireSession(Astro.cookies, env.SESSION_SECRET);
const error = Astro.url.searchParams.get("error");
---
```

- [ ] **Step 2: Run the page integration test to verify no behavior change**

Run: `yarn test:integration -- index-page`
Expected: PASS (logged-in and logged-out rendering unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/pages/index.astro
git commit -m "refactor: read session via requireSession on the index page"
```

---

## Task 15: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole project**

Run: `yarn typecheck`
Expected: PASS — `tsc --noEmit` (src, DOM-typed) and `tsc --noEmit -p test/integration` (worker-typed) both clean.

- [ ] **Step 2: Run the full unit suite**

Run: `yarn test:unit`
Expected: PASS — `slug`, `http`, `validation`, `require` specs plus the pre-existing Phase 0 unit specs.

- [ ] **Step 3: Run the full integration suite**

Run: `yarn test:integration`
Expected: PASS — `helpers`, `classrooms-db`, `assignments-db`, `authz`, `classrooms-api`, `assignments-api` plus the pre-existing Phase 0 integration specs. (Runs `yarn build` first.)

- [ ] **Step 4: Run the combined gate**

Run: `yarn test`
Expected: PASS (unit + integration together — the Phase 1 exit gate).

- [ ] **Step 5: Final confirmation**

Confirm against the spec §1 exit gate:
- Authenticated user creates a classroom (owner) and an assignment, both persisted to D1. ✓ (Tasks 10, 12)
- Slug rules enforced; `409` on per-classroom conflict. ✓ (Tasks 4, 8, 12)
- `{slug}-{username}` repo name computable + unit-tested. ✓ (Task 2)
- Owner-scoped authorization on all classroom/assignment endpoints. ✓ (Tasks 9, 11, 12, 13)
- Unit + integration tests green. ✓ (Task 15)

No `/schedule` follow-up applies — this plan has no deferred dated obligation.

---

## Self-Review Notes

- **Spec coverage:** §3 migration → Task 1; §5 `slug.ts` → Task 2, `json/errors` → Task 3, `schemas/validation` → Task 4, `auth/require` → Task 5, `db/*` → Tasks 7–8, `authz` → Task 9; §4 endpoints → Tasks 10–13; §6 data flow exercised by the endpoint tests; §7 typed-error mapping → Task 3 (`toResponse`); §8 testing split honored (unit = pure logic; integration = Worker boundary + D1); §9 deferred items not built; §10 open items resolved up front.
- **Type consistency:** `Classroom`/`Assignment` domain shapes (camelCase) defined in Tasks 7–8 are the exact shapes asserted in every later endpoint test and returned by every endpoint. `parseBody` output keys stay snake_case (`github_org`, `template_repo`, `deadline_at`, `grace_minutes`) and are mapped to camelCase only at the DB boundary — endpoint code reflects this.
- **No placeholders:** every code and test step contains complete, runnable content.
