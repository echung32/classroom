import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { findUserById, upsertUser } from "../../src/lib/db/users";

describe("users repository", () => {
  it("inserts a new user with a uuid and last_login_at", async () => {
    const user = await upsertUser(env.DB, { githubId: 583231, githubUsername: "octocat" });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.githubId).toBe(583231);
    expect(user.githubUsername).toBe("octocat");
    expect(user.createdAt).toBeTruthy();
    expect(user.lastLoginAt).toBeTruthy();
  });

  it("updates username and last_login_at on conflict by github_id, keeping the same row", async () => {
    const first = await upsertUser(env.DB, { githubId: 583231, githubUsername: "octocat" });
    const second = await upsertUser(env.DB, { githubId: 583231, githubUsername: "octocat-renamed" });

    expect(second.id).toBe(first.id);
    expect(second.githubUsername).toBe("octocat-renamed");
    expect(second.createdAt).toBe(first.createdAt);

    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });

  it("findUserById returns the user or null", async () => {
    const user = await upsertUser(env.DB, { githubId: 1, githubUsername: "someone" });
    expect(await findUserById(env.DB, user.id)).toEqual(user);
    expect(await findUserById(env.DB, "missing-id")).toBeNull();
  });
});
