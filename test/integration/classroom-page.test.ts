// test/integration/classroom-page.test.ts
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { seedStudents } from "../../src/lib/db/students";
import { seedUserAndCookie } from "./helpers";

async function seedClassroom() {
  const { user, cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
  const classroom = await createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "my-org",
    timezone: "UTC",
    createdBy: user.id,
  });
  return { user, cookie, classroom };
}

describe("GET /classrooms/:id", () => {
  it("redirects anonymous users to login", async () => {
    const { classroom } = await seedClassroom();
    const response = await SELF.fetch(`https://example.com/classrooms/${classroom.id}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/login");
  });

  it("renders 404 for a non-owner (no existence leak)", async () => {
    const { classroom } = await seedClassroom();
    const { cookie: otherCookie } = await seedUserAndCookie({ githubId: 2, login: "other" });
    const response = await SELF.fetch(`https://example.com/classrooms/${classroom.id}`, {
      headers: { cookie: otherCookie },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("CS101");
  });

  it("renders 404 for a missing classroom", async () => {
    const { cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const response = await SELF.fetch("https://example.com/classrooms/does-not-exist", {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
  });

  it("shows assignments and roster to the owner", async () => {
    const { cookie, classroom } = await seedClassroom();
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "Homework 1",
      templateRepo: "my-org/hw1-template",
      deadlineAt: "2026-07-01T00:00:00Z",
    });
    await seedStudents(env.DB, classroom.id, ["Ada Lovelace"]);

    const response = await SELF.fetch(`https://example.com/classrooms/${classroom.id}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("CS101");
    expect(html).toContain("Homework 1");
    expect(html).toContain(`/assignments/${assignment.id}`);
    expect(html).toContain("Ada Lovelace");
  });
});
