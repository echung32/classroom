import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/lib/http/errors";
import { assignmentSchema, classroomSchema } from "../../src/lib/http/schemas";
import { parseBody } from "../../src/lib/http/validation";

function req(body: unknown): Request {
  return new Request("https://x/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("parseBody + classroomSchema", () => {
  it("accepts valid input and defaults timezone to UTC", async () => {
    const out = await parseBody(req({ name: "CS101", github_org: "my-org" }), classroomSchema);
    expect(out).toEqual({ name: "CS101", github_org: "my-org", timezone: "UTC" });
  });

  it("accepts a valid IANA timezone", async () => {
    const out = await parseBody(
      req({ name: "CS101", github_org: "my-org", timezone: "America/New_York" }),
      classroomSchema,
    );
    expect(out.timezone).toBe("America/New_York");
  });

  it("rejects a blank name, blank org, and bad timezone with field messages", async () => {
    await expect(parseBody(req({ name: "", github_org: "o" }), classroomSchema)).rejects.toMatchObject({
      name: "ValidationError",
    });
    const err = await parseBody(
      req({ name: "CS101", github_org: "my-org", timezone: "Mars/Phobos" }),
      classroomSchema,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fields).toHaveProperty("timezone");
  });
});

describe("parseBody + assignmentSchema", () => {
  it("accepts valid input with no optional fields", async () => {
    const out = await parseBody(
      req({ slug: "hw1", title: "Homework 1", template_repo: "my-org/hw1-template" }),
      assignmentSchema,
    );
    expect(out).toEqual({
      slug: "hw1",
      title: "Homework 1",
      template_repo: "my-org/hw1-template",
    });
  });

  it("accepts an optional ISO-8601 UTC deadline", async () => {
    const out = await parseBody(
      req({
        slug: "hw1",
        title: "Homework 1",
        template_repo: "my-org/hw1-template",
        deadline_at: "2026-09-01T23:59:00Z",
      }),
      assignmentSchema,
    );
    expect(out.deadline_at).toBe("2026-09-01T23:59:00Z");
  });

  it("rejects an invalid slug", async () => {
    const err = await parseBody(
      req({ slug: "Bad Slug", title: "t", template_repo: "o/n" }),
      assignmentSchema,
    ).catch((e) => e);
    expect(err.fields).toHaveProperty("slug");
  });

  it("rejects a template_repo that is not owner/name", async () => {
    const err = await parseBody(
      req({ slug: "hw1", title: "t", template_repo: "no-slash" }),
      assignmentSchema,
    ).catch((e) => e);
    expect(err.fields).toHaveProperty("template_repo");
  });

  it("rejects a non-ISO deadline", async () => {
    const bad = await parseBody(
      req({ slug: "hw1", title: "t", template_repo: "o/n", deadline_at: "September 1st" }),
      assignmentSchema,
    ).catch((e) => e);
    expect(bad.fields).toHaveProperty("deadline_at");
  });

  it("throws ValidationError on a non-JSON body", async () => {
    const bad = new Request("https://x/api", { method: "POST", body: "not json{" });
    await expect(parseBody(bad, assignmentSchema)).rejects.toBeInstanceOf(ValidationError);
  });
});
