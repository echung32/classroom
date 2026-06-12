import type { AstroCookies } from "astro";
import { describe, expect, it } from "vitest";
import { requireSession } from "../../src/lib/auth/require";
import { SESSION_COOKIE_NAME, signSession } from "../../src/lib/auth/session";

const SECRET = "unit-test-secret";

// Minimal AstroCookies stand-in: only `get` is exercised by requireSession.
function cookiesWith(value?: string): AstroCookies {
  return {
    get: (name: string) => (name === SESSION_COOKIE_NAME && value ? { value } : undefined),
  } as unknown as AstroCookies;
}

describe("requireSession", () => {
  it("returns the payload for a valid session cookie", async () => {
    const token = await signSession({ userId: "u1", githubUsername: "octocat" }, SECRET);
    const payload = await requireSession(cookiesWith(token), SECRET);
    expect(payload?.userId).toBe("u1");
    expect(payload?.githubUsername).toBe("octocat");
  });

  it("returns null when the cookie is absent", async () => {
    expect(await requireSession(cookiesWith(undefined), SECRET)).toBeNull();
  });

  it("returns null when the cookie signature is invalid", async () => {
    const token = await signSession({ userId: "u1", githubUsername: "octocat" }, SECRET);
    expect(await requireSession(cookiesWith(token), "wrong-secret")).toBeNull();
  });
});
