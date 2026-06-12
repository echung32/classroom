import { describe, expect, it, vi } from "vitest";
import {
  STATE_COOKIE_NAME,
  STATE_TTL_SECONDS,
  RETURN_TO_COOKIE_NAME,
  buildAuthorizeUrl,
  createState,
  exchangeCode,
  fetchAuthenticatedUser,
  sanitizeReturnTo,
  verifyState,
} from "../../src/lib/auth/oauth";

const SECRET = "unit-test-secret";
const NOW = 1_765_000_000;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("authorize URL", () => {
  it("targets github.com/login/oauth/authorize with client_id and state", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "cid-1", state: "the-state" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid-1");
    expect(url.searchParams.get("state")).toBe("the-state");
  });
});

describe("state", () => {
  it("verifies a fresh state", async () => {
    const state = await createState(SECRET, NOW);
    expect(await verifyState(state, SECRET, NOW)).toBe(true);
  });

  it("rejects an expired state", async () => {
    const state = await createState(SECRET, NOW);
    expect(await verifyState(state, SECRET, NOW + STATE_TTL_SECONDS + 1)).toBe(false);
  });

  it("rejects a tampered state", async () => {
    const state = await createState(SECRET, NOW);
    expect(await verifyState(state.slice(0, -2), SECRET, NOW)).toBe(false);
  });

  it("rejects a session cookie passed off as state (type confusion)", async () => {
    const { signSession } = await import("../../src/lib/auth/session");
    const sessionValue = await signSession({ userId: "u1", githubUsername: "x" }, SECRET, NOW);
    expect(await verifyState(sessionValue, SECRET, NOW)).toBe(false);
  });

  it("exports the state cookie name", () => {
    expect(STATE_COOKIE_NAME).toBe("oauth_state");
  });
});

describe("exchangeCode", () => {
  it("POSTs code + client credentials and returns the access token", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ access_token: "gho_abc" }),
    );
    const token = await exchangeCode({
      code: "the-code",
      clientId: "cid-1",
      clientSecret: "csec-1",
      fetchImpl,
    });
    expect(token).toBe("gho_abc");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "cid-1",
      client_secret: "csec-1",
      code: "the-code",
    });
    expect((init.headers as Record<string, string>).accept).toBe("application/json");
  });

  it("fails closed when GitHub returns an error body with status 200", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "bad_verification_code", error_description: "expired" }),
    );
    await expect(
      exchangeCode({ code: "x", clientId: "c", clientSecret: "s", fetchImpl }),
    ).rejects.toThrow(/bad_verification_code/);
  });

  it("fails closed when access_token is missing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await expect(
      exchangeCode({ code: "x", clientId: "c", clientSecret: "s", fetchImpl }),
    ).rejects.toThrow(/no access_token/);
  });
});

describe("fetchAuthenticatedUser", () => {
  it("GETs /user with the bearer token and maps id/login", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ id: 583231, login: "octocat" }),
    );
    const user = await fetchAuthenticatedUser("gho_abc", fetchImpl);
    expect(user).toEqual({ githubId: 583231, login: "octocat" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer gho_abc");
  });
});

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
