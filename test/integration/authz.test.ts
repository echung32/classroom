import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { assertOwnsClassroom } from "../../src/lib/domain/authz";
import { createClassroom } from "../../src/lib/db/classrooms";
import { ForbiddenError, NotFoundError } from "../../src/lib/http/errors";
import { seedUserAndCookie } from "./helpers";

describe("assertOwnsClassroom", () => {
  it("returns the classroom when the user owns it", async () => {
    const { user } = await seedUserAndCookie({ githubId: 1, login: "owner" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: user.id,
    });
    const result = await assertOwnsClassroom(env.DB, classroom.id, user.id);
    expect(result.id).toBe(classroom.id);
  });

  it("throws NotFoundError for an unknown classroom id", async () => {
    const { user } = await seedUserAndCookie({ githubId: 1, login: "owner" });
    await expect(assertOwnsClassroom(env.DB, "missing-id", user.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws ForbiddenError when the user is not the owner", async () => {
    const { user: owner } = await seedUserAndCookie({ githubId: 1, login: "owner" });
    const { user: other } = await seedUserAndCookie({ githubId: 2, login: "intruder" });
    const classroom = await createClassroom(env.DB, {
      name: "CS101",
      githubOrg: "my-org",
      timezone: "UTC",
      createdBy: owner.id,
    });
    await expect(assertOwnsClassroom(env.DB, classroom.id, other.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
