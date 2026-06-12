import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signSession } from "../../src/lib/auth/session";
import { createClassroom } from "../../src/lib/db/classrooms";
import { seedUserAndCookie } from "./helpers";

describe("GET /", () => {
  it("shows a login link when logged out", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/auth/login"');
    expect(html).not.toContain("Logged in as");
  });

  it("shows the username with a valid session cookie", async () => {
    const cookie = await signSession({ userId: "u1", githubUsername: "octocat" }, env.SESSION_SECRET);
    const response = await SELF.fetch("https://example.com/", {
      headers: { cookie: `session=${cookie}` },
    });
    const html = await response.text();
    expect(html).toContain("Logged in as");
    expect(html).toContain("octocat");
  });

  it("treats a tampered session as logged out (no 500)", async () => {
    const cookie = await signSession({ userId: "u1", githubUsername: "octocat" }, env.SESSION_SECRET);
    const response = await SELF.fetch("https://example.com/", {
      headers: { cookie: `session=${cookie}tampered` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('href="/auth/login"');
  });

  it("renders the error hint from the query string", async () => {
    const response = await SELF.fetch("https://example.com/?error=invalid_state");
    expect(await response.text()).toContain("invalid_state");
  });

  it("does not reflect a script-injection error param as live HTML (escaping)", async () => {
    const response = await SELF.fetch(
      "https://example.com/?error=" + encodeURIComponent("<script>alert(1)</script>"),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    // The raw, unescaped script tag must NOT appear — Astro must have HTML-escaped it.
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("lists the owner's classrooms with links when logged in", async () => {
    const { user, cookie } = await seedUserAndCookie({ githubId: 7, login: "teacher" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: user.id,
    });

    const response = await SELF.fetch("https://example.com/", { headers: { cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("CS101");
    expect(html).toContain(`/classrooms/${classroom.id}`);
  });
});

describe("GET /debug/github-app", () => {
  it("is 404 when DEBUG_ROUTES is not enabled", async () => {
    // vitest config does not override DEBUG_ROUTES; the built worker's vars set it to "0".
    const response = await SELF.fetch("https://example.com/debug/github-app");
    expect(response.status).toBe(404);
  });
});
