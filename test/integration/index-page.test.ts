import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signSession } from "../../src/lib/auth/session";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { recordRepo } from "../../src/lib/db/repos";
import { createStudent } from "../../src/lib/db/students";
import { seedUserAndCookie } from "./helpers";

describe("GET /", () => {
  it("shows a login link when logged out", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/auth/login"');
    expect(html).not.toContain("Logged in as");
  });

  it("shows the username with a valid session cookie", async () => {
    const cookie = await signSession({ userId: "u1", githubUsername: "octocat" }, env.SESSION_SECRET);
    const response = await SELF.fetch("https://example.com/", {
      headers: { cookie: `session=${cookie}` },
    });
    const html = await response.text();
    expect(html).toContain("Logged in as");
    expect(html).toContain("octocat");
  });

  it("treats a tampered session as logged out (no 500)", async () => {
    const cookie = await signSession({ userId: "u1", githubUsername: "octocat" }, env.SESSION_SECRET);
    const response = await SELF.fetch("https://example.com/", {
      headers: { cookie: `session=${cookie}tampered` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('href="/auth/login"');
  });

  it("renders the error hint from the query string", async () => {
    const response = await SELF.fetch("https://example.com/?error=invalid_state");
    expect(await response.text()).toContain("invalid_state");
  });

  it("does not reflect a script-injection error param as live HTML (escaping)", async () => {
    const response = await SELF.fetch(
      "https://example.com/?error=" + encodeURIComponent("<script>alert(1)</script>"),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    // The raw, unescaped script tag must NOT appear — Astro must have HTML-escaped it.
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("lists the owner's classrooms with links when logged in", async () => {
    const { user, cookie } = await seedUserAndCookie({ githubId: 7, login: "teacher" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: user.id,
    });

    const response = await SELF.fetch("https://example.com/", { headers: { cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("CS101");
    expect(html).toContain(`/classrooms/${classroom.id}`);
    expect(html).toContain("my-org");
  });

  it("lists the student's assignments with accepted/not-accepted badges", async () => {
    const teacher = await seedUserAndCookie({ githubId: 40, login: "teacher40" });
    const classroom = await createClassroom(env.DB, {
      name: "CS200",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: teacher.user.id,
    });
    const accepted = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw1",
      title: "Homework One",
      templateRepo: "my-org/t",
      deadlineAt: "2026-01-01T00:00:00Z",
    });
    const notAccepted = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: "hw2",
      title: "Homework Two",
      templateRepo: "my-org/t",
    });
    const s = await seedUserAndCookie({ githubId: 41, login: "student41" });
    const student = await createStudent(env.DB, {
      classroomId: classroom.id,
      userId: s.user.id,
      githubUsername: "student41",
    });
    await recordRepo(env.DB, {
      assignmentId: accepted.id,
      studentId: student.id,
      repoName: "hw1-student41",
      repoId: 1,
    });

    const response = await SELF.fetch("https://example.com/", { headers: { cookie: s.cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("My assignments");
    expect(html).toContain("Homework One");
    expect(html).toContain(`/assignments/${accepted.id}`);
    expect(html).toContain(`/assignments/${notAccepted.id}`);
    expect(html).toContain("CS200");
    expect(html).toContain(">accepted</span>");
    expect(html).toContain(">not accepted</span>");
  });

  it("omits the My assignments section for users with no enrollments", async () => {
    const { cookie } = await seedUserAndCookie({ githubId: 42, login: "lonely42" });
    const response = await SELF.fetch("https://example.com/", { headers: { cookie } });
    expect(await response.text()).not.toContain("My assignments");
  });
});

describe("GET /debug/github-app", () => {
  it("is 404 when DEBUG_ROUTES is not enabled", async () => {
    // vitest config does not override DEBUG_ROUTES; the built worker's vars set it to "0".
    const response = await SELF.fetch("https://example.com/debug/github-app");
    expect(response.status).toBe(404);
  });
});
