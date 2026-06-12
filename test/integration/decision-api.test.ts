import { env, SELF } from "cloudflare:test";
import "./apply-migrations";
import { describe, expect, it } from "vitest";
import { createClassroom } from "../../src/lib/db/classrooms";
import { createAssignment } from "../../src/lib/db/assignments";
import { createStudent } from "../../src/lib/db/students";
import { freezeSubmission, getSubmission } from "../../src/lib/db/submissions";
import { seedUserAndCookie } from "./helpers";

async function seedEvaluated(githubId: number) {
  const teacher = await seedUserAndCookie({ githubId, login: `teacher-${githubId}` });
  const classroom = await createClassroom(env.DB, {
    name: "CS", githubOrg: "org", timezone: "UTC", createdBy: teacher.user.id,
  });
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id, slug: "hw1", title: "HW1", templateRepo: "org/hw1-template",
    deadlineAt: "2026-01-01T00:00:00Z",
  });
  const student = await createStudent(env.DB, {
    classroomId: classroom.id, userId: teacher.user.id, githubUsername: "stud",
  });
  await freezeSubmission(env.DB, {
    assignmentId: assignment.id, studentId: student.id,
    deadlineSha: "dsha", deadlineCommitAt: "2025-12-31T00:00:00Z",
    latestSha: "lsha", latestCommitAt: "2026-02-01T00:00:00Z", status: "late",
  });
  return { teacher, classroom, assignment, student };
}

function putDecision(assignmentId: string, studentId: string, decision: string, cookie?: string) {
  return SELF.fetch(
    `https://example.com/api/assignments/${assignmentId}/submissions/${studentId}/decision`,
    {
      method: "PUT",
      headers: cookie ? { "content-type": "application/json", cookie } : { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  );
}

describe("PUT decision", () => {
  it("sets a decision on an evaluated submission (200) and persists it", async () => {
    const { teacher, assignment, student } = await seedEvaluated(80);
    const res = await putDecision(assignment.id, student.id, "accept_late", teacher.cookie);
    expect(res.status).toBe(200);
    const row = await getSubmission(env.DB, assignment.id, student.id);
    expect(row?.gradeDecision).toBe("accept_late");
  });

  it("returns 404 when the submission/student is not evaluated", async () => {
    const { teacher, assignment } = await seedEvaluated(81);
    const res = await putDecision(assignment.id, "no-such-student", "exclude", teacher.cookie);
    expect(res.status).toBe(404);
  });

  it("returns 403 to a non-owner", async () => {
    const { assignment, student } = await seedEvaluated(82);
    const intruder = await seedUserAndCookie({ githubId: 999, login: "intruder" });
    const res = await putDecision(assignment.id, student.id, "exclude", intruder.cookie);
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    const { assignment, student } = await seedEvaluated(83);
    const res = await putDecision(assignment.id, student.id, "exclude");
    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid decision value", async () => {
    const { teacher, assignment, student } = await seedEvaluated(84);
    const res = await putDecision(assignment.id, student.id, "maybe", teacher.cookie);
    expect(res.status).toBe(400);
  });
});
