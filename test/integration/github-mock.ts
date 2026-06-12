/**
 * GitHub API mock for integration tests.
 *
 * Why an `outboundService` and not `cloudflare:test`'s `fetchMock`:
 * the installed @cloudflare/vitest-pool-workers (0.16.15) declares the
 * `MockAgent` *type* but does NOT export a `fetchMock` value from
 * `cloudflare:test` (its `cloudflare:test-internal` re-export list omits it and
 * there is no MockAgent runtime wiring in the pool). So the documented
 * per-test interceptor pattern simply isn't available on this version.
 *
 * Instead we register this handler as the worker-under-test's miniflare
 * `outboundService` (see vitest.integration.config.ts). Every `fetch()` the
 * worker makes to https://api.github.com is routed here and answered with a
 * canned, request-derived response. The real github client + RS256 JWT mint
 * still run end-to-end against these deterministic upstream responses — only
 * the network egress is faked.
 *
 * Responses are derived from the request URL/body (not per-test fixtures) so a
 * single handler serves every login the suite uses. Behavioural assertions
 * (HTTP status, response envelope, DB rows) live in the tests.
 */

const GITHUB_API = "api.github.com";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function githubOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (url.hostname !== GITHUB_API) {
    return new Response(`unexpected outbound host in test: ${url.hostname}`, { status: 502 });
  }

  // Installation-token mint: the worker built a real JWT; we fake the POST.
  if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
    return jsonResponse(201, { token: "ghs_test_token", expires_at: "2099-01-01T00:00:00Z" });
  }

  // Create-repo-from-template: echo the requested owner/name back as the new repo.
  const generate = path.match(/^\/repos\/[^/]+\/[^/]+\/generate$/);
  if (method === "POST" && generate) {
    const body = (await request.json().catch(() => ({}))) as { owner?: string; name?: string };
    const owner = body.owner ?? "test-org";
    const name = body.name ?? "repo";
    return jsonResponse(201, {
      id: 100,
      full_name: `${owner}/${name}`,
      html_url: `https://github.com/${owner}/${name}`,
    });
  }

  // Add collaborator: 201 → invitation created (status "invited"), 204 → already a member.
  // Test convention: a username containing "member" is treated as already a collaborator
  // (→ 204), so tests can exercise the resync "already_member" branch deterministically.
  const collab = path.match(/^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)$/);
  if (method === "PUT" && collab) {
    const [, owner, name, username] = collab;
    if (/member/i.test(username)) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(201, { html_url: `https://github.com/${owner}/${name}/invitations` });
  }

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

    if (/deleted/i.test(repo)) {
      // Simulates a repo deleted after acceptance: the commits read 404s, which
      // the orchestrator captures as a per-repo error without aborting the rest.
      return jsonResponse(404, { message: "Not Found" });
    }
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

  return new Response(`unmocked GitHub request in test: ${method} ${path}`, { status: 501 });
}
