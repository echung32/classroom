// test/integration/assignment-page.test.ts
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { recordRepo } from "../../src/lib/db/repos";
import { createStudent, seedStudents } from "../../src/lib/db/students";
import { clearInstallationTokenCache } from "../../src/lib/github/app";
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

beforeEach(() => clearInstallationTokenCache());

const PAST_DEADLINE = "2026-01-01T00:00:00Z";

/** Seed an enrolled student with an accepted repo. repoSuffix drives the GitHub
 *  mock's commit-state convention (ontime / late / missing / deleted). */
async function seedAcceptedStudent(opts: {
  githubId: number;
  login: string;
  repoSuffix: string;
  deadlineAt?: string;
}) {
  const seeded = await seedAssignment(opts.deadlineAt);
  const s = await seedUserAndCookie({ githubId: opts.githubId, login: opts.login });
  const student = await createStudent(env.DB, {
    classroomId: seeded.classroom.id,
    userId: s.user.id,
    githubUsername: opts.login,
  });
  await recordRepo(env.DB, {
    assignmentId: seeded.assignment.id,
    studentId: student.id,
    repoName: `hw1-${opts.repoSuffix}`,
    repoId: 999,
  });
  return { ...seeded, student, studentCookie: s.cookie };
}

describe("GET /assignments/:id", () => {
  it("redirects anonymous users to login", async () => {
    const { assignment } = await seedAssignment();
    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/auth/login?returnTo=${encodeURIComponent(`/assignments/${assignment.id}`)}`,
    );
  });

  it("renders the student accept view for a non-owner (invite-link semantics)", async () => {
    const { assignment } = await seedAssignment();
    const { cookie: otherCookie } = await seedUserAndCookie({ githubId: 2, login: "other" });
    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: otherCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Homework 1");
    expect(html).toContain("Accept assignment");
    // Teacher chrome must NOT leak to students.
    expect(html).not.toContain("Build grader");
    expect(html).not.toContain("Share with students");
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

  it("shows the teacher a shareable invite link with the assignment URL", async () => {
    const { cookie, assignment } = await seedAssignment();
    const res = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie },
    });
    const html = await res.text();
    expect(html).toContain("Share with students");
    expect(html).toContain(`https://example.com/assignments/${assignment.id}`);
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

describe("GET /assignments/:id — student view", () => {
  it("shows the accept panel with unclaimed roster options to an unenrolled visitor", async () => {
    const { assignment, classroom } = await seedAssignment();
    await seedStudents(env.DB, classroom.id, ["Ada Lovelace", "Bob Smith"]);
    const visitor = await seedUserAndCookie({ githubId: 30, login: "visitor30" });

    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: visitor.cookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Homework 1");
    expect(html).toContain("CS101");
    expect(html).toContain("Accept assignment");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Bob Smith");
  });

  it("hides roster options from an already-enrolled student without a repo", async () => {
    const { assignment, classroom } = await seedAssignment();
    await seedStudents(env.DB, classroom.id, ["Ada Lovelace"]);
    const s = await seedUserAndCookie({ githubId: 31, login: "enrolled31" });
    await createStudent(env.DB, {
      classroomId: classroom.id,
      userId: s.user.id,
      githubUsername: "enrolled31",
    });

    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: s.cookie },
    });
    const html = await response.text();
    expect(html).toContain("Accept assignment");
    expect(html).not.toContain("Ada Lovelace");
  });

  it("pre-deadline: shows the repo link and not-due-yet, no evaluation data", async () => {
    const { assignment, studentCookie } = await seedAcceptedStudent({
      githubId: 32,
      login: "pre32",
      repoSuffix: "ontime",
      deadlineAt: "2099-01-01T00:00:00Z",
    });

    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: studentCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("https://github.com/test-org/hw1-ontime");
    expect(html).toContain("Not due yet");
    expect(html).not.toContain("on_time");
  });

  it("no deadline: shows the repo link and the no-deadline note", async () => {
    const { assignment, studentCookie } = await seedAcceptedStudent({
      githubId: 33,
      login: "nodl33",
      repoSuffix: "ontime",
    });

    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: studentCookie },
    });
    const html = await response.text();
    expect(html).toContain("https://github.com/test-org/hw1-ontime");
    expect(html).toContain("no deadline");
  });

  it("post-deadline: the student's own page load freezes deadline_sha and renders live status", async () => {
    const { assignment, student, studentCookie } = await seedAcceptedStudent({
      githubId: 34,
      login: "post34",
      repoSuffix: "ontime",
      deadlineAt: PAST_DEADLINE,
    });

    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: studentCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("on_time");
    expect(html).toContain("Fix my access");
    // grade_decision is teacher-private — never in the student HTML.
    expect(html).not.toContain("at_deadline");

    // The page load itself performed the Phase 3 freeze.
    const row = await env.DB.prepare(
      "SELECT deadline_sha, status FROM submissions WHERE assignment_id = ?1 AND student_id = ?2",
    )
      .bind(assignment.id, student.id)
      .first<{ deadline_sha: string; status: string }>();
    expect(row?.deadline_sha).toBe("deadline-ontime-sha");
    expect(row?.status).toBe("on_time");
  });

  it("post-deadline: a per-repo GitHub failure degrades to an inline note, repo link still renders", async () => {
    const { assignment, studentCookie } = await seedAcceptedStudent({
      githubId: 35,
      login: "gone35",
      repoSuffix: "deleted",
      deadlineAt: PAST_DEADLINE,
    });

    const response = await SELF.fetch(`https://example.com/assignments/${assignment.id}`, {
      headers: { cookie: studentCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("https://github.com/test-org/hw1-deleted");
    expect(html).toContain("read your repo");
  });

  it("post-deadline: evaluates and freezes ONLY the viewing student, never classmates", async () => {
    const seeded = await seedAcceptedStudent({
      githubId: 36,
      login: "viewer36",
      repoSuffix: "ontime",
      deadlineAt: PAST_DEADLINE,
    });
    // A classmate with their own accepted repo (mock convention: "late" repo).
    const other = await seedUserAndCookie({ githubId: 37, login: "classmate37" });
    const otherStudent = await createStudent(env.DB, {
      classroomId: seeded.classroom.id,
      userId: other.user.id,
      githubUsername: "classmate37",
    });
    await recordRepo(env.DB, {
      assignmentId: seeded.assignment.id,
      studentId: otherStudent.id,
      repoName: "hw1-late",
      repoId: 998,
    });

    const response = await SELF.fetch(`https://example.com/assignments/${seeded.assignment.id}`, {
      headers: { cookie: seeded.studentCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    // Viewer's own status renders; the classmate's repo/identity/status do not.
    expect(html).toContain("on_time");
    expect(html).not.toContain("hw1-late");
    expect(html).not.toContain("classmate37");
    expect(html).not.toContain(">late<");

    // No freeze side effect for the classmate — only the viewer's row exists.
    const rows = await env.DB.prepare(
      "SELECT student_id FROM submissions WHERE assignment_id = ?1",
    )
      .bind(seeded.assignment.id)
      .all<{ student_id: string }>();
    expect(rows.results.map((r) => r.student_id)).toEqual([seeded.student.id]);
  });
});
