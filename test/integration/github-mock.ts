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

  // Add collaborator: 201 → invitation created (status "invited").
  const collab = path.match(/^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)$/);
  if (method === "PUT" && collab) {
    const [, owner, name] = collab;
    return jsonResponse(201, { html_url: `https://github.com/${owner}/${name}/invitations` });
  }

  return new Response(`unmocked GitHub request in test: ${method} ${path}`, { status: 501 });
}
