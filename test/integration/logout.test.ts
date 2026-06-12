import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedUserAndCookie } from "./helpers";

describe("GET /auth/logout", () => {
  it("clears the session cookie and redirects home", async () => {
    const { cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const response = await SELF.fetch("https://example.com/auth/logout", {
      headers: { cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const setCookie = (response.headers.get("set-cookie") ?? "").toLowerCase();
    expect(setCookie).toContain("session=");
    // Astro cookies.delete() expires the cookie in the past.
    expect(setCookie).toMatch(/expires=thu, 01 jan 1970/);
  });

  it("redirects cleanly even without a session", async () => {
    const response = await SELF.fetch("https://example.com/auth/logout", {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });
});
