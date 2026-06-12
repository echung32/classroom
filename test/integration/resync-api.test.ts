import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearInstallationTokenCache } from "../../src/lib/github/app";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { getRepoByAssignmentStudent } from "../../src/lib/db/repos";
import { createStudent, listStudentsByClassroom } from "../../src/lib/db/students";
import { seedUserAndCookie } from "./helpers";

beforeEach(() => clearInstallationTokenCache());

async function setupAccepted(opts: { githubId: number; login: string }) {
  const teacher = await seedUserAndCookie({ githubId: opts.githubId, login: `teacher-${opts.login}` });
  const classroom = await createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "test-org",
    timezone: "UTC",
    createdBy: teacher.user.id,
  });
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id,
    slug: "hw1",
    title: "HW 1",
    templateRepo: "test-org/hw1-template",
    deadlineAt: undefined,
  });
  const student = await seedUserAndCookie({ githubId: opts.githubId + 1, login: opts.login });
  // Accept first so a repo row exists. The global outbound answers the GitHub calls.
  await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: student.cookie },
    body: JSON.stringify({}),
  });
  return { classroom, assignment, student };
}

describe("POST /api/assignments/:id/resync", () => {
  it("re-issues the invite (201 → invited) and bumps permission_synced_at", async () => {
    const { classroom, assignment, student } = await setupAccepted({ githubId: 60, login: "resync1" });
    const studentRow = (await listStudentsByClassroom(env.DB, classroom.id))[0];
    const repoBefore = await getRepoByAssignmentStudent(env.DB, assignment.id, studentRow.id);
    // Force an old sync timestamp so the post-resync bump is unambiguous
    // (datetime('now') is only second-granular, so accept+resync can share a second).
    await env.DB.prepare("UPDATE repos SET permission_synced_at = '2000-01-01 00:00:00' WHERE id = ?1")
      .bind(repoBefore!.id)
      .run();

    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/resync`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: student.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; invitationUrl?: string } };
    expect(body.data.status).toBe("invited");
    expect(body.data.invitationUrl).toBe("https://github.com/test-org/hw1-resync1/invitations");

    const after = await getRepoByAssignmentStudent(env.DB, assignment.id, studentRow.id);
    expect(after?.permissionSyncedAt).not.toBe("2000-01-01 00:00:00");
  });

  it("returns already_member (204 → 200) when access already exists", async () => {
    // Username contains "member" → the test outbound returns 204 for the collaborator PUT.
    const { assignment, student } = await setupAccepted({ githubId: 70, login: "member2" });

    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/resync`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: student.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; invitationUrl?: string } };
    expect(body.data.status).toBe("already_member");
    expect(body.data.invitationUrl).toBeUndefined();
  });

  it("404s when the student never accepted (no repo row)", async () => {
    const teacher = await seedUserAndCookie({ githubId: 80, login: "teacher-noaccept" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "test-org",
      timezone: "UTC",
      createdBy: teacher.user.id,
    });
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "HW 1",
      templateRepo: "test-org/hw1-template",
      deadlineAt: undefined,
    });
    const student = await seedUserAndCookie({ githubId: 81, login: "noaccept" });

    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/resync`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: student.cookie },
    });
    expect(res.status).toBe(404);
  });

  it("404s when enrolled but has not accepted (no repo row)", async () => {
    const teacher = await seedUserAndCookie({ githubId: 90, login: "teacher-enrollednorepo" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "test-org",
      timezone: "UTC",
      createdBy: teacher.user.id,
    });
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "HW 1",
      templateRepo: "test-org/hw1-template",
      deadlineAt: undefined,
    });
    const student = await seedUserAndCookie({ githubId: 91, login: "enrollednorepo" });
    await createStudent(env.DB, {
      classroomId: classroom.id,
      userId: student.user.id,
      githubUsername: student.user.githubUsername,
    });

    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/resync`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: student.cookie },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Accept the assignment first");
  });

  it("401s when unauthenticated", async () => {
    const res = await SELF.fetch(
      "https://example.com/api/assignments/11111111-1111-4111-8111-111111111111/resync",
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    expect(res.status).toBe(401);
  });
});
