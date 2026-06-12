# Phase 6b — Student Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Students can follow a shared assignment URL, log in (landing back on the assignment), claim a roster name, accept, and watch their own live submission status; returning students get a "My assignments" list on the console home.

**Architecture:** The assignment page `/assignments/:id` becomes dual-mode — owners keep the existing teacher StatusBoard untouched; any other authenticated user gets a server-rendered student view with two small React islands (`AcceptPanel`, `ResyncButton`) that call the existing Phase 2 JSON endpoints. A `returnTo` cookie (set by `/auth/login`, consumed by `/auth/callback`) makes invite links survive the OAuth round-trip. One new D1 query powers the home-page list. **No new endpoints, no migrations, zero changes to `evaluation.ts`.**

**Tech Stack:** Astro 6 on Cloudflare Workers, React 19 islands, shadcn/ui, Tailwind v4, valibot, D1. Tests: vitest unit (`yarn test:unit`), jsdom component (`yarn test:client`), workers-pool integration (`yarn test:integration` — note it runs `yarn build` first, so it's slow; you can filter, e.g. `yarn test:integration auth-endpoints`).

**Spec:** `docs/superpowers/specs/2026-06-12-classroom-phase-6b-student-flow-design.md`
**Branch:** `feat/phase-6b-student-flow` (already checked out).

**Environment notes:**
- Integration tests mock GitHub via a global miniflare `outboundService` (`test/integration/github-mock.ts`) — responses are derived from the request. Conventions: repo name containing `late`/`missing`/`deleted` drives the commit-state branches; anything else is on-time. The canned deadline-window commits assume a seeded deadline of `2026-01-01T00:00:00Z`.
- Integration POSTs need `content-type: application/json` or Astro's CSRF guard returns 403.
- Known local quirk: the `DEBUG_ROUTES` 404 test in `index-page.test.ts` fails locally because `.dev.vars` sets `DEBUG_ROUTES=1`. Environmental, not a regression — ignore that one failure if it appears.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/auth/oauth.ts` | modify | + `sanitizeReturnTo`, `RETURN_TO_COOKIE_NAME` (pure auth helpers) |
| `src/pages/auth/login.ts` | modify | set the `return_to` cookie when a valid `returnTo` query param is present |
| `src/pages/auth/callback.ts` | modify | read + delete the cookie; redirect to it on success |
| `src/lib/db/assignments.ts` | modify | + `listAssignmentsForStudentUser` query |
| `src/pages/index.astro` | modify | "My assignments" section below "My classrooms" |
| `src/components/AcceptPanel.tsx` | create | accept island: roster select + accept button + success/error states |
| `src/components/ResyncButton.tsx` | create | "Fix my access" island |
| `src/pages/assignments/[id].astro` | modify | dual-mode branch + student view markup |
| `test/unit/oauth.test.ts` | modify | `sanitizeReturnTo` unit tests |
| `test/integration/auth-endpoints.test.ts` | modify | returnTo cookie / redirect tests |
| `test/integration/assignments-db.test.ts` | modify | `listAssignmentsForStudentUser` tests |
| `test/integration/index-page.test.ts` | modify | "My assignments" rendering tests |
| `test/integration/assignment-page.test.ts` | modify | update 2 existing tests; new student-view tests |
| `test/client/accept-panel.test.tsx` | create | AcceptPanel component tests |
| `test/client/resync-button.test.tsx` | create | ResyncButton smoke tests |

---

### Task 1: `sanitizeReturnTo` + returnTo cookie constant

**Files:**
- Modify: `src/lib/auth/oauth.ts`
- Test: `test/unit/oauth.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/oauth.test.ts` (add `RETURN_TO_COOKIE_NAME, sanitizeReturnTo` to the existing import block from `../../src/lib/auth/oauth`):

```ts
describe("sanitizeReturnTo", () => {
  it("passes a same-origin path through", () => {
    expect(sanitizeReturnTo("/assignments/abc-123")).toBe("/assignments/abc-123");
  });

  it("falls back to / for an absolute URL", () => {
    expect(sanitizeReturnTo("https://evil.com/phish")).toBe("/");
  });

  it("falls back to / for protocol-relative URLs (slash and backslash forms)", () => {
    expect(sanitizeReturnTo("//evil.com")).toBe("/");
    expect(sanitizeReturnTo("/\\evil.com")).toBe("/");
  });

  it("falls back to / for empty and missing values", () => {
    expect(sanitizeReturnTo("")).toBe("/");
    expect(sanitizeReturnTo(null)).toBe("/");
    expect(sanitizeReturnTo(undefined)).toBe("/");
  });

  it("exports the return-to cookie name", () => {
    expect(RETURN_TO_COOKIE_NAME).toBe("return_to");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit oauth`
Expected: FAIL — `sanitizeReturnTo` / `RETURN_TO_COOKIE_NAME` are not exported.

- [ ] **Step 3: Implement**

In `src/lib/auth/oauth.ts`, below the `STATE_TTL_SECONDS` export, add:

```ts
export const RETURN_TO_COOKIE_NAME = "return_to";

/** Same-origin guard for post-login redirects. Returns `value` only when it is
 *  an absolute same-origin path: starts with "/" but not "//" or "/\" (browsers
 *  treat both as protocol-relative). Anything else falls back to "/". */
export function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}
```

(The cookie reuses `STATE_TTL_SECONDS` for its TTL — same lifetime as the OAuth state, per the spec. No new TTL constant.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit oauth`
Expected: PASS (all oauth tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/oauth.ts test/unit/oauth.test.ts
git commit -m "feat: add sanitizeReturnTo same-origin path guard"
```

---

### Task 2: `/auth/login` stores the returnTo cookie

**Files:**
- Modify: `src/pages/auth/login.ts`
- Test: `test/integration/auth-endpoints.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/integration/auth-endpoints.test.ts`, append inside the existing `describe("GET /auth/login", ...)` block:

```ts
it("stores a sanitized returnTo in a short-lived httpOnly cookie", async () => {
  const response = await SELF.fetch(
    "https://example.com/auth/login?returnTo=" + encodeURIComponent("/assignments/abc"),
    { redirect: "manual" },
  );
  expect(response.status).toBe(302);

  const setCookie = response.headers.getSetCookie().find((c) => c.startsWith("return_to="));
  expect(setCookie).toBeDefined();
  expect(decodeURIComponent(setCookie!.split(";")[0].slice("return_to=".length))).toBe(
    "/assignments/abc",
  );
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Lax");
  expect(setCookie).toContain("Max-Age=600");
});

it("does not set the cookie when returnTo is absent or hostile", async () => {
  const variants = [
    "",
    "?returnTo=" + encodeURIComponent("https://evil.com/x"),
    "?returnTo=" + encodeURIComponent("//evil.com"),
  ];
  for (const qs of variants) {
    const response = await SELF.fetch(`https://example.com/auth/login${qs}`, {
      redirect: "manual",
    });
    expect(response.headers.getSetCookie().some((c) => c.startsWith("return_to="))).toBe(false);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:integration auth-endpoints`
Expected: the first new test FAILS (no `return_to` cookie is set); the second passes vacuously today — that's fine, it pins the sanitizer behavior.

- [ ] **Step 3: Implement**

Replace `src/pages/auth/login.ts` with:

```ts
import type { APIRoute } from "astro";
import { getEnv } from "../../lib/config";
import {
  RETURN_TO_COOKIE_NAME,
  STATE_COOKIE_NAME,
  STATE_TTL_SECONDS,
  buildAuthorizeUrl,
  createState,
  sanitizeReturnTo,
} from "../../lib/auth/oauth";

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const env = getEnv();
  const state = await createState(env.SESSION_SECRET);
  cookies.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });

  // Invite-link support: remember where to land after the OAuth round-trip.
  // Sanitized on write AND on read (callback) — a hostile value never sticks.
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"));
  if (returnTo !== "/") {
    cookies.set(RETURN_TO_COOKIE_NAME, returnTo, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: STATE_TTL_SECONDS,
    });
  }

  return redirect(buildAuthorizeUrl({ clientId: env.GITHUB_OAUTH_CLIENT_ID, state }), 302);
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:integration auth-endpoints`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/auth/login.ts test/integration/auth-endpoints.test.ts
git commit -m "feat: /auth/login stores a sanitized returnTo cookie"
```

---

### Task 3: `/auth/callback` redirects to the stored returnTo

**Files:**
- Modify: `src/pages/auth/callback.ts`
- Test: `test/integration/auth-endpoints.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("GET /auth/callback", ...)` block:

```ts
it("redirects to the returnTo cookie path on success and clears the cookie", async () => {
  mockGitHubLogin({ id: 9001, login: "student-returnto" });
  const state = await createState(env.SESSION_SECRET);

  const response = await SELF.fetch(
    `https://example.com/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
    {
      redirect: "manual",
      headers: { cookie: `oauth_state=${state}; return_to=${encodeURIComponent("/assignments/abc")}` },
    },
  );

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/assignments/abc");

  // The one-shot cookie is deleted (emptied) on the response.
  const cleared = response.headers.getSetCookie().find((c) => c.startsWith("return_to="));
  expect(cleared).toBeDefined();
  expect(cleared!.split(";")[0]).toBe("return_to=");
});

it("falls back to / when the returnTo cookie is hostile", async () => {
  mockGitHubLogin({ id: 9002, login: "student-evil" });
  const state = await createState(env.SESSION_SECRET);

  const response = await SELF.fetch(
    `https://example.com/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
    {
      redirect: "manual",
      headers: { cookie: `oauth_state=${state}; return_to=${encodeURIComponent("https://evil.com/x")}` },
    },
  );

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:integration auth-endpoints`
Expected: FAIL — the first new test gets `location: "/"` instead of `/assignments/abc`.

- [ ] **Step 3: Implement**

In `src/pages/auth/callback.ts`:

Add to the oauth import block:

```ts
import {
  RETURN_TO_COOKIE_NAME,
  STATE_COOKIE_NAME,
  exchangeCode,
  fetchAuthenticatedUser,
  sanitizeReturnTo,
  verifyState,
} from "../../lib/auth/oauth";
```

After the existing `cookies.delete(STATE_COOKIE_NAME, ...)` line, read + delete the one-shot returnTo cookie:

```ts
  const returnToCookie = cookies.get(RETURN_TO_COOKIE_NAME)?.value;
  cookies.delete(RETURN_TO_COOKIE_NAME, { path: "/" });
```

And change the success redirect (currently `return redirect("/", 302);`) to:

```ts
    return redirect(sanitizeReturnTo(returnToCookie), 302);
```

Error paths are untouched — they keep redirecting to `/?error=…`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:integration auth-endpoints`
Expected: PASS (including the untouched happy-path test, which has no returnTo cookie and still lands on `/`).

- [ ] **Step 5: Commit**

```bash
git add src/pages/auth/callback.ts test/integration/auth-endpoints.test.ts
git commit -m "feat: /auth/callback honors the one-shot returnTo cookie"
```

---

### Task 4: `listAssignmentsForStudentUser` D1 query

**Files:**
- Modify: `src/lib/db/assignments.ts`
- Test: `test/integration/assignments-db.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/integration/assignments-db.test.ts`, extend the imports:

```ts
import {
  createAssignment,
  getAssignmentById,
  listAssignmentsByClassroom,
  listAssignmentsForStudentUser,
} from "../../src/lib/db/assignments";
import { recordRepo } from "../../src/lib/db/repos";
import { createStudent } from "../../src/lib/db/students";
```

Append a new describe block:

```ts
describe("listAssignmentsForStudentUser", () => {
  it("returns enrolled assignments deadline-ascending (NULLs last) with accepted flags", async () => {
    const classroom = await seedClassroom(20, "teacher20");
    const noDeadline = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw-none",
      title: "No deadline",
      templateRepo: "my-org/t",
    });
    const early = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw-early",
      title: "Early",
      templateRepo: "my-org/t",
      deadlineAt: "2026-01-01T00:00:00Z",
    });
    const later = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw-later",
      title: "Later",
      templateRepo: "my-org/t",
      deadlineAt: "2026-06-01T00:00:00Z",
    });

    const { user } = await seedUserAndCookie({ githubId: 21, login: "student21" });
    const student = await createStudent(env.DB, {
      classroomId: classroom.id,
      userId: user.id,
      githubUsername: "student21",
    });
    await recordRepo(env.DB, {
      assignmentId: early.id,
      studentId: student.id,
      repoName: "hw-early-student21",
      repoId: 5,
    });

    const rows = await listAssignmentsForStudentUser(env.DB, user.id);
    expect(rows.map((r) => r.title)).toEqual(["Early", "Later", "No deadline"]);
    expect(rows[0]).toEqual({
      assignmentId: early.id,
      title: "Early",
      slug: "hw-early",
      deadlineAt: "2026-01-01T00:00:00Z",
      classroomName: "CS101",
      accepted: true,
    });
    expect(rows.find((r) => r.assignmentId === later.id)?.accepted).toBe(false);
    expect(rows.find((r) => r.assignmentId === noDeadline.id)?.accepted).toBe(false);
  });

  it("is empty for a user with no enrollments (other classrooms invisible)", async () => {
    const other = await seedClassroom(22, "teacher22");
    await createAssignment(env.DB, {
      classroomId: other.id,
      slug: "hw1",
      title: "Other HW",
      templateRepo: "my-org/t",
    });
    const { user } = await seedUserAndCookie({ githubId: 23, login: "student23" });
    expect(await listAssignmentsForStudentUser(env.DB, user.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:integration assignments-db`
Expected: FAIL — `listAssignmentsForStudentUser` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/db/assignments.ts`:

```ts
export interface StudentAssignment {
  assignmentId: string;
  title: string;
  slug: string;
  deadlineAt: string | null;
  classroomName: string;
  accepted: boolean;
}

/** Every assignment in classrooms where this user has a student row, joined to
 *  the classroom name; accepted = a repo row exists for (assignment, student).
 *  Deadline ascending with NULL (no deadline) last, created_at as tiebreaker. */
export async function listAssignmentsForStudentUser(
  db: D1Database,
  userId: string,
): Promise<StudentAssignment[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id AS assignment_id, a.title, a.slug, a.deadline_at,
              c.name AS classroom_name,
              CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS accepted
         FROM students s
         JOIN assignments a ON a.classroom_id = s.classroom_id
         JOIN classrooms c ON c.id = s.classroom_id
         LEFT JOIN repos r ON r.assignment_id = a.id AND r.student_id = s.id
        WHERE s.user_id = ?1
        ORDER BY a.deadline_at IS NULL, a.deadline_at ASC, a.created_at ASC`,
    )
    .bind(userId)
    .all<{
      assignment_id: string;
      title: string;
      slug: string;
      deadline_at: string | null;
      classroom_name: string;
      accepted: number;
    }>();
  return results.map((r) => ({
    assignmentId: r.assignment_id,
    title: r.title,
    slug: r.slug,
    deadlineAt: r.deadline_at,
    classroomName: r.classroom_name,
    accepted: r.accepted === 1,
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:integration assignments-db`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/assignments.ts test/integration/assignments-db.test.ts
git commit -m "feat: listAssignmentsForStudentUser query for the student home list"
```

---

### Task 5: Console home — "My assignments" section

**Files:**
- Modify: `src/pages/index.astro`
- Test: `test/integration/index-page.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/integration/index-page.test.ts`, extend the imports:

```ts
import { createAssignment } from "../../src/lib/db/assignments";
import { recordRepo } from "../../src/lib/db/repos";
import { createStudent } from "../../src/lib/db/students";
```

Append inside the `describe("GET /", ...)` block:

```ts
it("lists the student's assignments with accepted/not-accepted badges", async () => {
  const teacher = await seedUserAndCookie({ githubId: 40, login: "teacher40" });
  const classroom = await createClassroom(env.DB, {
    name: "CS200",
    githubOrg: "my-org",
    timezone: "UTC",
    createdBy: teacher.user.id,
  });
  const accepted = await createAssignment(env.DB, {
    classroomId: classroom.id,
    slug: "hw1",
    title: "Homework One",
    templateRepo: "my-org/t",
    deadlineAt: "2026-01-01T00:00:00Z",
  });
  const notAccepted = await createAssignment(env.DB, {
    classroomId: classroom.id,
    slug: "hw2",
    title: "Homework Two",
    templateRepo: "my-org/t",
  });
  const s = await seedUserAndCookie({ githubId: 41, login: "student41" });
  const student = await createStudent(env.DB, {
    classroomId: classroom.id,
    userId: s.user.id,
    githubUsername: "student41",
  });
  await recordRepo(env.DB, {
    assignmentId: accepted.id,
    studentId: student.id,
    repoName: "hw1-student41",
    repoId: 1,
  });

  const response = await SELF.fetch("https://example.com/", { headers: { cookie: s.cookie } });
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("My assignments");
  expect(html).toContain("Homework One");
  expect(html).toContain(`/assignments/${accepted.id}`);
  expect(html).toContain(`/assignments/${notAccepted.id}`);
  expect(html).toContain("CS200");
  expect(html).toContain(">accepted</span>");
  expect(html).toContain(">not accepted</span>");
});

it("omits the My assignments section for users with no enrollments", async () => {
  const { cookie } = await seedUserAndCookie({ githubId: 42, login: "lonely42" });
  const response = await SELF.fetch("https://example.com/", { headers: { cookie } });
  expect(await response.text()).not.toContain("My assignments");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:integration index-page`
Expected: the first new test FAILS ("My assignments" not in HTML). Local note: the `DEBUG_ROUTES` test in this file may fail for the known environmental reason — ignore only that one.

- [ ] **Step 3: Implement**

In `src/pages/index.astro` frontmatter, add the import and query:

```ts
import { listAssignmentsForStudentUser } from "../lib/db/assignments";
```

```ts
const myAssignments = session ? await listAssignmentsForStudentUser(env.DB, session.userId) : [];
```

In the markup, insert a section between the "My classrooms" `</section>` and `<CreateClassroomForm client:load />`:

```astro
{myAssignments.length > 0 && (
  <section>
    <h2 class="mb-3 text-xl font-semibold">My assignments</h2>
    <ul class="space-y-2">
      {myAssignments.map((a) => (
        <li class="rounded-lg border p-4">
          <a href={`/assignments/${a.assignmentId}`} class="font-medium underline">
            {a.title}
          </a>
          <span class="ml-2 text-sm text-muted-foreground">
            {a.classroomName} &middot; {a.deadlineAt ? `due ${a.deadlineAt}` : "no deadline"}
          </span>
          <span
            class={`ml-2 inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${a.accepted ? "bg-green-600 text-white" : "bg-gray-200 text-gray-700"}`}
          >
            {a.accepted ? "accepted" : "not accepted"}
          </span>
        </li>
      ))}
    </ul>
  </section>
)}
```

(The teacher "My classrooms" section is untouched; a teacher+student sees both.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:integration index-page`
Expected: PASS (modulo the known local `DEBUG_ROUTES` quirk).

- [ ] **Step 5: Commit**

```bash
git add src/pages/index.astro test/integration/index-page.test.ts
git commit -m "feat: My assignments section on the console home"
```

---

### Task 6: `AcceptPanel` island

**Files:**
- Create: `src/components/AcceptPanel.tsx`
- Test: `test/client/accept-panel.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `test/client/accept-panel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AcceptPanel from "@/components/AcceptPanel";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

const rosterOptions = [
  { id: "11111111-1111-4111-8111-111111111111", rosterIdentifier: "Ada Lovelace" },
  { id: "22222222-2222-4222-8222-222222222222", rosterIdentifier: "Bob Smith" },
];

describe("AcceptPanel", () => {
  it("disables Accept until a roster choice is made", () => {
    render(<AcceptPanel assignmentId="a1" enrolled={false} rosterOptions={rosterOptions} />);
    const button = screen.getByRole("button", { name: "Accept assignment" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("claim path: sends the selected rosterStudentId and renders the success state", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        data: {
          repoUrl: "https://github.com/test-org/hw1-ada",
          invitationUrl: "https://github.com/test-org/hw1-ada/invitations",
          status: "invited",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<AcceptPanel assignmentId="a1" enrolled={false} rosterOptions={rosterOptions} />);
    await user.click(screen.getByLabelText("Roster name"));
    await user.click(screen.getByRole("option", { name: "Ada Lovelace" }));
    await user.click(screen.getByRole("button", { name: "Accept assignment" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assignments/a1/accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ rosterStudentId: rosterOptions[0].id }),
      }),
    );
    expect(await screen.findByText("https://github.com/test-org/hw1-ada")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Accept the invite on GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it('skip path: "I\'m not on the list" sends no rosterStudentId', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        data: { repoUrl: "https://github.com/test-org/hw1-x", status: "invited" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<AcceptPanel assignmentId="a1" enrolled={false} rosterOptions={rosterOptions} />);
    await user.click(screen.getByLabelText("Roster name"));
    await user.click(screen.getByRole("option", { name: "I'm not on the list" }));
    await user.click(screen.getByRole("button", { name: "Accept assignment" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assignments/a1/accept",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(await screen.findByText("https://github.com/test-org/hw1-x")).toBeTruthy();
  });

  it("renders a 409 conflict inline and keeps the form usable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(409, { error: { message: "This roster entry has already been claimed" } }),
      ),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<AcceptPanel assignmentId="a1" enrolled={false} rosterOptions={rosterOptions} />);
    await user.click(screen.getByLabelText("Roster name"));
    await user.click(screen.getByRole("option", { name: "Bob Smith" }));
    await user.click(screen.getByRole("button", { name: "Accept assignment" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "This roster entry has already been claimed",
    );
    expect(screen.getByRole("button", { name: "Accept assignment" })).toBeTruthy();
  });

  it("appends a retry note on 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(502, { error: { message: "GitHub request failed (500)" } })),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<AcceptPanel assignmentId="a1" enrolled={true} rosterOptions={[]} />);
    await user.click(screen.getByRole("button", { name: "Accept assignment" }));

    expect((await screen.findByRole("alert")).textContent).toContain("try again");
  });

  it("enrolled mode: no select, accept posts an empty body, already_accepted renders success", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        data: { repoUrl: "https://github.com/test-org/hw1-y", status: "already_accepted" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<AcceptPanel assignmentId="a1" enrolled={true} rosterOptions={[]} />);
    expect(screen.queryByLabelText("Roster name")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Accept assignment" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assignments/a1/accept",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(await screen.findByText("https://github.com/test-org/hw1-y")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:client accept-panel`
Expected: FAIL — cannot resolve `@/components/AcceptPanel`.

- [ ] **Step 3: Implement**

Create `src/components/AcceptPanel.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError, apiFetch } from "./client/api";

interface AcceptResult {
  repoUrl: string;
  invitationUrl?: string;
  status: string;
}

interface Props {
  assignmentId: string;
  /** True when the user already has a student row in this classroom (claimed earlier). */
  enrolled: boolean;
  rosterOptions: { id: string; rosterIdentifier: string | null }[];
}

/** Sentinel Select value for "I'm not on the list" (Radix forbids empty item values). */
const SKIP_VALUE = "__skip__";

export default function AcceptPanel({ assignmentId, enrolled, rosterOptions }: Props) {
  const [selection, setSelection] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AcceptResult | null>(null);

  const needsSelection = !enrolled && rosterOptions.length > 0;
  const canSubmit = !submitting && (!needsSelection || selection !== "");

  async function accept() {
    setSubmitting(true);
    setError(null);
    try {
      const body =
        !enrolled && selection !== "" && selection !== SKIP_VALUE
          ? { rosterStudentId: selection }
          : {};
      setResult(
        await apiFetch<AcceptResult>(`/api/assignments/${assignmentId}/accept`, {
          method: "POST",
          body,
        }),
      );
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 502
            ? `${err.message} — GitHub may be temporarily unavailable, try again in a moment.`
            : err.message,
        );
      } else {
        setError("Request failed");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p className="font-medium">Assignment accepted</p>
        <p className="text-sm">
          Your repo:{" "}
          <a href={result.repoUrl} className="underline">
            {result.repoUrl}
          </a>
        </p>
        {result.invitationUrl && (
          <p className="text-sm">
            <a href={result.invitationUrl} className="underline">
              Accept the invite on GitHub
            </a>{" "}
            to get push access.
          </p>
        )}
        <Button onClick={() => location.reload()}>Continue</Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      {needsSelection && (
        <div className="space-y-1">
          <Label>Who are you?</Label>
          <Select value={selection} onValueChange={setSelection}>
            <SelectTrigger aria-label="Roster name" className="w-64">
              <SelectValue placeholder="Select your name" />
            </SelectTrigger>
            <SelectContent>
              {rosterOptions.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.rosterIdentifier ?? o.id}
                </SelectItem>
              ))}
              <SelectItem value={SKIP_VALUE}>I'm not on the list</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <Button onClick={accept} disabled={!canSubmit}>
        {submitting ? "Accepting…" : "Accept assignment"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:client accept-panel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/AcceptPanel.tsx test/client/accept-panel.test.tsx
git commit -m "feat: AcceptPanel island (roster claim / skip / accept)"
```

---

### Task 7: `ResyncButton` island

**Files:**
- Create: `src/components/ResyncButton.tsx`
- Test: `test/client/resync-button.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `test/client/resync-button.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResyncButton from "@/components/ResyncButton";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

describe("ResyncButton", () => {
  it("posts to resync and renders the re-issued invitation", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        data: { status: "invited", invitationUrl: "https://github.com/test-org/hw1-a/invitations" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ResyncButton assignmentId="a1" />);
    await user.click(screen.getByRole("button", { name: "Fix my access" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assignments/a1/resync",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText(/Invite re-sent/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "accept it on GitHub" })).toBeTruthy();
  });

  it("renders the already_member outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { data: { status: "already_member" } })),
    );
    const user = userEvent.setup();

    render(<ResyncButton assignmentId="a1" />);
    await user.click(screen.getByRole("button", { name: "Fix my access" }));

    expect(await screen.findByText(/already have push access/)).toBeTruthy();
  });

  it("renders API errors inline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: { message: "Accept the assignment first" } })),
    );
    const user = userEvent.setup();

    render(<ResyncButton assignmentId="a1" />);
    await user.click(screen.getByRole("button", { name: "Fix my access" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Accept the assignment first",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:client resync-button`
Expected: FAIL — cannot resolve `@/components/ResyncButton`.

- [ ] **Step 3: Implement**

Create `src/components/ResyncButton.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "./client/api";

interface ResyncResult {
  status: "invited" | "already_member";
  invitationUrl?: string;
}

interface Props {
  assignmentId: string;
}

export default function ResyncButton({ assignmentId }: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resync() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await apiFetch<ResyncResult>(`/api/assignments/${assignmentId}/resync`, {
          method: "POST",
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={resync} disabled={busy}>
        {busy ? "Fixing…" : "Fix my access"}
      </Button>
      {result?.status === "already_member" && (
        <p className="text-sm">You already have push access to your repo.</p>
      )}
      {result?.status === "invited" && (
        <p className="text-sm">
          Invite re-sent —{" "}
          {result.invitationUrl ? (
            <a href={result.invitationUrl} className="underline">
              accept it on GitHub
            </a>
          ) : (
            "check your GitHub notifications"
          )}{" "}
          to restore push access.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:client resync-button`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ResyncButton.tsx test/client/resync-button.test.tsx
git commit -m "feat: ResyncButton island (re-sync repo access)"
```

---

### Task 8: Dual-mode assignment page

**Files:**
- Modify: `src/pages/assignments/[id].astro`
- Test: `test/integration/assignment-page.test.ts` (2 existing tests change behavior + new student-view tests)

- [ ] **Step 1: Update the two existing tests whose specified behavior changes**

In `test/integration/assignment-page.test.ts`:

(a) The anonymous redirect now carries `returnTo`. Replace the body of `"redirects anonymous users to login"`'s final assertion:

```ts
    expect(response.headers.get("location")).toBe(
      `/auth/login?returnTo=${encodeURIComponent(`/assignments/${assignment.id}`)}`,
    );
```

(b) Replace the test `"renders 404 for a non-owner"` entirely with:

```ts
  it("renders the student accept view for a non-owner (invite-link semantics)", async () => {
    const { assignment } = await seedAssignment();
    const { cookie: otherCookie } = await seedUserAndCookie({ githubId: 2, login: "other" });
    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: otherCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Homework 1");
    expect(html).toContain("Accept assignment");
    // Teacher chrome must NOT leak to students.
    expect(html).not.toContain("Build grader");
  });
```

- [ ] **Step 2: Add the new student-view tests**

Still in `test/integration/assignment-page.test.ts`, extend the imports and add a seeding helper + describe block:

```ts
import { beforeEach } from "vitest"; // merge into the existing vitest import
import { recordRepo } from "../../src/lib/db/repos";
import { createStudent, seedStudents } from "../../src/lib/db/students";
import { clearInstallationTokenCache } from "../../src/lib/github/app";
```

At top level (next to `seedAssignment`):

```ts
beforeEach(() => clearInstallationTokenCache());

const PAST_DEADLINE = "2026-01-01T00:00:00Z";

/** Seed an enrolled student with an accepted repo. repoSuffix drives the GitHub
 *  mock's commit-state convention (ontime / late / missing / deleted). */
async function seedAcceptedStudent(opts: {
  githubId: number;
  login: string;
  repoSuffix: string;
  deadlineAt?: string;
}) {
  const seeded = await seedAssignment(opts.deadlineAt);
  const s = await seedUserAndCookie({ githubId: opts.githubId, login: opts.login });
  const student = await createStudent(env.DB, {
    classroomId: seeded.classroom.id,
    userId: s.user.id,
    githubUsername: opts.login,
  });
  await recordRepo(env.DB, {
    assignmentId: seeded.assignment.id,
    studentId: student.id,
    repoName: `hw1-${opts.repoSuffix}`,
    repoId: 999,
  });
  return { ...seeded, student, studentCookie: s.cookie };
}

describe("GET /assignments/:id — student view", () => {
  it("shows the accept panel with unclaimed roster options to an unenrolled visitor", async () => {
    const { assignment, classroom } = await seedAssignment();
    await seedStudents(env.DB, classroom.id, ["Ada Lovelace", "Bob Smith"]);
    const visitor = await seedUserAndCookie({ githubId: 30, login: "visitor30" });

    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: visitor.cookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Homework 1");
    expect(html).toContain("CS101");
    expect(html).toContain("Accept assignment");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Bob Smith");
  });

  it("hides roster options from an already-enrolled student without a repo", async () => {
    const { assignment, classroom } = await seedAssignment();
    await seedStudents(env.DB, classroom.id, ["Ada Lovelace"]);
    const s = await seedUserAndCookie({ githubId: 31, login: "enrolled31" });
    await createStudent(env.DB, {
      classroomId: classroom.id,
      userId: s.user.id,
      githubUsername: "enrolled31",
    });

    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: s.cookie },
    });
    const html = await response.text();
    expect(html).toContain("Accept assignment");
    expect(html).not.toContain("Ada Lovelace");
  });

  it("pre-deadline: shows the repo link and not-due-yet, no evaluation data", async () => {
    const { assignment, studentCookie } = await seedAcceptedStudent({
      githubId: 32,
      login: "pre32",
      repoSuffix: "ontime",
      deadlineAt: "2099-01-01T00:00:00Z",
    });

    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: studentCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("https://github.com/test-org/hw1-ontime");
    expect(html).toContain("Not due yet");
    expect(html).not.toContain("on_time");
  });

  it("no deadline: shows the repo link and the no-deadline note", async () => {
    const { assignment, studentCookie } = await seedAcceptedStudent({
      githubId: 33,
      login: "nodl33",
      repoSuffix: "ontime",
    });

    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: studentCookie },
    });
    const html = await response.text();
    expect(html).toContain("https://github.com/test-org/hw1-ontime");
    expect(html).toContain("no deadline");
  });

  it("post-deadline: the student's own page load freezes deadline_sha and renders live status", async () => {
    const { assignment, student, studentCookie } = await seedAcceptedStudent({
      githubId: 34,
      login: "post34",
      repoSuffix: "ontime",
      deadlineAt: PAST_DEADLINE,
    });

    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: studentCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("on_time");
    expect(html).toContain("Fix my access");
    // grade_decision is teacher-private — never in the student HTML.
    expect(html).not.toContain("at_deadline");

    // The page load itself performed the Phase 3 freeze.
    const row = await env.DB.prepare(
      "SELECT deadline_sha, status FROM submissions WHERE assignment_id = ?1 AND student_id = ?2",
    )
      .bind(assignment.id, student.id)
      .first<{ deadline_sha: string; status: string }>();
    expect(row?.deadline_sha).toBe("deadline-ontime-sha");
    expect(row?.status).toBe("on_time");
  });

  it("post-deadline: a per-repo GitHub failure degrades to an inline note, repo link still renders", async () => {
    const { assignment, studentCookie } = await seedAcceptedStudent({
      githubId: 35,
      login: "gone35",
      repoSuffix: "deleted",
      deadlineAt: PAST_DEADLINE,
    });

    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: studentCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("https://github.com/test-org/hw1-deleted");
    expect(html).toContain("read your repo");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `yarn test:integration assignment-page`
Expected: FAIL — the updated anonymous-redirect assertion, the non-owner 200, and every test in the new describe block fail against the current owner-404 page. The four untouched teacher tests still pass.

- [ ] **Step 4: Implement the dual-mode page**

Replace `src/pages/assignments/[id].astro` with:

```astro
---
// src/pages/assignments/[id].astro
//
// Dual-mode (Phase 6b): the classroom owner gets the teacher StatusBoard;
// any other authenticated user gets the student view. The plain URL is the
// invite link, so the owner-404 rule is relaxed for assignment pages only.
import { getEnv } from "../../lib/config";
import { requireSession } from "../../lib/auth/require";
import { getAssignmentById } from "../../lib/db/assignments";
import { getClassroomById } from "../../lib/db/classrooms";
import { getRepoByAssignmentStudent, type Repo } from "../../lib/db/repos";
import { findStudentByUser, listUnclaimedStudents, type Student } from "../../lib/db/students";
import { repoUrlFor } from "../../lib/domain/slug";
import {
  evaluateAssignmentSubmissions,
  type EvaluationResult,
} from "../../lib/domain/evaluation";
import { getInstallationToken } from "../../lib/github/app";
import { buildEvaluationDeps } from "../api/assignments/[id]/submissions";
import { shortSha, statusBadgeClass } from "../../components/client/format";
import ConsoleLayout from "../../layouts/ConsoleLayout.astro";
import NotFound from "../../components/NotFound.astro";
import StatusBoard from "../../components/StatusBoard";
import AcceptPanel from "../../components/AcceptPanel";
import ResyncButton from "../../components/ResyncButton";

const env = getEnv();
const id = Astro.params.id!;
const session = await requireSession(Astro.cookies, env.SESSION_SECRET);
if (!session) {
  return Astro.redirect(`/auth/login?returnTo=${encodeURIComponent(`/assignments/${id}`)}`);
}

const assignment = await getAssignmentById(env.DB, id);
const classroom = assignment ? await getClassroomById(env.DB, assignment.classroomId) : null;
const found = assignment !== null && classroom !== null;
const owned = found && classroom!.createdBy === session.userId;
if (!found) Astro.response.status = 404;

// --- Teacher branch (unchanged from Phase 6a) ---
let evaluation: EvaluationResult | null = null;
let evalError: string | null = null;
if (owned) {
  try {
    const token = await getInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });
    evaluation = await evaluateAssignmentSubmissions(buildEvaluationDeps(env.DB, token), {
      assignmentId: assignment!.id,
      now: new Date().toISOString(),
      refresh: false,
    });
  } catch (err) {
    console.error("assignment page evaluation failed:", err instanceof Error ? err.message : String(err));
    evalError = "Evaluating submissions failed (GitHub unreachable). Reload to retry.";
  }
}

// --- Student branch ---
const studentView = found && !owned;
let student: Student | null = null;
let repo: Repo | null = null;
let rosterOptions: { id: string; rosterIdentifier: string | null }[] = [];
let deadlinePassed = false;
let studentEval: EvaluationResult | null = null;
let studentEvalError: string | null = null;

if (studentView) {
  student = await findStudentByUser(env.DB, assignment!.classroomId, session.userId);
  repo = student ? await getRepoByAssignmentStudent(env.DB, assignment!.id, student.id) : null;

  if (!repo) {
    // Accept panel; roster options only matter for users without a student row.
    rosterOptions = student ? [] : await listUnclaimedStudents(env.DB, assignment!.classroomId);
  } else {
    deadlinePassed =
      assignment!.deadlineAt !== null && Date.now() >= Date.parse(assignment!.deadlineAt);
    // Pre-deadline / no-deadline loads make ZERO GitHub calls (no token mint,
    // no evaluator). Post-deadline, this runs the same evaluation path as the
    // teacher board narrowed to this student's repo — their first look freezes
    // deadline_sha (Phase 3 COALESCE upsert); refresh:true keeps latest/status live.
    if (deadlinePassed) {
      try {
        const token = await getInstallationToken({
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_APP_PRIVATE_KEY,
          installationId: env.GITHUB_APP_INSTALLATION_ID,
        });
        const deps = buildEvaluationDeps(env.DB, token);
        studentEval = await evaluateAssignmentSubmissions(
          {
            ...deps,
            listRepos: async (assignmentId) =>
              (await deps.listRepos(assignmentId)).filter((r) => r.studentId === student!.id),
          },
          { assignmentId: assignment!.id, now: new Date().toISOString(), refresh: true },
        );
      } catch (err) {
        console.error("student status evaluation failed:", err instanceof Error ? err.message : String(err));
        studentEvalError = "GitHub is unreachable — your status couldn't be evaluated. Reload to retry.";
      }
    }
  }
}

const mySubmission = studentEval?.submissions[0] ?? null;
const myRepoError = studentEval?.errors[0] ?? null;
---

<ConsoleLayout title={found ? assignment!.title : "Not found"} username={session.githubUsername}>
  {
    !found ? (
      <NotFound />
    ) : owned ? (
      <div class="space-y-6">
        <header>
          <h1 class="text-xl font-semibold">{assignment!.title}</h1>
          <p class="text-sm text-muted-foreground">
            {assignment!.slug} &middot; {assignment!.deadlineAt ? `due ${assignment!.deadlineAt}` : "no deadline"} &middot; {assignment!.status}
          </p>
          {assignment!.graderRepo && (
            <a href={`https://github.com/${assignment!.graderRepo}`} class="text-sm underline">
              Grader repo: {assignment!.graderRepo}
            </a>
          )}
        </header>

        {evalError && <p role="alert" class="text-sm text-destructive">{evalError}</p>}

        {evaluation?.dueState === "no-deadline" && (
          <p class="text-sm text-muted-foreground">
            This assignment has no deadline set, so submissions are never evaluated or frozen.
          </p>
        )}
        {evaluation?.dueState === "pending" && (
          <p class="text-sm text-muted-foreground">
            This assignment is not due yet — evaluation happens after the deadline.
          </p>
        )}
        {evaluation?.dueState === "evaluated" && (
          <StatusBoard
            client:load
            assignmentId={assignment!.id}
            initial={evaluation}
            graderRepo={assignment!.graderRepo}
          />
        )}
      </div>
    ) : (
      <div class="space-y-6">
        <header>
          <h1 class="text-xl font-semibold">{assignment!.title}</h1>
          <p class="text-sm text-muted-foreground">
            {classroom!.name} &middot; {classroom!.githubOrg} &middot; {assignment!.deadlineAt ? `due ${assignment!.deadlineAt}` : "no deadline"}
          </p>
        </header>

        {!repo ? (
          <AcceptPanel
            client:load
            assignmentId={assignment!.id}
            enrolled={student !== null}
            rosterOptions={rosterOptions}
          />
        ) : (
          <div class="space-y-4">
            <p class="text-sm">
              Your repo:{" "}
              <a href={repoUrlFor(classroom!.githubOrg, repo.repoName)} class="underline">
                {classroom!.githubOrg}/{repo.repoName}
              </a>
            </p>

            {assignment!.deadlineAt === null && (
              <p class="text-sm text-muted-foreground">This assignment has no deadline.</p>
            )}
            {assignment!.deadlineAt !== null && !deadlinePassed && (
              <p class="text-sm text-muted-foreground">Not due yet — keep pushing to your repo.</p>
            )}

            {studentEvalError && (
              <p role="alert" class="text-sm text-destructive">{studentEvalError}</p>
            )}
            {myRepoError && (
              <p role="alert" class="text-sm text-destructive">
                Couldn't read your repo on GitHub ({myRepoError.message}). Reload to retry.
              </p>
            )}

            {mySubmission && (
              <div class="space-y-1 text-sm">
                <p>
                  Status:
                  <span class={`ml-1 inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${statusBadgeClass(mySubmission.status)}`}>
                    {mySubmission.status ?? "—"}
                  </span>
                </p>
                <p>
                  Deadline commit: <code>{shortSha(mySubmission.deadlineSha)}</code>
                  <span class="ml-2 text-xs text-muted-foreground">{mySubmission.deadlineCommitAt ?? ""}</span>
                </p>
                <p>
                  Latest commit: <code>{shortSha(mySubmission.latestSha)}</code>
                  <span class="ml-2 text-xs text-muted-foreground">{mySubmission.latestCommitAt ?? ""}</span>
                </p>
                <p class="text-xs text-muted-foreground">Evaluated at {mySubmission.evaluatedAt}</p>
              </div>
            )}

            <ResyncButton client:load assignmentId={assignment!.id} />
          </div>
        )}
      </div>
    )
  }
</ConsoleLayout>
```

Notes for the implementer:
- `grade_decision` is intentionally absent from the student markup (teacher-private).
- Classroom pages (`/classrooms/[id].astro`) keep their strict owner-404 — do not touch them.
- The student status block deliberately renders with plain `<span>` + `statusBadgeClass` (same variant mapping as the teacher board) instead of hydrating another island.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test:integration assignment-page`
Expected: PASS — all four original teacher tests (one with the updated redirect assertion), the rewritten non-owner test, and the six new student-view tests.

- [ ] **Step 6: Commit**

```bash
git add src/pages/assignments/[id].astro test/integration/assignment-page.test.ts
git commit -m "feat: dual-mode assignment page with student accept + live status view"
```

---

### Task 9: Full verification and wrap-up

- [ ] **Step 1: Typecheck**

Run: `yarn typecheck`
Expected: clean (checks both the app and `test/integration` tsconfigs).

- [ ] **Step 2: Full test suite**

Run: `yarn test`
Expected: all unit, client, and integration tests pass — with the one known local exception: the `DEBUG_ROUTES` 404 test in `index-page.test.ts` fails locally because `.dev.vars` sets `DEBUG_ROUTES=1`. That exact failure (and only that one) is environmental and acceptable.

- [ ] **Step 3: Commit any stragglers and report**

```bash
git status
```

If clean, nothing to do. Report results, then use the superpowers:finishing-a-development-branch skill (the branch merges to `main` via PR, like Phase 6a's PR #6).

**Manual two-browser walkthrough (post-merge / reviewer checklist — not automatable here):**
1. Teacher creates a classroom + roster + assignment, copies the `/assignments/:id` URL.
2. Logged-out student opens it → redirected to GitHub login → lands back on the assignment page.
3. Student claims a roster name, accepts → sees repo URL + GitHub invite link → Continue reloads into the status view.
4. Student pushes commits; before the deadline the page shows "Not due yet" and no commit data.
5. After the deadline, the student reloads → sees frozen deadline commit + live latest/status.
6. Student removes their own repo access, clicks "Fix my access" → invite re-issued.
7. Teacher board shows the same frozen row; home page shows "My assignments" for the student.

---

## Self-Review (done at planning time)

- **Spec coverage:** §2.1 dual-mode → Task 8; §2.2 returnTo (sanitizer, login cookie, callback) → Tasks 1–3; §3.1 accept panel → Tasks 6 + 8; §3.2 status panel, pre-deadline GitHub-free, freeze-on-view, error degradation, resync → Tasks 7 + 8; §4 home list → Tasks 4–5; §6 test matrix → mapped 1:1 (unit sanitizer / auth integration / D1 query / component / page integration; manual walkthrough in Task 9).
- **Existing tests that change:** `assignment-page.test.ts` anonymous-redirect location and non-owner-404 — both updated deliberately in Task 8 Step 1; no other suite asserts non-owner 404 on assignment pages (`authz.test.ts` covers API endpoints, which are unchanged).
- **Type consistency:** `AcceptPanel` props (`assignmentId`, `enrolled`, `rosterOptions`) match the call in Task 8 markup; `listAssignmentsForStudentUser` return type matches the Task 5 markup fields; `RETURN_TO_COOKIE_NAME`/`sanitizeReturnTo` names are identical across Tasks 1–3.
