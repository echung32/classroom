# Org-specific Deployment Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this a true single-org deployment: remove the per-classroom `github_org` (resolve it from the GitHub App installation), validate template repos at assignment-creation time, and give teachers an explicit student invite-link affordance.

**Architecture:** The org is fully determined by `GITHUB_APP_INSTALLATION_ID`, so it is resolved on demand at the GitHub-touching boundaries via a cached `getInstallationOrg` and never stored or entered. Template existence/access/`is_template` is checked with one `GET /repos/{owner}/{name}` at assignment creation, converting student-facing 502s into per-field 400s. The assignment page (which already *is* the invite link) gains a copy-link control.

**Tech Stack:** Astro + Cloudflare Workers, D1 (SQLite), valibot, React/shadcn islands, vitest (`vitest-pool-workers` v4) with GitHub egress mocked via a miniflare `outboundService` (`test/integration/github-mock.ts`).

**Spec:** `docs/superpowers/specs/2026-06-12-org-specific-hardening-design.md`

**Sequencing note:** Tasks 1–4 are purely additive and leave the suite green at each commit. Task 5 (removing the `github_org` column) is an atomic cross-cutting change — production code and all affected tests are edited together and committed once, when green.

---

## File Structure

**New files:**
- `migrations/0006_drop_classroom_github_org.sql` — drop the column.
- `src/components/CopyLinkButton.tsx` — clipboard copy control for the invite link.

**Modified — production:**
- `src/lib/github/app.ts` — add `getInstallationOrg` + `getInstallationCreds` (+ cache/clear).
- `src/lib/github/repos.ts` — add `getRepoMeta`.
- `src/lib/db/classrooms.ts` — drop `githubOrg` from type/row/insert.
- `src/lib/http/schemas.ts` — drop `github_org` from `classroomSchema`.
- `src/lib/domain/evaluation.ts`, `src/lib/domain/grader-build.ts` — inject `org` into deps instead of reading `loadClassroom().githubOrg`.
- `src/pages/api/classrooms/index.ts` — stop passing `githubOrg`.
- `src/pages/api/classrooms/[id]/assignments.ts` — validate template at creation.
- `src/pages/api/assignments/[id]/{accept,resync,grader,submissions}.ts`, `.../submissions/refresh.ts` — resolve org from creds.
- `src/pages/assignments/[id].astro` — creds for eval, org for student repo link, invite link in owner header, drop org chip.
- `src/components/CreateClassroomForm.tsx`, `src/pages/index.astro`, `src/pages/classrooms/[id].astro` — drop org input/display.

**Modified — tests:**
- `test/integration/github-mock.ts` — add `GET /app/installations/:id` and `GET /repos/:owner/:name` handlers.
- `test/unit/app.test.ts`, `test/unit/github-repos.test.ts`, `test/unit/validation.test.ts`, `test/unit/evaluation.test.ts`, `test/unit/grader-build.test.ts` — new helper tests + deps shape.
- `test/client/create-classroom-form.test.tsx` — drop org field.
- `test/integration/*` — drop `githubOrg` from `createClassroom` calls; new assignment-create + invite-link cases; remove the index-page org-display assertion.

---

## Task 1: `getInstallationOrg` + `getInstallationCreds`

**Files:**
- Modify: `src/lib/github/app.ts`
- Modify: `test/unit/app.test.ts`
- Modify: `test/integration/github-mock.ts`

- [ ] **Step 1: Add the failing unit tests**

Append to `test/unit/app.test.ts` (it already defines `generateTestKeyPair`, `NOW`, and imports from `../../src/lib/github/app`). Add `clearInstallationOrgCache`, `getInstallationOrg`, `getInstallationCreds` to the existing import block, then add:

```ts
describe("getInstallationOrg cache", () => {
  beforeEach(() => clearInstallationOrgCache());

  function orgFetch(login: string) {
    return vi.fn(
      async () =>
        new Response(JSON.stringify({ account: { login } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  }

  it("resolves account.login from GET /app/installations/:id", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const fetchImpl = orgFetch("acme-org");
    const org = await getInstallationOrg({
      appId: "1", privateKey: privateKeyPem, installationId: "42", fetchImpl, nowSeconds: NOW,
    });
    expect(org).toBe("acme-org");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/42");
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("caches per appId:installationId within the isolate", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const fetchImpl = orgFetch("acme-org");
    const base = { appId: "1", privateKey: privateKeyPem, installationId: "42", fetchImpl, nowSeconds: NOW };
    await getInstallationOrg(base);
    await getInstallationOrg(base);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not serve an org cached for a different installation", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const fetchImpl = orgFetch("acme-org");
    await getInstallationOrg({ appId: "1", privateKey: privateKeyPem, installationId: "42", fetchImpl, nowSeconds: NOW });
    await getInstallationOrg({ appId: "1", privateKey: privateKeyPem, installationId: "99", fetchImpl, nowSeconds: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit -t "getInstallationOrg cache"`
Expected: FAIL — `getInstallationOrg`/`clearInstallationOrgCache` are not exported.

- [ ] **Step 3: Implement the helpers**

In `src/lib/github/app.ts`, after `clearInstallationTokenCache` (end of file), add:

```ts
// Org login is stable for the life of an installation, so no TTL — cache for the
// isolate's lifetime, keyed like the token cache.
let cachedOrg: { key: string; org: string } | null = null;

/** The org (account.login) the app is installed on. Cached per isolate. */
export async function getInstallationOrg(options: AppAuthOptions): Promise<string> {
  const key = `${options.appId}:${options.installationId}`;
  if (cachedOrg && cachedOrg.key === key) return cachedOrg.org;
  const jwt = await buildAppJwt(options);
  const { data } = await githubRequest<{ account: { login: string } | null }>(
    `/app/installations/${options.installationId}`,
    { token: jwt, fetchImpl: options.fetchImpl },
  );
  const login = data.account?.login;
  if (!login) throw new Error("Installation response had no account.login");
  cachedOrg = { key, org: login };
  return login;
}

export function clearInstallationOrgCache(): void {
  cachedOrg = null;
}

/** Token + org together — most GitHub-touching routes need both. */
export async function getInstallationCreds(
  options: AppAuthOptions,
): Promise<{ token: string; org: string }> {
  const [token, org] = await Promise.all([
    getInstallationToken(options),
    getInstallationOrg(options),
  ]);
  return { token, org };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit -t "getInstallationOrg cache"`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the integration mock handler**

In `test/integration/github-mock.ts`, immediately after the access_tokens branch (the `if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/...` block), add:

```ts
  // Installation metadata: the single org this deployment operates on.
  if (method === "GET" && /^\/app\/installations\/\d+$/.test(path)) {
    return jsonResponse(200, { account: { login: "test-org" } });
  }
```

(Placed before the access_tokens regex is fine too; the two patterns are disjoint — the GET has no `/access_tokens` suffix.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/github/app.ts test/unit/app.test.ts test/integration/github-mock.ts
git commit -m "feat: resolve the installation org via GitHub App (cached)"
```

---

## Task 2: `getRepoMeta` template lookup

**Files:**
- Modify: `src/lib/github/repos.ts`
- Modify: `test/unit/github-repos.test.ts`
- Modify: `test/integration/github-mock.ts`

- [ ] **Step 1: Add the failing unit tests**

Append to `test/unit/github-repos.test.ts` (add `getRepoMeta` to the existing import from `../../src/lib/github/repos`):

```ts
describe("getRepoMeta", () => {
  it("returns isTemplate:true for a template repo", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ is_template: true }, 200));
    const meta = await getRepoMeta({ token: "ghs_x", owner: "org", name: "hw1-template", fetchImpl });
    expect(meta).toEqual({ isTemplate: true });
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe("https://api.github.com/repos/org/hw1-template");
  });

  it("returns isTemplate:false when the repo is not a template", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ is_template: false }, 200));
    expect(await getRepoMeta({ token: "ghs_x", owner: "org", name: "plain", fetchImpl })).toEqual({
      isTemplate: false,
    });
  });

  it("returns null on 404 (missing or inaccessible)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404));
    expect(await getRepoMeta({ token: "ghs_x", owner: "org", name: "ghost", fetchImpl })).toBeNull();
  });

  it("rethrows non-404 GitHub errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "boom" }, 500));
    await expect(
      getRepoMeta({ token: "ghs_x", owner: "org", name: "x", fetchImpl }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit -t getRepoMeta`
Expected: FAIL — `getRepoMeta` is not exported.

- [ ] **Step 3: Implement `getRepoMeta`**

In `src/lib/github/repos.ts` (it already imports `GitHubApiError, githubRequest`), add at the end:

```ts
/**
 * Look up a repo's template-readiness at assignment-creation time. Returns null
 * when GitHub answers 404 (repo missing or not visible to the installation) so
 * the caller can map it to a friendly 400; rethrows any other GitHub error.
 */
export async function getRepoMeta(input: {
  token: string;
  owner: string;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<{ isTemplate: boolean } | null> {
  const { token, owner, name, fetchImpl } = input;
  try {
    const { data } = await githubRequest<{ is_template?: boolean }>(
      `/repos/${owner}/${name}`,
      { token, fetchImpl },
    );
    return { isTemplate: data.is_template === true };
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return null;
    throw err;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit -t getRepoMeta`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the integration mock handler**

In `test/integration/github-mock.ts`, add a `GET /repos/{owner}/{name}` branch. Put it just before the final `return new Response(\`unmocked ...\`)` line:

```ts
  // GET /repos/{owner}/{name} — template validation at assignment creation, and
  // the createRepoFromTemplate 422-recovery GET. Conventions by repo name:
  // "not-a-template" → is_template:false; "ghost" → 404; else a ready template.
  const repoMeta = path.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (method === "GET" && repoMeta) {
    const [, owner, name] = repoMeta;
    if (/ghost/i.test(name)) return jsonResponse(404, { message: "Not Found" });
    return jsonResponse(200, {
      id: 200,
      full_name: `${owner}/${name}`,
      html_url: `https://github.com/${owner}/${name}`,
      is_template: !/not-a-template/i.test(name),
    });
  }
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/github/repos.ts test/unit/github-repos.test.ts test/integration/github-mock.ts
git commit -m "feat: add getRepoMeta for template validation"
```

---

## Task 3: Validate the template at assignment creation

**Files:**
- Modify: `src/pages/api/classrooms/[id]/assignments.ts`
- Modify: `test/integration/assignments-api.test.ts`

- [ ] **Step 1: Add failing integration tests**

In `test/integration/assignments-api.test.ts`, add these cases inside the `describe("POST /api/classrooms/:id/assignments", ...)` block (after the invalid-slug test). They rely on the Task 2 mock conventions:

```ts
  it("rejects a non-template repo with a template_repo field message (400)", async () => {
    const { classroom, cookie } = await ownedClassroom();
    const res = await postAssignment(
      classroom.id,
      { ...VALID, template_repo: "my-org/not-a-template" },
      cookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { fields?: Record<string, string> } };
    expect(body.error.fields).toHaveProperty("template_repo");
  });

  it("rejects a missing/inaccessible template repo (400)", async () => {
    const { classroom, cookie } = await ownedClassroom();
    const res = await postAssignment(
      classroom.id,
      { ...VALID, template_repo: "my-org/ghost-repo" },
      cookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { fields?: Record<string, string> } };
    expect(body.error.fields).toHaveProperty("template_repo");
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test:integration -t "POST /api/classrooms/:id/assignments"`
Expected: FAIL — both return 201 (no validation yet).

- [ ] **Step 3: Wire validation into the route**

Replace the body of `src/pages/api/classrooms/[id]/assignments.ts` with:

```ts
import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { createAssignment } from "../../../../lib/db/assignments";
import { assertOwnsClassroom } from "../../../../lib/domain/authz";
import { splitRepo } from "../../../../lib/domain/slug";
import { getInstallationToken } from "../../../../lib/github/app";
import { getRepoMeta } from "../../../../lib/github/repos";
import { ValidationError, toResponse } from "../../../../lib/http/errors";
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

    // Validate the template now (teacher-time) instead of letting it fail at
    // student-accept time as an opaque 502.
    const token = await getInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });
    const [owner, name] = splitRepo(body.template_repo);
    const meta = await getRepoMeta({ token, owner, name });
    if (meta === null) {
      const msg = "Template repo not found or not accessible to the app";
      throw new ValidationError(msg, { template_repo: msg });
    }
    if (!meta.isTemplate) {
      const msg = "Not a template repository — enable 'Template repository' in its GitHub settings";
      throw new ValidationError(msg, { template_repo: msg });
    }

    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: body.slug,
      title: body.title,
      templateRepo: body.template_repo,
      deadlineAt: body.deadline_at,
    });
    return json(assignment, 201);
  } catch (err) {
    return toResponse(err);
  }
};
```

- [ ] **Step 4: Run the assignment-create tests to verify they pass**

Run: `yarn test:integration -t "POST /api/classrooms/:id/assignments"`
Expected: PASS — new 400 cases pass; existing 201/409/401/403/slug cases still pass (default template name → `is_template:true`).

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/classrooms/[id]/assignments.ts test/integration/assignments-api.test.ts
git commit -m "feat: validate template repo at assignment creation"
```

---

## Task 4: Invite-link affordance

**Files:**
- Create: `src/components/CopyLinkButton.tsx`
- Modify: `src/pages/assignments/[id].astro`
- Modify: `test/integration/assignment-page.test.ts`

- [ ] **Step 1: Create the component**

`src/components/CopyLinkButton.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={url} aria-label="Invite link" className="font-mono text-xs" />
      <Button type="button" variant="secondary" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Add the failing integration test**

In `test/integration/assignment-page.test.ts`, add a case asserting the owner sees the invite link. Use the file's existing seed helpers (an owner cookie + an assignment). Mirror an existing owner-view test's setup, then assert:

```ts
  it("shows the teacher a shareable invite link with the assignment URL", async () => {
    const { cookie, assignment } = await seedOwnerAssignment(); // existing helper in this file
    const res = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie },
    });
    const html = await res.text();
    expect(html).toContain("Share with students");
    expect(html).toContain(`https://example.com/assignments/${assignment.id}`);
  });
```

> If this file has no `seedOwnerAssignment` helper, replicate the seed used by the nearest existing owner-branch test in the same file (create user+cookie, `createClassroom` **without** `githubOrg` once Task 5 lands, `createAssignment`), and reuse that assignment id. Until Task 5, keep `githubOrg` in the seed so the suite stays green.

- [ ] **Step 3: Run to verify it fails**

Run: `yarn test:integration -t "shareable invite link"`
Expected: FAIL — "Share with students" not present.

- [ ] **Step 4: Render the invite link in the owner header**

In `src/pages/assignments/[id].astro`:

Add to the import block:

```ts
import CopyLinkButton from "../../components/CopyLinkButton";
```

In the **owner** branch `<header>` (the block that renders `{assignment!.title}` for `owned`), after the slug/deadline `<p>` (and the optional grader link), add:

```astro
        <div class="mt-3 space-y-1">
          <p class="text-sm font-medium">Share with students</p>
          <CopyLinkButton client:load url={`${Astro.url.origin}/assignments/${id}`} />
        </div>
```

- [ ] **Step 5: Run to verify it passes**

Run: `yarn test:integration -t "shareable invite link"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/CopyLinkButton.tsx src/pages/assignments/[id].astro test/integration/assignment-page.test.ts
git commit -m "feat: add student invite-link affordance to assignment page"
```

---

## Task 5: Remove the `github_org` column (atomic)

This task removes the column and rewires every reader to the installation-resolved org. Make **all** edits (production + tests) before running the suite; commit once green. Mock org login is `test-org` (Task 1), which matches the repo-URL assertions already in the integration suite.

**Files — production:**
- Create: `migrations/0006_drop_classroom_github_org.sql`
- Modify: `src/lib/db/classrooms.ts`, `src/lib/http/schemas.ts`,
  `src/pages/api/classrooms/index.ts`, `src/components/CreateClassroomForm.tsx`,
  `src/lib/domain/evaluation.ts`, `src/lib/domain/grader-build.ts`,
  `src/pages/api/assignments/[id]/submissions.ts`,
  `src/pages/api/assignments/[id]/submissions/refresh.ts`,
  `src/pages/api/assignments/[id]/accept.ts`,
  `src/pages/api/assignments/[id]/resync.ts`,
  `src/pages/api/assignments/[id]/grader.ts`,
  `src/pages/assignments/[id].astro`, `src/pages/index.astro`,
  `src/pages/classrooms/[id].astro`

**Files — tests:** `test/unit/validation.test.ts`, `test/unit/evaluation.test.ts`,
  `test/unit/grader-build.test.ts`, `test/client/create-classroom-form.test.tsx`,
  `test/integration/classrooms-db.test.ts`, `test/integration/index-page.test.ts`,
  and every integration file that calls `createClassroom({ githubOrg })`.

- [ ] **Step 1: Migration**

Create `migrations/0006_drop_classroom_github_org.sql`:

```sql
-- Single-org deployment: the org is resolved from the GitHub App installation,
-- never stored. Drop the unused, never-validated per-classroom column.
ALTER TABLE classrooms DROP COLUMN github_org;
```

- [ ] **Step 2: DB layer** — `src/lib/db/classrooms.ts`

Remove `githubOrg` from the `Classroom` interface and `ClassroomRow`; drop the `githubOrg: row.github_org,` line in `toClassroom`; and update `createClassroom`:

```ts
export async function createClassroom(
  db: D1Database,
  input: { name: string; timezone: string; createdBy: string },
): Promise<Classroom> {
  const row = await db
    .prepare(
      `INSERT INTO classrooms (id, name, timezone, created_by)
       VALUES (?1, ?2, ?3, ?4)
       RETURNING *`,
    )
    .bind(crypto.randomUUID(), input.name, input.timezone, input.createdBy)
    .first<ClassroomRow>();
  if (!row) throw new Error("createClassroom: INSERT ... RETURNING produced no row");
  return toClassroom(row);
}
```

- [ ] **Step 3: Schema** — `src/lib/http/schemas.ts`

Delete the `github_org: v.pipe(...)` line from `classroomSchema` (leave `name` and `timezone`).

- [ ] **Step 4: Classroom create route** — `src/pages/api/classrooms/index.ts`

In the `createClassroom` call, remove `githubOrg: body.github_org,` (keep `name`, `timezone`, `createdBy`).

- [ ] **Step 5: Create-classroom form** — `src/components/CreateClassroomForm.tsx`

Remove the `githubOrg` state (`const [githubOrg, setGithubOrg] = useState("")`), drop `github_org: githubOrg` from the POST body (send `{ name, timezone }`), and delete the entire "GitHub org" `<div className="space-y-1">…</div>` block (label + input + `fields.github_org` error).

- [ ] **Step 6: Evaluation domain** — `src/lib/domain/evaluation.ts`

Change `interface ClassroomLite` to `{ id: string }` (remove `githubOrg`). Add `org: string;` to `EvaluationDeps`. Change the `readRepoCommitState` call's `owner: classroom.githubOrg` to `owner: deps.org`.

- [ ] **Step 7: Grader-build domain** — `src/lib/domain/grader-build.ts`

Change `interface ClassroomForBuild` to `{ id: string }`. Add `org: string;` to `GraderBuildDeps`. Change `const org = classroom.githubOrg;` (line ~110) to `const org = deps.org;`. (Keep the `loadClassroom` existence check at lines ~101–102.)

- [ ] **Step 8: `buildEvaluationDeps`** — `src/pages/api/assignments/[id]/submissions.ts`

Add an `org` parameter and include it in the deps:

```ts
export function buildEvaluationDeps(db: EnvDb, token: string, org: string): EvaluationDeps {
  return {
    token,
    org,
    loadAssignment: (id) => getAssignmentById(db, id),
    loadClassroom: (id) => getClassroomById(db, id),
    listRepos: (assignmentId) => listReposWithStudentsByAssignment(db, assignmentId),
    getSubmission: (assignmentId, studentId) => getSubmission(db, assignmentId, studentId),
    freezeSubmission: (input) => freezeSubmission(db, input),
    refreshSubmissionStatus: (input) => refreshSubmissionStatus(db, input),
  };
}
```

In this file's `GET` handler, replace the `getInstallationToken({...})` call with creds and pass org. Change the import `getInstallationToken` → `getInstallationCreds`, then:

```ts
    const { token, org } = await getInstallationCreds({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });

    const result = await evaluateAssignmentSubmissions(buildEvaluationDeps(env.DB, token, org), {
```

- [ ] **Step 9: Refresh route** — `src/pages/api/assignments/[id]/submissions/refresh.ts`

Swap `getInstallationToken` → `getInstallationCreds`, destructure `{ token, org }`, and pass `buildEvaluationDeps(env.DB, token, org)` (mirroring Step 8's two edits).

- [ ] **Step 10: Accept route** — `src/pages/api/assignments/[id]/accept.ts`

Resolve the org up front so the idempotency short-circuit can build the repo URL without minting a token. Change the import `getInstallationToken` → `getInstallationCreds` is **not** ideal here (the early-return path must avoid the token mint). Instead add `getInstallationOrg` to the import and:

1. After loading `classroom`, before the `existing` short-circuit, add:

```ts
    const org = await getInstallationOrg({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });
```

2. Update the comment above `existing` from "makes zero GitHub calls" to "mints no token and writes nothing (only a cached org lookup)".
3. Replace the three `classroom.githubOrg` usages with `org` (the `repoUrlFor` in the `existing` branch, and the two `owner:` fields for generate + add-collaborator).

Import line becomes:

```ts
import { getInstallationOrg, getInstallationToken } from "../../../../lib/github/app";
```

- [ ] **Step 11: Resync route** — `src/pages/api/assignments/[id]/resync.ts`

Change the import `getInstallationToken` → `getInstallationCreds`, replace the token mint with:

```ts
    const { token, org } = await getInstallationCreds({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });
```

and change `owner: classroom.githubOrg,` to `owner: org,`.

- [ ] **Step 12: Grader route** — `src/pages/api/assignments/[id]/grader.ts`

Change the import `getInstallationToken` → `getInstallationCreds`, replace the token mint with the `{ token, org }` creds block (as in Step 11), and add `org,` to the `buildGrader` deps object (next to `token,`).

- [ ] **Step 13: Assignment page** — `src/pages/assignments/[id].astro`

(a) Import: add `getInstallationCreds` and `getInstallationOrg`; keep `getInstallationToken` only if still referenced (it is in the student post-deadline branch — change that too, see (c)).

(b) **Owner branch:** replace the `getInstallationToken({...})` call with:

```ts
    const { token, org } = await getInstallationCreds({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });
    evaluation = await evaluateAssignmentSubmissions(buildEvaluationDeps(env.DB, token, org), {
```

(c) **Student branch:** add a `studentOrg` variable. In the `else` (repo exists) block, before computing `deadlinePassed`, resolve the org (needed for the repo link even pre-deadline):

```ts
    studentOrg = await getInstallationOrg({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });
```

Declare it alongside the other student `let`s near the top: `let studentOrg = "";`. In the post-deadline `try`, replace `getInstallationToken({...})` with `getInstallationCreds({...})` destructured as `{ token, org }` and call `buildEvaluationDeps(env.DB, token, org)`.

(d) **Template edits:** in the student `<header>`, remove the `&middot; {classroom!.githubOrg}` segment (keep `{classroom!.name}` and the deadline). Replace `repoUrlFor(classroom!.githubOrg, repo.repoName)` with `repoUrlFor(studentOrg, repo.repoName)` and `{classroom!.githubOrg}/{repo.repoName}` with `{studentOrg}/{repo.repoName}`.

- [ ] **Step 14: Index + classroom pages**

`src/pages/index.astro`: delete the `<span class="ml-2 text-sm text-muted-foreground">{c.githubOrg}</span>` line.

`src/pages/classrooms/[id].astro`: delete the header `<p class="text-sm text-muted-foreground">{classroom!.githubOrg}</p>` line.

- [ ] **Step 15: Unit tests — schema, evaluation deps, grader-build deps**

`test/unit/validation.test.ts`:
- Line ~16–17: `parseBody(req({ name: "CS101" }), classroomSchema)` and `expect(out).toEqual({ name: "CS101", timezone: "UTC" })`.
- Line ~21–24: drop `github_org: "my-org",` from the input.
- Line ~28–38 ("rejects a blank name, blank org, and bad timezone"): rename to "rejects a blank name and bad timezone"; first assertion `req({ name: "" })`; second `req({ name: "CS101", timezone: "Mars/Phobos" })`.

`test/unit/evaluation.test.ts` (line ~32): change `loadClassroom: vi.fn(async () => ({ id: "c1", githubOrg: "org" }))` to `loadClassroom: vi.fn(async () => ({ id: "c1" }))` and add `org: "org",` to the deps object.

`test/unit/grader-build.test.ts` (line ~17): change `loadClassroom: vi.fn(async () => ({ id: "c1", githubOrg: "org" }))` to `loadClassroom: vi.fn(async () => ({ id: "c1" }))` and add `org: "org",` to the deps object. (The line-41 assertion `org: "org"` still holds.)

- [ ] **Step 16: Client test — create-classroom form**

`test/client/create-classroom-form.test.tsx`:
- First test: delete the `await user.type(screen.getByLabelText("GitHub org"), "my-org");` line; change the expected body to `JSON.stringify({ name: "CS101", timezone: "UTC" })`.
- Second test ("renders per-field errors"): change the mocked error `fields` to a field the form still renders, e.g. `{ name: "name is required" }`, and assert `screen.findByText("name is required")`.

- [ ] **Step 17: Integration tests — drop `githubOrg` from every `createClassroom` call**

In every integration file that calls `createClassroom`, delete the `githubOrg: "…",` property (the value is irrelevant now). Files: `classrooms-db.test.ts`, `classrooms-api.test.ts`, `assignments-api.test.ts`, `assignments-db.test.ts`, `accept-api.test.ts`, `resync-api.test.ts`, `submissions-api.test.ts`, `submissions-db.test.ts`, `students-api.test.ts`, `roster-api.test.ts`, `decision-api.test.ts`, `grader-api.test.ts`, `authz.test.ts`, `classroom-page.test.ts`, `assignment-page.test.ts`, `index-page.test.ts`.

Find them all with:

```bash
grep -rn "githubOrg:" test/integration
```

- [ ] **Step 18: Integration tests — fix the two org-specific assertions**

`test/integration/classrooms-db.test.ts`: delete the `expect(classroom.githubOrg).toBe("my-org");` assertion (line ~18).

`test/integration/index-page.test.ts`: delete the `expect(html).toContain("my-org");` assertion (line ~67) — the org chip is gone. The `createClassroom` call in that test loses `githubOrg` per Step 17.

- [ ] **Step 19: Typecheck**

Run: `yarn typecheck`
Expected: PASS — no remaining references to `githubOrg`/`github_org`. If the checker still finds one, fix it (grep `git grep -n "githubOrg\|github_org" src test`).

- [ ] **Step 20: Full test suite**

Run: `yarn test`
Expected: PASS — unit, client, and integration. The integration suite rebuilds (`yarn build`) so migration `0006` and `TEST_MIGRATIONS` pick up the dropped column; org-derived repo URLs resolve to `test-org` from the installation mock.

> Known-environmental: the `DEBUG_ROUTES` index-page 404 integration test may fail locally because `.dev.vars` sets `DEBUG_ROUTES=1` — this is pre-existing and unrelated (see memory `index-page-debug-test-local-failure`).

- [ ] **Step 21: Commit**

```bash
git add -A
git commit -m "refactor: remove github_org column, resolve org from installation"
```

---

## Self-Review

**Spec coverage:**
- Item 1 (remove org / resolve from install): Tasks 1 (helpers) + 5 (column drop + all readers). ✓
- Item 2 (template validation → 400): Tasks 2 (`getRepoMeta`) + 3 (wiring). ✓
- Item 3 (invite link): Task 4. ✓
- Testing section (mock handlers, migration pickup, create/accept org resolution, caching): Tasks 1, 2, 3, 5. ✓
- Non-goals (no env override, no grader validation, no repo-row html_url, no backfill): respected — none added. ✓

**Type consistency:**
- `getInstallationOrg`/`getInstallationCreds`/`clearInstallationOrgCache` names match across Tasks 1, 5, 10, 13.
- `getRepoMeta` returns `{ isTemplate: boolean } | null`; consumers in Task 3 check `meta === null` and `!meta.isTemplate`. ✓
- `buildEvaluationDeps(db, token, org)` — every call site updated (Tasks 8, 9, 13). ✓
- `EvaluationDeps.org` / `GraderBuildDeps.org` added (Tasks 6, 7) and supplied at all build sites (Tasks 8, 12, 13) and in unit tests (Step 15). ✓
- `createClassroom` input drops `githubOrg`; every caller (route Step 4, integration tests Step 17) updated. ✓

**Placeholder scan:** No TBD/TODO; the one conditional ("if this file has no `seedOwnerAssignment` helper" in Task 4) gives an explicit fallback. The Task 4 seed keeps `githubOrg` until Task 5, consistent with the green-at-each-commit sequencing.
