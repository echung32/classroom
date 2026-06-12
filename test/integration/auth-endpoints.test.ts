import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createState } from "../../src/lib/auth/oauth";
import { verifySession } from "../../src/lib/auth/session";

// NOTE: `@cloudflare/vitest-pool-workers@0.16.x` no longer re-exports `fetchMock`
// from "cloudflare:test" (the runtime module only exports SELF/env/D1 helpers/etc.).
// Because the built worker served by SELF.fetch runs in the SAME isolate as this
// test file, stubbing the global `fetch` here intercepts the worker's outbound
// GitHub calls (githubRequest uses the global `fetch` when no fetchImpl is given).
type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

interface Route {
  match: (url: URL, init: RequestInit | undefined) => boolean;
  handler: Handler;
  calls: number;
}

let routes: Route[];
let realFetch: typeof fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function intercept(match: Route["match"], handler: Handler): Route {
  const route: Route = { match, handler, calls: 0 };
  routes.push(route);
  return route;
}

beforeEach(() => {
  routes = [];
  realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    for (const route of routes) {
      if (route.match(url, init)) {
        route.calls++;
        return route.handler(url, init);
      }
    }
    throw new Error(`Unexpected outbound fetch to ${url.toString()} — no interceptor matched`);
  }) as typeof fetch);
});

afterEach(() => {
  // Assert every registered interceptor was actually exercised (parity with the
  // old fetchMock.assertNoPendingInterceptors()).
  for (const route of routes) {
    expect(route.calls).toBeGreaterThan(0);
  }
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

function mockGitHubLogin(user: { id: number; login: string }) {
  intercept(
    (url, init) =>
      url.href === "https://github.com/login/oauth/access_token" && init?.method === "POST",
    () => json({ access_token: "gho_test" }),
  );
  intercept(
    (url) => url.href === "https://api.github.com/user",
    () => json(user),
  );
}

describe("GET /auth/login", () => {
  it("redirects to GitHub with a signed state and sets the state cookie", async () => {
    const response = await SELF.fetch("https://example.com/auth/login", { redirect: "manual" });
    expect(response.status).toBe(302);

    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");

    const state = location.searchParams.get("state")!;
    expect(state).toBeTruthy();
    expect(response.headers.getSetCookie().join("; ")).toContain(`oauth_state=${state}`);
  });
});

describe("GET /auth/callback", () => {
  it("happy path: upserts the user, sets a session cookie, redirects to /", async () => {
    mockGitHubLogin({ id: 583231, login: "octocat" });
    const state = await createState(env.SESSION_SECRET);

    const response = await SELF.fetch(
      `https://example.com/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `oauth_state=${state}` } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");

    const sessionCookie = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("session="))!;
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(sessionCookie).toContain("Path=/");

    const value = sessionCookie.split(";")[0].slice("session=".length);
    const payload = await verifySession(decodeURIComponent(value), env.SESSION_SECRET);
    expect(payload?.githubUsername).toBe("octocat");

    const row = await env.DB.prepare("SELECT * FROM users WHERE github_id = 583231").first<{
      github_username: string;
      id: string;
    }>();
    expect(row?.github_username).toBe("octocat");
    expect(payload?.userId).toBe(row?.id);
  });

  it("rejects a state that does not match the cookie", async () => {
    const state = await createState(env.SESSION_SECRET);
    const otherState = await createState(env.SESSION_SECRET);

    const response = await SELF.fetch(
      `https://example.com/auth/callback?code=c&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `oauth_state=${otherState}` } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?error=invalid_state");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("rejects a tampered state even when the cookie matches", async () => {
    const state = (await createState(env.SESSION_SECRET)).slice(0, -2);
    const response = await SELF.fetch(
      `https://example.com/auth/callback?code=c&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `oauth_state=${state}` } },
    );
    expect(response.headers.get("location")).toBe("/?error=invalid_state");
  });

  it("surfaces GitHub error params as a logged-out redirect", async () => {
    const response = await SELF.fetch(
      "https://example.com/auth/callback?error=access_denied&error_description=denied",
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?error=access_denied");
  });

  it("fails closed when the token exchange fails", async () => {
    intercept(
      (url, init) =>
        url.href === "https://github.com/login/oauth/access_token" && init?.method === "POST",
      () => json({ error: "bad_verification_code" }),
    );
    const state = await createState(env.SESSION_SECRET);

    const response = await SELF.fetch(
      `https://example.com/auth/callback?code=bad&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `oauth_state=${state}` } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?error=oauth_failed");
    expect(response.headers.getSetCookie().some((c) => c.startsWith("session="))).toBe(false);
  });
});
