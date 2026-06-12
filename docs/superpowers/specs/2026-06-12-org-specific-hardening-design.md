# Org-specific deployment hardening — design

**Date:** 2026-06-12
**Status:** Approved, pending implementation plan

## Context

This deployment serves a **single GitHub org** — the one the GitHub App is
installed on. `GITHUB_APP_INSTALLATION_ID` is already in the environment and is
the single source of truth for which org we operate in. Three seams currently
contradict that reality, and all three push errors that should surface at
teacher-time onto students at accept-time (as opaque 502s):

1. **`github_org` is per-classroom free text.** Asked on the create-classroom
   form, never validated. A typo (`icspp` vs `ics-pp`) is accepted silently and
   only explodes when a student accepts.
2. **Template repos are never validated at assignment creation.** Creation only
   regex-checks `owner/name` shape. Whether the repo exists, is reachable by the
   installation, and has "Template repository" enabled is discovered only at
   accept-time — as a student-facing 502.
3. **No invite-link affordance.** The assignment page URL *is* the invite link
   (Phase 6b, Approach A), but nothing tells the teacher that or helps them share
   it.

## Goals

- Eliminate the org-typo footgun by removing org as stored/entered data entirely.
- Turn the three accept-time template failures into a friendly per-field 400 at
  assignment creation.
- Give the teacher an explicit "share this link" affordance.

## Non-goals (YAGNI)

- No env-var org override (`GITHUB_ORG`) — the installation is the source of truth.
- No grader-repo validation.
- No storing repo `html_url` on the repos table (org is resolved lazily instead).
- No retroactive data migration concerns beyond dropping the column.

---

## Item 1 — Remove `github_org`, resolve the org from the installation

The org is fully determined by the installation, so it should be neither entered
nor stored. It is resolved on demand at the GitHub-touching boundaries (which
already mint tokens and already may 502), and **classroom creation makes zero
GitHub calls** — the field simply disappears.

### New: `getInstallationOrg` + `getInstallationCreds` (`src/lib/github/app.ts`)

- `getInstallationOrg(options: AppAuthOptions): Promise<string>` — builds the app
  JWT via the existing `buildAppJwt`, calls `GET /app/installations/{installationId}`
  (app-JWT auth), returns `account.login`. Memoized per isolate keyed on
  `appId:installationId`, mirroring the existing token cache.
  `clearInstallationOrgCache()` is exported for tests.
- `getInstallationCreds(options): Promise<{ token: string; org: string }>` — a
  convenience that resolves both, since nearly every remaining token call site
  also needs the org. (The one exception, `debug/github-app.ts`, stays
  token-only.)

### Database

- Migration `0006_drop_classroom_github_org.sql`:
  `ALTER TABLE classrooms DROP COLUMN github_org;`
- `src/lib/db/classrooms.ts`: drop `githubOrg` from `Classroom`, `ClassroomRow`,
  `toClassroom`, and the `createClassroom` input + `INSERT` column list.

### Validation & API

- `classroomSchema` (`src/lib/http/schemas.ts`): remove the `github_org` field.
- `POST /api/classrooms` (`src/pages/api/classrooms/index.ts`): drop `githubOrg`
  from the `createClassroom` call. No org resolution here.

### Domain layers take an injected `org`

Both orchestrators currently read `classroom.githubOrg` via a `loadClassroom`
dep. Replace that with an injected `org` so the domain stays free of installation
knowledge:

- `src/lib/domain/evaluation.ts`: `ClassroomLite` becomes `{ id }` (existence
  check only); add `org: string` to `EvaluationDeps`; line ~147 uses `deps.org`.
- `src/lib/domain/grader-build.ts`: `ClassroomForBuild` becomes `{ id }`; add
  `org: string` to `GraderBuildDeps`; line ~110 uses `deps.org`.

### Call-site updates (resolve org alongside token)

- `buildEvaluationDeps(db, token, org)` (`api/assignments/[id]/submissions.ts`) —
  new `org` param threaded into the deps.
- Sites that resolve `{ token, org }` via `getInstallationCreds` and pass both on:
  - `api/assignments/[id]/accept.ts` — `owner` for generate + add-collaborator,
    and `repoUrlFor` in the already-accepted branch.
  - `api/assignments/[id]/submissions.ts` (GET).
  - `api/assignments/[id]/submissions/refresh.ts`.
  - `api/assignments/[id]/resync.ts` — `owner`.
  - `api/assignments/[id]/grader.ts` — `org` into `GraderBuildDeps`.
  - `pages/assignments/[id].astro` — owner branch + student post-deadline branch
    (both build `EvaluationDeps`), plus the **student "Your repo" link**, which
    needs `org` for `repoUrlFor` even pre-deadline when a repo exists. This adds a
    `getInstallationOrg` call on repo-exists student loads; the per-isolate cache
    makes all but the first essentially free.

### UI display sites

- `CreateClassroomForm.tsx`: remove the "GitHub org" input + state + field error.
- `pages/index.astro`: drop the per-classroom `{c.githubOrg}` chip (it would be
  the same org for every row).
- `pages/classrooms/[id].astro`: drop the org line in the header (this page mints
  no token; the org is implicit in a single-org deployment).
- `pages/assignments/[id].astro` student header: drop the standalone `githubOrg`
  middot, keep the repo link (now built from the resolved `org`).

---

## Item 2 — Validate the template at assignment creation

### New: `getRepoMeta` (`src/lib/github/repos.ts`)

```
getRepoMeta({ token, owner, name, fetchImpl? }): Promise<{ isTemplate: boolean } | null>
```

`GET /repos/{owner}/{name}`. Returns `{ isTemplate: data.is_template === true }`
on 200, `null` on a 404 `GitHubApiError`, rethrows any other `GitHubApiError`.

### Wiring (`POST /api/classrooms/:id/assignments`)

After `parseBody`, before `createAssignment`:

1. Resolve the installation token (`getInstallationToken`, or the token half of
   `getInstallationCreds`).
2. `splitRepo(body.template_repo)` → `{ owner, name }`.
3. `const meta = await getRepoMeta({ token, owner, name })`.
4. Map results to a per-field `ValidationError` (→ 400, field `template_repo`):
   - `meta === null` → `"Template repo not found or not accessible to the app."`
   - `meta.isTemplate === false` →
     `"Not a template repository — enable 'Template repository' in its GitHub settings."`
   - otherwise proceed to `createAssignment`.

`CreateAssignmentForm.tsx` already renders `fields.template_repo`, so no UI change
is required. A genuine GitHub outage still surfaces as the existing 502 (non-404
errors rethrow → `toResponse`).

---

## Item 3 — Invite-link affordance

### New: `src/components/CopyLinkButton.tsx`

A small client component: `url: string` prop, a readonly shadcn `Input` showing
the URL plus a `Button` that copies via `navigator.clipboard.writeText` and shows
a transient "Copied" state.

### Wiring (`pages/assignments/[id].astro`, owner branch only)

In the owner header, add a "Share with students" block rendering
`${Astro.url.origin}/assignments/${id}` through `<CopyLinkButton client:load />`.

---

## Testing

Integration harness (vitest-pool-workers v4; GitHub egress mocked via the global
miniflare `outboundService` in `github-mock.ts` — there is no `fetchMock`):

- **github-mock**: add handlers for `GET /app/installations/:id`
  (→ `{ account: { login: "<org>" } }`) and `GET /repos/:owner/:name`
  (configurable `is_template` and a 404 case).
- **Migration**: the build-generated `configPath` / per-test D1 reset must include
  `0006`; classroom rows no longer carry `github_org`.
- **Classroom create**: request body no longer includes `github_org`; assert
  creation succeeds and downstream pages/accept resolve the org from the mock.
- **Assignment create** (new): template OK → 201; `is_template:false` → 400 with
  `fields.template_repo`; 404 → 400 with `fields.template_repo`; non-404 GitHub
  error → 502.
- **Org resolution caching**: a second call within an isolate hits no second
  `GET /app/installations`.

Component-level coverage for `CopyLinkButton` is optional (clipboard is a thin
wrapper); UI verification is manual per existing convention.

## Risks / trade-offs

- Removing the column means every repo-URL/owner site now depends on a successful
  installation lookup. Mitigated by the per-isolate cache and the fact that those
  sites already depend on GitHub. The new exposure is narrow: the student
  "Your repo" link, previously free from DB, now needs the cached org.
- Two JWTs may be minted per cold isolate (one for the token, one for the org)
  until both caches warm. Negligible; both are memoized.
