import { env } from "cloudflare:test";
import "./apply-migrations";
import { beforeEach, describe, expect, it } from "vitest";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import {
  freezeSubmission,
  getSubmission,
  listSubmissionsByAssignment,
  refreshSubmissionStatus,
  setGradeDecision,
} from "../../src/lib/db/submissions";
import { createStudent } from "../../src/lib/db/students";
import { listReposWithStudentsByAssignment, recordRepo } from "../../src/lib/db/repos";
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
      latestSha: "sha-frozen",
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
      latestSha: "sha-latest",
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
      latestSha: "sha-frozen",
      latestCommitAt: "2025-12-31T00:00:00Z",
      status: "on_time",
    });

    await refreshSubmissionStatus(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      latestSha: "sha-latest",
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
      latestSha: "sha-frozen",
      latestCommitAt: "2025-12-31T00:00:00Z",
      status: "on_time",
    });
    const rows = await listSubmissionsByAssignment(env.DB, assignment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].studentId).toBe(student.id);
  });
});

describe("listReposWithStudentsByAssignment", () => {
  it("joins repos to their students with github_username", async () => {
    const { assignment, student } = await seed();
    await recordRepo(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      repoName: "hw1-alice",
      repoId: 123,
    });

    const rows = await listReposWithStudentsByAssignment(env.DB, assignment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      studentId: student.id,
      repoName: "hw1-alice",
      githubUsername: "alice",
    });
  });
});

async function seedForGrading() {
  const teacher = await seedUserAndCookie({ githubId: 700, login: "t700" });
  const classroom = await createClassroom(env.DB, {
    name: "CS", githubOrg: "org", timezone: "UTC", createdBy: teacher.user.id,
  });
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id, slug: "hw1-grading", title: "HW1", templateRepo: "org/hw1-template",
    deadlineAt: "2026-01-01T00:00:00Z",
  });
  const student = await createStudent(env.DB, {
    classroomId: classroom.id, userId: teacher.user.id, githubUsername: "stud",
  });
  return { assignment, student };
}

describe("submissions DB: latest_sha + grade_decision", () => {
  it("freezeSubmission persists latest_sha and defaults grade_decision to at_deadline", async () => {
    const { assignment, student } = await seedForGrading();
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      deadlineSha: "dsha", deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestSha: "lsha", latestCommitAt: "2026-02-01T00:00:00Z", status: "late",
    });
    const sub = await getSubmission(env.DB, assignment.id, student.id);
    expect(sub?.latestSha).toBe("lsha");
    expect(sub?.gradeDecision).toBe("at_deadline");
    expect(sub?.deadlineSha).toBe("dsha");
  });

  it("refreshSubmissionStatus updates latest_sha but never deadline_sha or grade_decision", async () => {
    const { assignment, student } = await seedForGrading();
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      deadlineSha: "dsha", deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestSha: "lsha1", latestCommitAt: "2026-02-01T00:00:00Z", status: "late",
    });
    await setGradeDecision(env.DB, assignment.id, student.id, "accept_late");
    await refreshSubmissionStatus(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      latestSha: "lsha2", latestCommitAt: "2026-03-01T00:00:00Z", status: "late",
    });
    const sub = await getSubmission(env.DB, assignment.id, student.id);
    expect(sub?.latestSha).toBe("lsha2");
    expect(sub?.deadlineSha).toBe("dsha"); // immutable
    expect(sub?.gradeDecision).toBe("accept_late"); // preserved
  });

  it("freeze re-run preserves an existing grade_decision (ON CONFLICT does not touch it)", async () => {
    const { assignment, student } = await seedForGrading();
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      deadlineSha: "dsha", deadlineCommitAt: "2025-12-31T00:00:00Z",
      latestSha: "lsha1", latestCommitAt: "2026-02-01T00:00:00Z", status: "late",
    });
    await setGradeDecision(env.DB, assignment.id, student.id, "exclude");
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      deadlineSha: "dsha-IGNORED", deadlineCommitAt: "1999-01-01T00:00:00Z",
      latestSha: "lsha2", latestCommitAt: "2026-04-01T00:00:00Z", status: "late",
    });
    const sub = await getSubmission(env.DB, assignment.id, student.id);
    expect(sub?.gradeDecision).toBe("exclude"); // preserved through ON CONFLICT
    expect(sub?.deadlineSha).toBe("dsha"); // COALESCE keeps original
    expect(sub?.latestSha).toBe("lsha2"); // refreshed
  });

  it("setGradeDecision returns false when no submission row exists", async () => {
    const { assignment } = await seedForGrading();
    const ok = await setGradeDecision(env.DB, assignment.id, "no-such-student", "exclude");
    expect(ok).toBe(false);
  });
});
