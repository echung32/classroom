import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedUserAndCookie } from "./helpers";

function post(body: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch("https://example.com/api/classrooms", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/classrooms", () => {
  it("creates a classroom owned by the current user (201)", async () => {
    const { user, cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const res = await post({ name: "CS101", github_org: "my-org" }, cookie);
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string; createdBy: string; timezone: string } };
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.createdBy).toBe(user.id);
    expect(data.timezone).toBe("UTC");
  });

  it("rejects an unauthenticated request (401)", async () => {
    const res = await post({ name: "CS101", github_org: "my-org" });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid body with field messages (400)", async () => {
    const { cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const res = await post({ name: "", github_org: "my-org" }, cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { fields?: Record<string, string> } };
    expect(body.error.fields).toHaveProperty("name");
  });
});
