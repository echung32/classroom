import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createClassroom } from "../../src/lib/db/classrooms";
import { seedUserAndCookie } from "./helpers";

function postAssignment(classroomId: string, body: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/classrooms/${classroomId}/assignments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function ownedClassroom(githubId = 1, login = "teacher") {
  const { user, cookie } = await seedUserAndCookie({ githubId, login });
  const classroom = await createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "my-org",
    timezone: "UTC",
    createdBy: user.id,
  });
  return { classroom, cookie };
}

const VALID = { slug: "hw1", title: "Homework 1", template_repo: "my-org/hw1-template" };

describe("POST /api/classrooms/:id/assignments", () => {
  it("creates an assignment (201) with the persisted row", async () => {
    const { classroom, cookie } = await ownedClassroom();
    const res = await postAssignment(classroom.id, VALID, cookie);
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { slug: string; classroomId: string; status: string };
    };
    expect(data.slug).toBe("hw1");
    expect(data.classroomId).toBe(classroom.id);
    expect(data.status).toBe("open");
  });

  it("rejects a duplicate slug in the same classroom (409)", async () => {
    const { classroom, cookie } = await ownedClassroom();
    await postAssignment(classroom.id, VALID, cookie);
    const res = await postAssignment(classroom.id, VALID, cookie);
    expect(res.status).toBe(409);
  });

  it("allows the same slug in a different classroom (201)", async () => {
    const a = await ownedClassroom(1, "teacher-a");
    const b = await ownedClassroom(2, "teacher-b");
    expect((await postAssignment(a.classroom.id, VALID, a.cookie)).status).toBe(201);
    expect((await postAssignment(b.classroom.id, VALID, b.cookie)).status).toBe(201);
  });

  it("rejects an unauthenticated request (401)", async () => {
    const { classroom } = await ownedClassroom();
    expect((await postAssignment(classroom.id, VALID)).status).toBe(401);
  });

  it("returns 404 for an unknown classroom and 403 for a non-owner", async () => {
    const { classroom } = await ownedClassroom(1, "owner");
    const { cookie: intruder } = await seedUserAndCookie({ githubId: 2, login: "intruder" });
    expect(
      (await postAssignment("00000000-0000-0000-0000-000000000000", VALID, intruder)).status,
    ).toBe(404);
    expect((await postAssignment(classroom.id, VALID, intruder)).status).toBe(403);
  });

  it("rejects an invalid slug with a field message (400)", async () => {
    const { classroom, cookie } = await ownedClassroom();
    const res = await postAssignment(classroom.id, { ...VALID, slug: "Bad Slug" }, cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { fields?: Record<string, string> } };
    expect(body.error.fields).toHaveProperty("slug");
  });
});

describe("GET /api/assignments/:id", () => {
  function getAssignment(id: string, cookie?: string): Promise<Response> {
    return SELF.fetch(`https://example.com/api/assignments/${id}`, {
      headers: cookie ? { cookie } : {},
    });
  }

  async function createOne() {
    const { classroom, cookie } = await ownedClassroom();
    const created = await postAssignment(classroom.id, VALID, cookie);
    const { data } = (await created.json()) as { data: { id: string } };
    return { assignmentId: data.id, cookie };
  }

  it("returns the assignment to its owner (200)", async () => {
    const { assignmentId, cookie } = await createOne();
    const res = await getAssignment(assignmentId, cookie);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string; slug: string } };
    expect(data.id).toBe(assignmentId);
    expect(data.slug).toBe("hw1");
  });

  it("returns 401 when unauthenticated", async () => {
    const { assignmentId } = await createOne();
    expect((await getAssignment(assignmentId)).status).toBe(401);
  });

  it("returns 404 for an unknown assignment id", async () => {
    const { cookie } = await seedUserAndCookie({ githubId: 9, login: "someone" });
    expect((await getAssignment("00000000-0000-0000-0000-000000000000", cookie)).status).toBe(404);
  });

  it("returns 403 when the caller does not own the parent classroom", async () => {
    const { assignmentId } = await createOne();
    const { cookie: intruder } = await seedUserAndCookie({ githubId: 2, login: "intruder" });
    expect((await getAssignment(assignmentId, intruder)).status).toBe(403);
  });
});
