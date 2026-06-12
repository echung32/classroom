# Phase 6b — Student Flow (Design Spec)

**Status:** Approved design, ready for implementation planning.
**Date:** 2026-06-12
**Predecessor:** Phase 6a (Teacher Console), merged. The UI stack (React islands, shadcn,
Tailwind v4, `ConsoleLayout`, the jsdom component-test project) and all student-facing JSON
endpoints (accept, re-sync, roster) already exist; this phase is UI plus two small server
additions.

---

## 1. Summary

Phase 6b gives students a way in. The model is **hybrid**: the teacher shares the assignment
page URL as an invite link (GitHub Classroom style), and returning students additionally see a
"My assignments" list on the console home. The assignment page becomes **dual-mode** — owners
get the existing teacher StatusBoard unchanged; any other logged-in user gets the student
view: an accept panel (with roster-name claim) before they have a repo, and a personal live
status panel after.

**Decisions made during brainstorming:**

- **Entry model — hybrid.** Invite link (the plain `/assignments/:id` URL) for first contact;
  a home-page "My assignments" section for returning students.
- **Student status — live self-evaluation.** The student's page load computes their current
  state from GitHub, not just a cached row.
- **Freeze on view.** After the deadline, a student's own page load runs the same evaluation
  path as the teacher board and freezes their `deadline_sha` on first look (idempotent
  COALESCE upsert, Phase 3 semantics). Whoever looks first — teacher or student — pins the
  submission, shrinking the post-deadline force-push window. One code path, one source of
  truth.
- **Routing — dual-mode `/assignments/:id`** (Approach A). One shareable URL; the
  "404 for non-owners" rule relaxes for assignment pages only. Anyone authenticated with the
  link can see title/deadline and join — exactly invite-link semantics. Classroom pages keep
  their strict owner-404. Tokenized/revocable invites were considered and rejected (YAGNI;
  assignment IDs are UUIDs, so links are not guessable).

## 2. Routing & auth

### 2.1 Dual-mode assignment page

`src/pages/assignments/[id].astro` frontmatter branches:

1. No session → `return Astro.redirect("/auth/login?returnTo=/assignments/" + id)`.
2. Assignment missing → 404 (`NotFound`), as today.
3. Session is the classroom owner → existing teacher board, **unchanged**.
4. Any other session → student view (§3).

### 2.2 Login `returnTo`

Today `/auth/callback` always redirects to `/`, so a logged-out student clicking an invite
link would land on the home page and lose the assignment. Fix:

- `/auth/login` accepts an optional `returnTo` query param. If present and valid, store it in
  a short-lived cookie (`httpOnly`, `secure`, `sameSite: lax`, same TTL as the OAuth state
  cookie) alongside the state cookie.
- `/auth/callback`, on success, reads + deletes the cookie and redirects to its value;
  otherwise `/`. Error paths keep redirecting to `/?error=…`.
- **Sanitizer (pure function, `src/lib/auth/oauth.ts`):**
  `sanitizeReturnTo(value: string | null | undefined): string` — returns `value` only if it
  starts with `/` and not `//` (same-origin path, blocks `//evil.com` and absolute URLs);
  otherwise `/`. Applied both when setting the cookie and when reading it.

## 3. Student view (`/assignments/:id`, non-owner session)

Frontmatter resolves enrollment with existing helpers — no HTTP hop, no new queries:
`findStudentByUser(db, assignment.classroomId, session.userId)` →
`getRepoByAssignmentStudent(db, assignment.id, student.id)` (when enrolled).

Header in both states: assignment title, classroom name + GitHub org, deadline (or
"no deadline").

### 3.1 Not accepted (no repo row) — accept panel

- Frontmatter also loads `listUnclaimedStudents(db, assignment.classroomId)` when the user is
  not yet enrolled.
- **`AcceptPanel.tsx` island** (`client:load`), props: `assignmentId`, `enrolled: boolean`,
  `rosterOptions: { id: string; rosterIdentifier: string | null }[]`.
  - Not enrolled: a shadcn `Select` of unclaimed roster entries plus an
    **"I'm not on the list"** choice (sends no `rosterStudentId` → fresh bare row, the
    existing skip path), and an **Accept assignment** button.
  - Already enrolled (claimed via an earlier assignment): no select, just the button —
    `resolveStudentForAccept` reuses the existing student row.
  - Submit: `POST /api/assignments/:id/accept` (JSON content-type, via the shared
    `client/api.ts` helper) with `{ rosterStudentId? }`.
  - On 201: show the repo URL and, when present, the GitHub `invitationUrl` with copy
    "accept the invite on GitHub to get push access", then a button/reload into the status
    view. `status: "already_accepted"` renders the same success state.
  - Errors inline: 409 claim conflicts (row already claimed / already enrolled) re-render the
    panel with the message; 502 (GitHub down) shows a retry note.

### 3.2 Accepted (repo exists) — personal status panel

Server-rendered (the only island is the re-sync button):

- Always: repo link (`https://github.com/{org}/{repoName}`), deadline.
- **Pre-deadline / no deadline:** "not due yet — keep pushing to your repo" / "this
  assignment has no deadline". No GitHub calls (the evaluator returns `pending` /
  `no-deadline` without reading GitHub).
- **Post-deadline — single-student live evaluation:** frontmatter builds deps exactly as the
  teacher page does (`buildEvaluationDeps(env.DB, token)`), then wraps `listRepos` to return
  only this student's repo row:

  ```ts
  const deps = buildEvaluationDeps(env.DB, token);
  const result = await evaluateAssignmentSubmissions(
    { ...deps, listRepos: async (id) => (await deps.listRepos(id)).filter((r) => r.studentId === student.id) },
    { assignmentId: assignment.id, now: new Date().toISOString(), refresh: true },
  );
  ```

  Zero changes to `evaluation.ts`. `refresh: true` makes the view live (latest commit
  re-read, status re-classified on every load) while `deadline_sha` stays frozen per
  Phase 3 — and the student's first post-deadline look performs the freeze.
- Renders their single `SubmissionView`: status `Badge` (same variant mapping as the teacher
  board), deadline commit (short SHA + time), latest commit, evaluated-at. `grade_decision`
  is **not** shown (teacher-private).
- Evaluation failure degrades like the teacher page: token mint or per-repo error → an
  inline "GitHub unreachable / couldn't read your repo" note; repo link and deadline still
  render.
- **`ResyncButton.tsx` island**, props: `assignmentId`. "Fix my access" button →
  `POST /api/assignments/:id/resync` → renders the returned `status` and `invitationUrl`
  (when a new invite was issued) inline; API errors inline.

## 4. Console home — "My assignments"

New query in `src/lib/db/assignments.ts`:

```ts
listAssignmentsForStudentUser(db, userId): Promise<{
  assignmentId: string; title: string; slug: string; deadlineAt: string | null;
  classroomName: string; accepted: boolean;
}[]>
```

`students` (by `user_id`) → join `assignments` on `classroom_id` → join `classrooms` for the
name → left-join `repos` on `(assignment_id, student_id)`; `accepted = repo IS NOT NULL`.
Ordered by `deadline_at` ascending, NULLs last (or `created_at` as tiebreaker).

`src/pages/index.astro`: render a **"My assignments"** section (only when the list is
non-empty) below "My classrooms", each row showing title, classroom name, deadline, and an
"accepted" / "not accepted" badge, linking to `/assignments/:id`. The teacher section is
untouched; a user who is both teacher and student sees both sections.

## 5. New code inventory

**New files:**
- `src/components/AcceptPanel.tsx`, `src/components/ResyncButton.tsx`
- Tests (see §6)

**Modified:**
- `src/pages/assignments/[id].astro` — dual-mode branch + student view markup
- `src/pages/index.astro` — "My assignments" section
- `src/pages/auth/login.ts`, `src/pages/auth/callback.ts` — `returnTo` cookie
- `src/lib/auth/oauth.ts` — `sanitizeReturnTo` + returnTo cookie name/TTL constants
- `src/lib/db/assignments.ts` — `listAssignmentsForStudentUser`

**No new endpoints. No migrations.** All mutations go through the existing Phase 2 endpoints.

## 6. Testing

- **Integration (D1):** `listAssignmentsForStudentUser` — returns only classrooms the user is
  enrolled in, `accepted` flag reflects repo existence, empty for non-students.
- **Integration (auth):** `/auth/login?returnTo=/assignments/x` sets the returnTo cookie;
  callback success redirects to it; `returnTo=https://evil.com` and `//evil.com` fall back
  to `/`.
- **Pure unit:** `sanitizeReturnTo` (valid path, absolute URL, protocol-relative, empty,
  missing).
- **Component (existing jsdom project):** `AcceptPanel` — claim submit sends
  `rosterStudentId`, skip path omits it, 409 renders inline error, success renders repo +
  invitation links; enrolled mode hides the select. `ResyncButton` — smoke (posts, renders
  returned status/invitation).
- **Manual:** two-browser walkthrough — teacher shares the assignment URL; logged-out student
  follows it, logs in, lands back on the page, claims a roster name, accepts, gets the repo;
  pushes; after the deadline reloads and sees the frozen/live status; breaks access and
  recovers via re-sync; teacher board shows the same frozen row.

## 7. Out of scope

- **Tokenized/revocable invite links** — plain assignment URLs are the invite (UUIDs, not
  guessable). Revisit if link leakage becomes a real problem.
- **Grade visibility** — `grade_decision` and grader-repo details stay teacher-private.
- **Notifications, polling, pagination** — same posture as 6a.
- **Pre-deadline live commit display** — before the deadline the page shows no commit data
  (the student's own GitHub repo page already shows their pushes); keeps pre-deadline page
  loads GitHub-free.
