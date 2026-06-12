import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
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

describe("GET /api/classrooms/:id", () => {
  function get(id: string, cookie?: string): Promise<Response> {
    return SELF.fetch(`https://example.com/api/classrooms/${id}`, {
      headers: cookie ? { cookie } : {},
    });
  }

  it("returns the classroom with its nested assignments (200)", async () => {
    const { user, cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: user.id,
    });
    await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "Homework 1",
      templateRepo: "my-org/hw1-template",
      graceMinutes: 0,
    });

    const res = await get(classroom.id, cookie);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { classroom: { id: string }; assignments: { slug: string }[] };
    };
    expect(data.classroom.id).toBe(classroom.id);
    expect(data.assignments).toHaveLength(1);
    expect(data.assignments[0].slug).toBe("hw1");
  });

  it("returns 401 when unauthenticated", async () => {
    const { user } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: user.id,
    });
    expect((await get(classroom.id)).status).toBe(401);
  });

  it("returns 404 for an unknown classroom id", async () => {
    const { cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    expect((await get("00000000-0000-0000-0000-000000000000", cookie)).status).toBe(404);
  });

  it("returns 403 when the caller is not the owner", async () => {
    const { user: owner } = await seedUserAndCookie({ githubId: 1, login: "owner" });
    const { cookie: intruderCookie } = await seedUserAndCookie({ githubId: 2, login: "intruder" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: owner.id,
    });
    expect((await get(classroom.id, intruderCookie)).status).toBe(403);
  });
});
