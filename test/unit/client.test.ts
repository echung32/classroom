import { describe, expect, it, vi } from "vitest";
import { GitHubApiError, githubRequest } from "../../src/lib/github/client";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("githubRequest", () => {
  it("prefixes api.github.com, sends auth + accept + api-version headers", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true }),
    );
    await githubRequest("/user", { token: "tok-123", fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-123");
    expect(headers.accept).toBe("application/vnd.github+json");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
    expect(headers["user-agent"]).toBe("classroom-worker");
  });

  it("passes absolute URLs through untouched and JSON-encodes the body", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({}),
    );
    await githubRequest("https://github.com/login/oauth/access_token", {
      method: "POST",
      body: { code: "abc" },
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ code: "abc" }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("returns parsed data plus rate-limit info", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ login: "octocat" }, {
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4998",
          "x-ratelimit-reset": "1765500000",
        },
      }),
    );
    const result = await githubRequest<{ login: string }>("/user", { fetchImpl });
    expect(result.data.login).toBe("octocat");
    expect(result.rateLimit).toEqual({
      remaining: 4998,
      reset: 1765500000,
      retryAfterSeconds: null,
    });
  });

  it("throws GitHubApiError carrying status and rate-limit headers on 403", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("rate limited", {
          status: 403,
          headers: { "retry-after": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1765500000" },
        }),
    );
    const error = await githubRequest("/user", { fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error.status).toBe(403);
    expect(error.rateLimit).toEqual({ remaining: 0, reset: 1765500000, retryAfterSeconds: 60 });
  });

  it("returns undefined data on 204", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await githubRequest("/user", { fetchImpl });
    expect(result.status).toBe(204);
    expect(result.data).toBeUndefined();
  });
});
