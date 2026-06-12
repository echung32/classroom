import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createAssignment,
  getAssignmentById,
  listAssignmentsByClassroom,
  listAssignmentsForStudentUser,
} from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { ConflictError } from "../../src/lib/http/errors";
import { recordRepo } from "../../src/lib/db/repos";
import { createStudent } from "../../src/lib/db/students";
import { seedUserAndCookie } from "./helpers";

async function seedClassroom(githubId = 1, login = "teacher") {
  const { user } = await seedUserAndCookie({ githubId, login });
  return createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "my-org",
    timezone: "UTC",
    createdBy: user.id,
  });
}

describe("assignments repository", () => {
  it("createAssignment persists a row with defaults", async () => {
    const classroom = await seedClassroom();
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "Homework 1",
      templateRepo: "my-org/hw1-template",
    });

    expect(assignment.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(assignment.classroomId).toBe(classroom.id);
    expect(assignment.slug).toBe("hw1");
    expect(assignment.title).toBe("Homework 1");
    expect(assignment.templateRepo).toBe("my-org/hw1-template");
    expect(assignment.deadlineAt).toBeNull();
    expect(assignment.status).toBe("open");
  });

  it("persists an optional deadline", async () => {
    const classroom = await seedClassroom();
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw2",
      title: "Homework 2",
      templateRepo: "my-org/hw2-template",
      deadlineAt: "2026-09-01T23:59:00Z",
    });
    expect(assignment.deadlineAt).toBe("2026-09-01T23:59:00Z");
  });

  it("throws ConflictError on a duplicate slug in the same classroom", async () => {
    const classroom = await seedClassroom();
    await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "First",
      templateRepo: "my-org/hw1-template",
    });
    await expect(
      createAssignment(env.DB, {
        classroomId: classroom.id,
        slug: "hw1",
        title: "Dup",
        templateRepo: "my-org/hw1-template",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows the same slug in a different classroom", async () => {
    const a = await seedClassroom(1, "teacher-a");
    const b = await seedClassroom(2, "teacher-b");
    await createAssignment(env.DB, {
      classroomId: a.id,
      slug: "hw1",
      title: "A",
      templateRepo: "my-org/hw1-template",
    });
    const second = await createAssignment(env.DB, {
      classroomId: b.id,
      slug: "hw1",
      title: "B",
      templateRepo: "my-org/hw1-template",
    });
    expect(second.slug).toBe("hw1");
  });

  it("getAssignmentById and listAssignmentsByClassroom read back rows", async () => {
    const classroom = await seedClassroom();
    const created = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "Homework 1",
      templateRepo: "my-org/hw1-template",
    });
    expect(await getAssignmentById(env.DB, created.id)).toEqual(created);
    expect(await getAssignmentById(env.DB, "missing-id")).toBeNull();

    const list = await listAssignmentsByClassroom(env.DB, classroom.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
    expect(await listAssignmentsByClassroom(env.DB, "missing-id")).toEqual([]);
  });
});

describe("listAssignmentsForStudentUser", () => {
  it("returns enrolled assignments deadline-ascending (NULLs last) with accepted flags", async () => {
    const classroom = await seedClassroom(20, "teacher20");
    const noDeadline = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw-none",
      title: "No deadline",
      templateRepo: "my-org/t",
    });
    const early = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw-early",
      title: "Early",
      templateRepo: "my-org/t",
      deadlineAt: "2026-01-01T00:00:00Z",
    });
    const later = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw-later",
      title: "Later",
      templateRepo: "my-org/t",
      deadlineAt: "2026-06-01T00:00:00Z",
    });

    const { user } = await seedUserAndCookie({ githubId: 21, login: "student21" });
    const student = await createStudent(env.DB, {
      classroomId: classroom.id,
      userId: user.id,
      githubUsername: "student21",
    });
    await recordRepo(env.DB, {
      assignmentId: early.id,
      studentId: student.id,
      repoName: "hw-early-student21",
      repoId: 5,
    });

    const rows = await listAssignmentsForStudentUser(env.DB, user.id);
    expect(rows.map((r) => r.title)).toEqual(["Early", "Later", "No deadline"]);
    expect(rows[0]).toEqual({
      assignmentId: early.id,
      title: "Early",
      slug: "hw-early",
      deadlineAt: "2026-01-01T00:00:00Z",
      classroomName: "CS101",
      accepted: true,
    });
    expect(rows.find((r) => r.assignmentId === later.id)?.accepted).toBe(false);
    expect(rows.find((r) => r.assignmentId === noDeadline.id)?.accepted).toBe(false);
  });

  it("is empty for a user with no enrollments (other classrooms invisible)", async () => {
    const other = await seedClassroom(22, "teacher22");
    await createAssignment(env.DB, {
      classroomId: other.id,
      slug: "hw1",
      title: "Other HW",
      templateRepo: "my-org/t",
    });
    const { user } = await seedUserAndCookie({ githubId: 23, login: "student23" });
    expect(await listAssignmentsForStudentUser(env.DB, user.id)).toEqual([]);
  });
});
