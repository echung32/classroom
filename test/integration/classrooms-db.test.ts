import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createClassroom, getClassroomById } from "../../src/lib/db/classrooms";
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
