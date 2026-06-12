# Phase 6a — Teacher Console (Design Spec)

**Status:** Approved design, ready for implementation planning.
**Date:** 2026-06-12
**Predecessor:** Phase 5 (Grader builder + grading decisions), merged. The backend API
surface is complete; this phase is the first UI.

> **Scope note.** Phase 6 (Frontend) is split into two sub-projects: **6a — Teacher Console**
> (this spec) and **6b — Student Flow** (a later spec: accept, roster-name claim, re-sync,
> personal deadline state). They share the stack scaffolding introduced here but have
> distinct screens and audiences.

---

## 1. Summary

The teacher console is a server-rendered Astro UI over the existing JSON APIs, using
**shadcn/ui inside React islands** for the interactive pieces. It covers the teacher's full
spine: create a classroom → manage its roster and assignments → watch the submission status
board → set per-student grading decisions → build the grader.

**Render model (decided):** Astro MPA + React islands. Each screen is a server-rendered Astro
page that reads data directly through `src/lib/db/*` (and the Phase 3 evaluation orchestrator)
in its frontmatter — the same thin-adapter pattern as the current `index.astro`. Interactive
controls are React islands that mutate through the **existing** JSON endpoints. No new JSON
endpoints are required; the only new server code is one or two `lib/db` read helpers.

## 2. Stack scaffolding

This is the first UI stack added to the Worker. One-time setup:

- **React integration:** add `@astrojs/react`, `react`, `react-dom`; register the integration
  in `astro.config.mjs`.
- **Tailwind v4:** add `@tailwindcss/vite` to the Astro config's `vite.plugins`, and a
  `src/styles/global.css` with `@import "tailwindcss";`. (Astro 6 + Tailwind v4 uses the Vite
  plugin, not `@astrojs/tailwind`.)
- **shadcn:** run `shadcn init` (Tailwind v4 / React preset) to generate `components.json`,
  the `cn` helper at `src/lib/utils.ts` (`clsx` + `tailwind-merge`), and the `@/*` → `src/*`
  path alias in `tsconfig.json`. Component source is pulled via the **shadcn MCP server**
  (`mcp__shadcn__*`) and lands in `src/components/ui/*`.
- **Component set (minimal):** `button`, `card`, `input`, `label`, `table`, `select`, `badge`,
  `textarea`. Add more only if a screen genuinely needs it.
- **Shared layout:** `src/layouts/ConsoleLayout.astro` — Tailwind base, a header showing the
  logged-in GitHub username + a logout link, and a `<slot/>` for page content.

The `@cloudflare/vitest-pool-workers` integration harness builds the Worker first
(`yarn build`); confirm the React/Tailwind build output still produces
`dist/server/wrangler.json` (the integration `configPath`, per the harness memory). No change
expected, but it is a build-shape risk to verify during implementation.

## 3. Auth & ownership gating

Every console page, in frontmatter, before rendering:

1. `const session = await requireSession(Astro.cookies, env.SESSION_SECRET);`
   `if (!session) return Astro.redirect("/auth/login");`
2. For classroom/assignment pages: load the entity, resolve its classroom, and verify
   `classroom.createdBy === session.userId`. If the entity is missing or not owned, render a
   **404 page** (a shared `NotFound` partial; do not distinguish missing vs. forbidden, to
   avoid leaking existence — consistent with `assertOwnsClassroom`).

Mutations are already owner-guarded server-side by the JSON endpoints (`assertOwnsClassroom`),
so the island calls are defense-in-depth, not the sole gate.

## 4. Screens (Astro pages)

### 4.1 `src/pages/index.astro` — Console home

- Logged out → the existing login prompt.
- Logged in → "My classrooms": `listClassroomsByOwner(env.DB, session.userId)` rendered as a
  list of shadcn `Card`s linking to `/classrooms/:id`, plus a `CreateClassroomForm` island.

### 4.2 `src/pages/classrooms/[id].astro` — Classroom detail

- Header: classroom name + GitHub org.
- **Assignments:** `listAssignmentsByClassroom(db, id)` as a list/table (title, slug, deadline,
  status, grader link if built) linking to `/assignments/:id`, plus a `CreateAssignmentForm`
  island.
- **Roster:** a `RosterPanel` island showing `listStudentsByClassroom(db, id)` (roster
  identifier, github username if linked) and a textarea to seed names.

### 4.3 `src/pages/assignments/[id].astro` — Assignment detail / status board

- Header: assignment title, slug, deadline, status, grader repo link (if `grader_repo` set).
- Frontmatter calls the **existing** `evaluateAssignmentSubmissions(deps, { assignmentId,
  now, refresh: false })` (building `deps` exactly as the GET `/api/assignments/:id/submissions`
  endpoint does: installation token via `getInstallationToken()`, the `lib/db` closures). This
  is the intended Phase 3 lazy trigger — a teacher opening the board after the deadline
  evaluates + freezes the not-yet-evaluated repos. The `EvaluationResult` (`dueState`,
  `submissions`, `errors`) is passed as initial props to the `StatusBoard` island.
- `dueState` rendering: `no-deadline` → "no deadline set" notice; `pending` → "not due yet,
  evaluation happens after the deadline"; `evaluated` → the board.

## 5. Islands (React + shadcn)

All islands are hydrated `client:load` (interactive on arrival) and mutate via `fetch` to the
existing JSON endpoints with `headers: { "content-type": "application/json" }` (required by
Astro CSRF — see the project memory). Each surfaces API errors (`{ error, fields? }`) inline.

### 5.1 `CreateClassroomForm.tsx`
Fields: `name`, `github_org`, `timezone` (default `"UTC"`). `POST /api/classrooms` → on 201,
`location.reload()`. Field errors from `fields` render under inputs.

### 5.2 `CreateAssignmentForm.tsx`
Props: `classroomId`. Fields: `slug`, `title`, `template_repo` (`owner/name`), `deadline`
(`<input type="datetime-local">`). On submit, convert the local datetime to an ISO-8601 UTC
string (`new Date(local).toISOString()`) for `deadline_at` (omit if blank). `POST
/api/classrooms/:id/assignments` → reload. Slug/shape validation errors render inline.

### 5.3 `RosterPanel.tsx`
Props: `classroomId`, `students` (initial list). A textarea (one roster entry per line) →
`POST /api/classrooms/:id/students` with the parsed list (shape per the existing students
endpoint) → reload. Lists current students with their link state.

### 5.4 `StatusBoard.tsx` (the stateful island)
Props: `assignmentId`, initial `EvaluationResult`, `graderRepo` (current, may be null). Holds
the submission rows in React state. Renders a shadcn `Table`: per student — github username,
a `status` `Badge` (`on_time` green / `late` amber / `missing` gray / `pending`), deadline
commit (short SHA + time) and latest commit, and a `Select` bound to `grade_decision`
(`at_deadline` / `accept_late` / `exclude`).

Interactions:
- **Decision change:** `PUT /api/assignments/:id/submissions/:studentId/decision`
  `{ decision }`. Optimistic local update; revert + inline error on failure.
- **Refresh:** `POST /api/assignments/:id/submissions/refresh` → replace state from the
  returned `EvaluationResult`.
- **Build grader:** `POST /api/assignments/:id/grader` → render a result panel: grader repo
  link (`graderRepo`/`htmlUrl`), the `included` list (username + pinned source
  `deadline`/`latest`), and the `skipped` list (username + reason). Build errors (e.g. 400
  "deadline not passed", 502) surface in the panel.

A small `client/api.ts` helper wraps `fetch` (JSON headers, parse `{error,fields}`,
throw a typed error) so every island shares one request path.

## 6. Data flow

- **Reads:** SSR in page frontmatter via `src/lib/db/*` and the Phase 3 evaluation
  orchestrator — no HTTP hop, consistent with the framework-agnostic-core rule (pages are thin
  adapters over `lib/*`).
- **Writes:** islands → existing JSON endpoints.
- **New server code:** `listClassroomsByOwner(db, userId)` in `src/lib/db/classrooms.ts`
  (`SELECT * FROM classrooms WHERE created_by = ?1 ORDER BY created_at DESC`). Confirm
  `listStudentsByClassroom` exists from Phase 2; add it if not.

## 7. Testing

- **Integration (D1):** `listClassroomsByOwner` returns only the caller's classrooms, newest
  first; empty for a user who owns none.
- **Pure unit:** client helpers — `datetime-local → ISO-8601 UTC`, `status → badge variant`
  mapping.
- **Component (new infra):** add `@testing-library/react` + `jsdom` as dev deps and a jsdom
  Vitest project. Test `StatusBoard`:
  - a decision `Select` change issues the `PUT` and updates the row;
  - **Refresh** swaps in the new rows from the mocked `POST /refresh` response;
  - **Build grader** renders the `included`/`skipped` result from the mocked `POST /grader`
    response, and shows the error panel on a 400.
  Mock `fetch` at the boundary. `CreateClassroomForm`/`CreateAssignmentForm`/`RosterPanel` get
  light smoke tests (renders, submits the expected payload).
- **Manual:** a `yarn dev` walkthrough (login → create classroom → create assignment → seed
  roster → open board → set a decision → refresh → build), as prior phases were verified.

## 8. File structure

**New:**
- `src/styles/global.css`, `components.json`, `src/lib/utils.ts`
- `src/components/ui/*` (shadcn: button, card, input, label, table, select, badge, textarea)
- `src/layouts/ConsoleLayout.astro`
- `src/pages/classrooms/[id].astro`, `src/pages/assignments/[id].astro`
- `src/components/CreateClassroomForm.tsx`, `CreateAssignmentForm.tsx`, `RosterPanel.tsx`,
  `StatusBoard.tsx`
- `src/components/client/api.ts` (shared fetch helper)
- Tests: `listClassroomsByOwner` (integration), client-helper unit tests, `StatusBoard`
  component tests, form smoke tests.

**Modified:**
- `astro.config.mjs` (React integration + Tailwind Vite plugin)
- `src/pages/index.astro` (logged-in home: classrooms + create)
- `src/lib/db/classrooms.ts` (+`listClassroomsByOwner`)
- `src/lib/db/students.ts` (+`listStudentsByClassroom` if missing)
- `package.json` (deps), `tsconfig.json` (`@/*` alias)
- `vitest.config.ts` / a new jsdom project for component tests

## 9. Out of scope / open items

- **Student flow (Phase 6b):** accept, roster-name claim, re-sync, personal deadline view —
  a separate spec. The shared stack scaffolding here is the foundation it builds on.
- **Realtime / polling:** the board is evaluated on load + manual Refresh; no auto-polling.
- **Pagination:** classroom/assignment/roster lists render in full (MVP class sizes). Revisit
  if a list grows large.
- **Styling depth:** functional shadcn defaults; no bespoke theming beyond the shadcn base.
- **Build-shape risk:** verify the React/Tailwind build still emits `dist/server/wrangler.json`
  for the integration harness `configPath` (§2).
