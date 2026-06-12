import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createClassroom } from "../../src/lib/db/classrooms";
import { seedUserAndCookie } from "./helpers";
import { env } from "cloudflare:test";

async function makeClassroom(ownerId: string) {
  return createClassroom(env.DB, {
    name: "CS101",
    githubOrg: "test-org",
    timezone: "UTC",
    createdBy: ownerId,
  });
}

describe("POST/GET /api/classrooms/:id/students", () => {
  it("seeds unclaimed roster rows and lists them (201/200)", async () => {
    const { user, cookie } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const classroom = await makeClassroom(user.id);

    const seedRes = await SELF.fetch(`https://example.com/api/classrooms/${classroom.id}/students`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ identifiers: ["alice", "bob"] }),
    });
    expect(seedRes.status).toBe(201);
    const seeded = (await seedRes.json()) as { data: Array<{ rosterIdentifier: string; userId: string | null }> };
    expect(seeded.data.map((s) => s.rosterIdentifier).sort()).toEqual(["alice", "bob"]);
    expect(seeded.data.every((s) => s.userId === null)).toBe(true);

    const listRes = await SELF.fetch(`https://example.com/api/classrooms/${classroom.id}/students`, {
      headers: { cookie },
    });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { data: unknown[] };
    expect(listed.data).toHaveLength(2);
  });

  it("is idempotent — re-seeding the same identifiers adds no duplicates", async () => {
    const { user, cookie } = await seedUserAndCookie({ githubId: 2, login: "teacher2" });
    const classroom = await makeClassroom(user.id);
    const body = JSON.stringify({ identifiers: ["alice", "alice", "bob"] });

    await SELF.fetch(`https://example.com/api/classrooms/${classroom.id}/students`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body,
    });
    const res = await SELF.fetch(`https://example.com/api/classrooms/${classroom.id}/students`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body,
    });
    const out = (await res.json()) as { data: unknown[] };
    expect(out.data).toHaveLength(2);
  });

  it("rejects a non-owner (403)", async () => {
    const owner = await seedUserAndCookie({ githubId: 3, login: "owner" });
    const stranger = await seedUserAndCookie({ githubId: 4, login: "stranger" });
    const classroom = await makeClassroom(owner.user.id);

    const res = await SELF.fetch(`https://example.com/api/classrooms/${classroom.id}/students`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: stranger.cookie },
      body: JSON.stringify({ identifiers: ["x"] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request (401)", async () => {
    const { user } = await seedUserAndCookie({ githubId: 5, login: "owner2" });
    const classroom = await makeClassroom(user.id);
    const res = await SELF.fetch(`https://example.com/api/classrooms/${classroom.id}/students`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifiers: ["x"] }),
    });
    expect(res.status).toBe(401);
  });
});
