import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createClassroom, getClassroomById, listClassroomsByOwner } from "../../src/lib/db/classrooms";
import { seedUserAndCookie } from "./helpers";

describe("classrooms repository", () => {
  it("createClassroom inserts a row with a uuid, defaults, and created_by", async () => {
    const { user } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "America/New_York",
      createdBy: user.id,
    });

    expect(classroom.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(classroom.name).toBe("CS101");
    expect(classroom.githubOrg).toBe("my-org");
    expect(classroom.timezone).toBe("America/New_York");
    expect(classroom.createdBy).toBe(user.id);
    expect(classroom.createdAt).toBeTruthy();
  });

  it("getClassroomById returns the classroom or null", async () => {
    const { user } = await seedUserAndCookie({ githubId: 1, login: "teacher" });
    const created = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: user.id,
    });
    expect(await getClassroomById(env.DB, created.id)).toEqual(created);
    expect(await getClassroomById(env.DB, "missing-id")).toBeNull();
  });
});

describe("listClassroomsByOwner", () => {
  it("returns only the owner's classrooms, newest first", async () => {
    const { user: alice } = await seedUserAndCookie({ githubId: 1, login: "alice" });
    const { user: bob } = await seedUserAndCookie({ githubId: 2, login: "bob" });

    const older = await createClassroom(env.DB, {
      name: "Older", githubOrg: "org", timezone: "UTC", createdBy: alice.id,
    });
    await createClassroom(env.DB, {
      name: "Newer", githubOrg: "org", timezone: "UTC", createdBy: alice.id,
    });
    await createClassroom(env.DB, {
      name: "Bobs", githubOrg: "org", timezone: "UTC", createdBy: bob.id,
    });

    // created_at has second precision; push `older` into the past so the
    // DESC ordering assertion is deterministic.
    await env.DB
      .prepare("UPDATE classrooms SET created_at = datetime('now', '-1 hour') WHERE id = ?1")
      .bind(older.id)
      .run();

    const result = await listClassroomsByOwner(env.DB, alice.id);
    expect(result.map((c) => c.name)).toEqual(["Newer", "Older"]);
  });

  it("returns [] for a user who owns no classrooms", async () => {
    expect(await listClassroomsByOwner(env.DB, "nobody")).toEqual([]);
  });
});
