import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { seedStudents } from "../../src/lib/db/students";
import { seedUserAndCookie } from "./helpers";

describe("GET /api/assignments/:id/roster", () => {
  it("returns unclaimed roster options to any authenticated user", async () => {
    const teacher = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      timezone: "UTC",
      createdBy: teacher.user.id,
    });
    await seedStudents(env.DB, classroom.id, ["alice", "bob"]);
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "HW 1",
      templateRepo: "test-org/hw1-template",
      deadlineAt: undefined,
    });

    const student = await seedUserAndCookie({ githubId: 2, login: "student" });
    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/roster`, {
      headers: { cookie: student.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { options: Array<{ id: string; rosterIdentifier: string }> } };
    expect(body.data.options.map((o) => o.rosterIdentifier).sort()).toEqual(["alice", "bob"]);
  });

  it("404s for an unknown assignment", async () => {
    const { cookie } = await seedUserAndCookie({ githubId: 3, login: "x" });
    const res = await SELF.fetch(
      "https://example.com/api/assignments/11111111-1111-4111-8111-111111111111/roster",
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });

  it("401s when unauthenticated", async () => {
    const res = await SELF.fetch(
      "https://example.com/api/assignments/11111111-1111-4111-8111-111111111111/roster",
    );
    expect(res.status).toBe(401);
  });
});
