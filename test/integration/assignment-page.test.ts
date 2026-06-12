// test/integration/assignment-page.test.ts
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { seedUserAndCookie } from "./helpers";

async function seedAssignment(deadlineAt?: string) {
  const { user, cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
  const classroom = await createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "test-org",
    timezone: "UTC",
    createdBy: user.id,
  });
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id,
    slug: "hw1",
    title: "Homework 1",
    templateRepo: "test-org/hw1-template",
    deadlineAt,
  });
  return { cookie, classroom, assignment };
}

describe("GET /assignments/:id", () => {
  it("redirects anonymous users to login", async () => {
    const { assignment } = await seedAssignment();
    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/login");
  });

  it("renders 404 for a non-owner", async () => {
    const { assignment } = await seedAssignment();
    const { cookie: otherCookie } = await seedUserAndCookie({ githubId: 2, login: "other" });
    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: otherCookie },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Homework 1");
  });

  it("shows the no-deadline notice when deadline_at is null", async () => {
    const { cookie, assignment } = await seedAssignment();
    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Homework 1");
    expect(html).toContain("no deadline set");
  });

  it("shows the pending notice before the deadline", async () => {
    const { cookie, assignment } = await seedAssignment("2099-01-01T00:00:00Z");
    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("not due yet");
  });

  it("renders the board after the deadline (lazy evaluation trigger)", async () => {
    const { cookie, assignment } = await seedAssignment("2020-01-01T00:00:00Z");
    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    // No repos exist, so the table is empty, but the board chrome must render.
    expect(html).toContain("Build grader");
    expect(html).toContain("Refresh");
  });
});
