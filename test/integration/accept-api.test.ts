import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAssignment } from "../../src/lib/db/assignments";
import { createClassroom } from "../../src/lib/db/classrooms";
import { getRepoByAssignmentStudent } from "../../src/lib/db/repos";
import { listStudentsByClassroom, seedStudents } from "../../src/lib/db/students";
import { clearInstallationTokenCache } from "../../src/lib/github/app";
import { seedUserAndCookie } from "./helpers";

// GitHub egress is intercepted by the miniflare `outboundService` registered in
// vitest.integration.config.ts (this version of vitest-pool-workers does not
// ship the `fetchMock` MockAgent). The handler is stateless and request-derived,
// so no per-test mock setup is required — see test/integration/github-mock.ts.

beforeEach(() => clearInstallationTokenCache());

async function setup(opts: { githubId: number; login: string; seed?: string[] }) {
  const teacher = await seedUserAndCookie({ githubId: opts.githubId, login: `teacher-${opts.login}` });
  const classroom = await createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "test-org",
    timezone: "UTC",
    createdBy: teacher.user.id,
  });
  if (opts.seed) await seedStudents(env.DB, classroom.id, opts.seed);
  const assignment = await createAssignment(env.DB, {
    classroomId: classroom.id,
    slug: "hw1",
    title: "HW 1",
    templateRepo: "test-org/hw1-template",
    deadlineAt: undefined,
    graceMinutes: 0,
  });
  return { classroom, assignment };
}

describe("POST /api/assignments/:id/accept", () => {
  it("claim path: links the chosen roster row, creates repo + collaborator, records repo", async () => {
    const { classroom, assignment } = await setup({ githubId: 10, login: "claim", seed: ["alice"] });
    const student = await seedUserAndCookie({ githubId: 11, login: "octocat" });
    const options = await listStudentsByClassroom(env.DB, classroom.id);
    const rosterStudentId = options[0].id;

    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: student.cookie },
      body: JSON.stringify({ rosterStudentId }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { repoUrl: string; invitationUrl?: string; status: string };
    };
    expect(body.data.repoUrl).toBe("https://github.com/test-org/hw1-octocat");
    expect(body.data.invitationUrl).toBe("https://github.com/test-org/hw1-octocat/invitations");
    expect(body.data.status).toBe("invited");

    const linked = (await listStudentsByClassroom(env.DB, classroom.id))[0];
    expect(linked.id).toBe(rosterStudentId);
    expect(linked.userId).toBe(student.user.id);
    expect(linked.githubUsername).toBe("octocat");

    const repo = await getRepoByAssignmentStudent(env.DB, assignment.id, rosterStudentId);
    expect(repo?.repoName).toBe("hw1-octocat");
  });

  it("skip path: creates a fresh student row when no rosterStudentId is given", async () => {
    const { classroom, assignment } = await setup({ githubId: 20, login: "skip" });
    const student = await seedUserAndCookie({ githubId: 21, login: "skipper" });

    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: student.cookie },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    const roster = await listStudentsByClassroom(env.DB, classroom.id);
    expect(roster).toHaveLength(1);
    expect(roster[0].userId).toBe(student.user.id);
    expect(roster[0].rosterIdentifier).toBeNull();
  });

  it("idempotent: a second accept returns the existing repo (already_accepted) with no duplicate row", async () => {
    const { classroom, assignment } = await setup({ githubId: 30, login: "idem" });
    const student = await seedUserAndCookie({ githubId: 31, login: "twice" });

    const first = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: student.cookie },
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { status: string } };
    expect(firstBody.data.status).toBe("invited");

    const second = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: student.cookie },
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(201);
    const body = (await second.json()) as { data: { repoUrl: string; status: string } };
    expect(body.data.repoUrl).toBe("https://github.com/test-org/hw1-twice");
    // already_accepted is only reachable via the idempotency short-circuit, which
    // runs before any GitHub call — so this status proves no repeat egress.
    expect(body.data.status).toBe("already_accepted");

    const roster = await listStudentsByClassroom(env.DB, classroom.id);
    expect(roster).toHaveLength(1);
  });

  it("claim-already-claimed → 409", async () => {
    const { classroom, assignment } = await setup({ githubId: 40, login: "conflict", seed: ["dupe"] });
    const rosterStudentId = (await listStudentsByClassroom(env.DB, classroom.id))[0].id;

    const first = await seedUserAndCookie({ githubId: 41, login: "first" });
    const claimRes = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: first.cookie },
      body: JSON.stringify({ rosterStudentId }),
    });
    expect(claimRes.status).toBe(201);

    const second = await seedUserAndCookie({ githubId: 42, login: "second" });
    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: second.cookie },
      body: JSON.stringify({ rosterStudentId }),
    });
    expect(res.status).toBe(409);
  });

  it("401s when unauthenticated", async () => {
    const { assignment } = await setup({ githubId: 50, login: "unauth" });
    const res = await SELF.fetch(`https://example.com/api/assignments/${assignment.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});
