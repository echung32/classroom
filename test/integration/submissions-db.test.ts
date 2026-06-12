import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import {
  freezeSubmission,
  getSubmission,
  listSubmissionsByAssignment,
  refreshSubmissionStatus,
} from "../../src/lib/db/submissions";
import { createStudent } from "../../src/lib/db/students";
import { seedUserAndCookie } from "./helpers";

async function seed() {
  const { user } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
  const classroom = await createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "test-org",
    timezone: "UTC",
    createdBy: user.id,
  });
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id,
    slug: "hw1",
    title: "HW 1",
    templateRepo: "test-org/hw1-template",
  });
  const { user: studentUser } = await seedUserAndCookie({ githubId: 2, login: "alice" });
  const student = await createStudent(env.DB, {
    classroomId: classroom.id,
    userId: studentUser.id,
    githubUsername: "alice",
  });
  return { assignment, student };
}

describe("submissions repository", () => {
  it("getSubmission returns null when there is no row", async () => {
    const { assignment, student } = await seed();
    expect(await getSubmission(env.DB, assignment.id, student.id)).toBeNull();
  });

  it("freezeSubmission inserts a frozen row, then preserves deadline_sha on a later freeze", async () => {
    const { assignment, student } = await seed();

    await freezeSubmission(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      deadlineSha: "sha-frozen",
      deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestCommitAt: "2025-12-31T00:00:00Z",
      status: "on_time",
    });

    const first = await getSubmission(env.DB, assignment.id, student.id);
    expect(first?.deadlineSha).toBe("sha-frozen");
    expect(first?.status).toBe("on_time");
    expect(first?.evaluatedAt).not.toBeNull();

    await freezeSubmission(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      deadlineSha: "sha-different",
      deadlineCommitAt: "2030-01-01T00:00:00Z",
      latestCommitAt: "2026-02-01T00:00:00Z",
      status: "late",
    });

    const second = await getSubmission(env.DB, assignment.id, student.id);
    expect(second?.deadlineSha).toBe("sha-frozen");
    expect(second?.deadlineCommitAt).toBe("2025-12-31T00:00:00Z");
    expect(second?.latestCommitAt).toBe("2026-02-01T00:00:00Z");
    expect(second?.status).toBe("late");
  });

  it("refreshSubmissionStatus updates status + latest_commit_at, never deadline_sha", async () => {
    const { assignment, student } = await seed();
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      deadlineSha: "sha-frozen",
      deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestCommitAt: "2025-12-31T00:00:00Z",
      status: "on_time",
    });

    await refreshSubmissionStatus(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      latestCommitAt: "2026-02-01T00:00:00Z",
      status: "late",
    });

    const row = await getSubmission(env.DB, assignment.id, student.id);
    expect(row?.deadlineSha).toBe("sha-frozen");
    expect(row?.latestCommitAt).toBe("2026-02-01T00:00:00Z");
    expect(row?.status).toBe("late");
  });

  it("listSubmissionsByAssignment returns all rows for the assignment", async () => {
    const { assignment, student } = await seed();
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      deadlineSha: "sha-frozen",
      deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestCommitAt: "2025-12-31T00:00:00Z",
      status: "on_time",
    });
    const rows = await listSubmissionsByAssignment(env.DB, assignment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].studentId).toBe(student.id);
  });
});
