import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifySession } from "../../src/lib/auth/session";
import { seedUserAndCookie } from "./helpers";

describe("seedUserAndCookie", () => {
  it("persists a user and returns a matching signed session cookie", async () => {
    const { user, cookie } = await seedUserAndCookie({ githubId: 42, login: "octocat" });

    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(cookie.startsWith("session=")).toBe(true);

    const token = cookie.slice("session=".length);
    const payload = await verifySession(token, env.SESSION_SECRET);
    expect(payload?.userId).toBe(user.id);
    expect(payload?.githubUsername).toBe("octocat");

    const row = await env.DB.prepare("SELECT id FROM users WHERE github_id = 42").first<{ id: string }>();
    expect(row?.id).toBe(user.id);
  });
});
