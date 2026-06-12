import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { recordRepo } from "../../src/lib/db/repos";
import { createStudent } from "../../src/lib/db/students";
import { clearInstallationTokenCache } from "../../src/lib/github/app";
import { seedUserAndCookie } from "./helpers";

beforeEach(() => clearInstallationTokenCache());

const PAST_DEADLINE = "2026-01-01T00:00:00Z";

interface SubmissionView {
  studentId: string;
  repoName: string;
  status: string | null;
  deadlineSha: string | null;
  evaluatedAt: string | null;
  latestCommitAt: string | null;
}
interface Board {
  data: { assignmentId: string; dueState: string; submissions: SubmissionView[]; errors: unknown[] };
}

/** Seed an owned classroom + assignment + two accepted repos (ontime, late). */
async function seedBoard(opts: { deadlineAt?: string; githubId: number } = { githubId: 1 }) {
  const teacher = await seedUserAndCookie({ githubId: opts.githubId, login: `teacher-${opts.githubId}` });
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
    deadlineAt: opts.deadlineAt,
  });

  async function seedRepo(username: string) {
    const u = await seedUserAndCookie({ githubId: opts.githubId * 100 + username.length, login: username });
    const student = await createStudent(env.DB, {
      classroomId: classroom.id,
      userId: u.user.id,
      githubUsername: username,
    });
    await recordRepo(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      repoName: `hw1-${username}`,
      repoId: 1000 + username.length,
    });
    return student;
  }

  const ontime = await seedRepo("ontime");
  const late = await seedRepo("late");
  return { teacher, classroom, assignment, ontime, late };
}

function getBoard(assignmentId: string, cookie?: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/assignments/${assignmentId}/submissions`, {
    headers: cookie ? { cookie } : {},
  });
}
function postRefresh(assignmentId: string, cookie: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/assignments/${assignmentId}/submissions/refresh`, {
    method: "POST",
    // content-type required: Astro's checkOrigin CSRF guard rejects form-like
    // POSTs (incl. those with no content-type) cross-site. Mirrors accept/resync tests.
    headers: { "content-type": "application/json", cookie },
  });
}

describe("GET /api/assignments/:id/submissions", () => {
  it("evaluates + freezes each repo past the deadline", async () => {
    const { teacher, assignment, ontime, late } = await seedBoard({ deadlineAt: PAST_DEADLINE, githubId: 1 });

    const res = await getBoard(assignment.id, teacher.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Board;
    expect(body.data.dueState).toBe("evaluated");

    const byStudent = Object.fromEntries(body.data.submissions.map((s) => [s.studentId, s]));
    expect(byStudent[ontime.id].status).toBe("on_time");
    expect(byStudent[late.id].status).toBe("late");
    for (const s of body.data.submissions) {
      expect(s.deadlineSha).not.toBeNull();
      expect(s.evaluatedAt).not.toBeNull();
    }
  });

  it("is a cache hit on a second GET (evaluated_at unchanged)", async () => {
    const { teacher, assignment, ontime } = await seedBoard({ deadlineAt: PAST_DEADLINE, githubId: 2 });

    const first = (await (await getBoard(assignment.id, teacher.cookie)).json()) as Board;
    const firstEvaluatedAt = first.data.submissions.find((s) => s.studentId === ontime.id)!.evaluatedAt;

    const second = (await (await getBoard(assignment.id, teacher.cookie)).json()) as Board;
    const secondEvaluatedAt = second.data.submissions.find((s) => s.studentId === ontime.id)!.evaluatedAt;

    expect(secondEvaluatedAt).toBe(firstEvaluatedAt);
  });

  it("surfaces a null-deadline assignment as no-deadline with null statuses", async () => {
    const { teacher, assignment } = await seedBoard({ githubId: 3 });
    const body = (await (await getBoard(assignment.id, teacher.cookie)).json()) as Board;
    expect(body.data.dueState).toBe("no-deadline");
    expect(body.data.submissions.every((s) => s.status === null)).toBe(true);
  });

  it("returns 403 to a non-owner and 404 for an unknown assignment", async () => {
    const { assignment } = await seedBoard({ deadlineAt: PAST_DEADLINE, githubId: 4 });
    const intruder = await seedUserAndCookie({ githubId: 999, login: "intruder" });
    expect((await getBoard(assignment.id, intruder.cookie)).status).toBe(403);
    expect(
      (await getBoard("00000000-0000-0000-0000-000000000000", intruder.cookie)).status,
    ).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    const { assignment } = await seedBoard({ deadlineAt: PAST_DEADLINE, githubId: 5 });
    expect((await getBoard(assignment.id)).status).toBe(401);
  });

  it("classifies template-only repos as missing and isolates a deleted repo's error", async () => {
    const { teacher, classroom, assignment } = await seedBoard({ deadlineAt: PAST_DEADLINE, githubId: 7 });

    // Add two more repos to the same assignment: a template-only one (→ missing)
    // and one whose commits read 404s (deleted after acceptance → per-repo error).
    // `seq` keeps githubId/repoId unique: "missing" and "deleted" are both 7 chars,
    // so a length-derived id would collide (same user enrolled twice → 409).
    async function addRepo(username: string, seq: number) {
      const u = await seedUserAndCookie({ githubId: 7000 + seq, login: username });
      const student = await createStudent(env.DB, {
        classroomId: classroom.id,
        userId: u.user.id,
        githubUsername: username,
      });
      await recordRepo(env.DB, {
        assignmentId: assignment.id,
        studentId: student.id,
        repoName: `hw1-${username}`,
        repoId: 7000 + seq,
      });
      return student;
    }
    const missing = await addRepo("missing", 1);
    const deleted = await addRepo("deleted", 2);

    const body = (await (await getBoard(assignment.id, teacher.cookie)).json()) as Board;
    const byStudent = Object.fromEntries(body.data.submissions.map((s) => [s.studentId, s]));

    // Template-only repo → missing, but deadline_sha is still pinned to the
    // template commit (the correct deadline-state to grade).
    expect(byStudent[missing.id].status).toBe("missing");
    expect(byStudent[missing.id].deadlineSha).toBe("template-sha");

    // The deleted repo is NOT frozen (no submission row); it surfaces in errors[]
    // while the other repos are still evaluated.
    expect(byStudent[deleted.id]).toBeUndefined();
    expect(
      body.data.errors.some((e) => (e as { repoName: string }).repoName === "hw1-deleted"),
    ).toBe(true);
  });
});

describe("POST /api/assignments/:id/submissions/refresh", () => {
  it("re-checks late-ness on a frozen row, flipping status while preserving deadline_sha", async () => {
    const { teacher, assignment, late } = await seedBoard({ deadlineAt: PAST_DEADLINE, githubId: 6 });

    await env.DB.prepare(
      `INSERT INTO submissions
         (assignment_id, student_id, deadline_sha, deadline_commit_at, latest_commit_at, status, evaluated_at)
       VALUES (?1, ?2, 'frozen-sha', '2025-12-31T00:00:00Z', '2025-12-31T00:00:00Z', 'on_time', '2026-01-02T00:00:00Z')`,
    )
      .bind(assignment.id, late.id)
      .run();

    const res = await postRefresh(assignment.id, teacher.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Board;

    const lateRow = body.data.submissions.find((s) => s.studentId === late.id)!;
    expect(lateRow.status).toBe("late");
    expect(lateRow.deadlineSha).toBe("frozen-sha");
    expect(lateRow.latestCommitAt).toBe("2026-02-01T00:00:00Z");
  });
});
