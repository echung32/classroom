import { env, SELF } from "cloudflare:test";
import "./apply-migrations";
import { beforeEach, describe, expect, it } from "vitest";
import { clearInstallationTokenCache } from "../../src/lib/github/app";
import { createClassroom } from "../../src/lib/db/classrooms";
import { createAssignment, getAssignmentById } from "../../src/lib/db/assignments";
import { createStudent } from "../../src/lib/db/students";
import { freezeSubmission, setGradeDecision } from "../../src/lib/db/submissions";
import { seedUserAndCookie } from "./helpers";

beforeEach(() => clearInstallationTokenCache());

const PAST = "2020-01-01T00:00:00Z";
const FUTURE = "2099-01-01T00:00:00Z";

async function seedBoard(opts: { githubId: number; deadlineAt: string }) {
  const teacher = await seedUserAndCookie({ githubId: opts.githubId, login: `teacher-${opts.githubId}` });
  const classroom = await createClassroom(env.DB, {
    name: "CS", githubOrg: "org", timezone: "UTC", createdBy: teacher.user.id,
  });
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id, slug: "hw1", title: "HW1", templateRepo: "org/hw1-template",
    deadlineAt: opts.deadlineAt,
  });

  let subCounter = 0;
  async function seedSub(username: string, decision: string, deadlineSha: string | null, latestSha: string | null) {
    subCounter += 1;
    const u = await seedUserAndCookie({ githubId: opts.githubId * 100 + subCounter, login: username });
    const student = await createStudent(env.DB, {
      classroomId: classroom.id, userId: u.user.id, githubUsername: username,
    });
    await freezeSubmission(env.DB, {
      assignmentId: assignment.id, studentId: student.id,
      deadlineSha, deadlineCommitAt: deadlineSha ? "2019-12-31T00:00:00Z" : null,
      latestSha, latestCommitAt: latestSha ? "2020-02-01T00:00:00Z" : null,
      status: "late",
    });
    await setGradeDecision(env.DB, assignment.id, student.id, decision);
    return student;
  }

  await seedSub("ann", "at_deadline", "d-ann", "l-ann");
  await seedSub("ben", "accept_late", "d-ben", "l-ben");
  await seedSub("cid", "exclude", "d-cid", "l-cid");
  await seedSub("dot", "at_deadline", null, null); // null deadline SHA → skipped

  return { teacher, classroom, assignment };
}

function postGrader(assignmentId: string, cookie?: string) {
  return SELF.fetch(`https://example.com/api/assignments/${assignmentId}/grader`, {
    method: "POST",
    headers: cookie ? { "content-type": "application/json", cookie } : { "content-type": "application/json" },
  });
}

describe("POST grader", () => {
  it("builds the grader, sets grader_repo + status, and returns included/skipped", async () => {
    const { teacher, assignment } = await seedBoard({ githubId: 90, deadlineAt: PAST });
    const res = await postGrader(assignment.id, teacher.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        graderRepo: string;
        commitSha: string;
        included: { username: string; sha: string; source: string }[];
        skipped: { username: string | null; studentId: string; reason: string }[];
      };
    };
    expect(body.data.graderRepo).toBe("org/grader-hw1");

    const included = body.data.included.sort((a, b) => a.username.localeCompare(b.username));
    expect(included).toEqual([
      { username: "ann", sha: "d-ann", source: "deadline" },
      { username: "ben", sha: "l-ben", source: "latest" },
    ]);

    const reasons = Object.fromEntries(body.data.skipped.map((s) => [s.username, s.reason]));
    expect(reasons.cid).toBe("excluded");
    expect(reasons.dot).toBe("no-deadline-sha");

    const after = await getAssignmentById(env.DB, assignment.id);
    expect(after?.graderRepo).toBe("org/grader-hw1");
    expect(after?.status).toBe("built");
  });

  it("is idempotent: a second POST still returns built", async () => {
    const { teacher, assignment } = await seedBoard({ githubId: 91, deadlineAt: PAST });
    expect((await postGrader(assignment.id, teacher.cookie)).status).toBe(200);
    const second = await postGrader(assignment.id, teacher.cookie);
    expect(second.status).toBe(200);
    const after = await getAssignmentById(env.DB, assignment.id);
    expect(after?.status).toBe("built");
  });

  it("returns 400 when the deadline has not passed", async () => {
    const { teacher, assignment } = await seedBoard({ githubId: 92, deadlineAt: FUTURE });
    expect((await postGrader(assignment.id, teacher.cookie)).status).toBe(400);
  });

  it("returns 403 to a non-owner", async () => {
    const { assignment } = await seedBoard({ githubId: 93, deadlineAt: PAST });
    const intruder = await seedUserAndCookie({ githubId: 999, login: "intruder" });
    expect((await postGrader(assignment.id, intruder.cookie)).status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    const { assignment } = await seedBoard({ githubId: 94, deadlineAt: PAST });
    expect((await postGrader(assignment.id)).status).toBe(401);
  });
});
