import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../../src/lib/github/client";
import { ConflictError, NotFoundError, toResponse } from "../../src/lib/http/errors";

describe("toResponse — GitHubApiError mapping", () => {
  it("maps a GitHubApiError to 502 with a safe message (no upstream body leaked)", async () => {
    const err = new GitHubApiError("token=ghs_secret leaked detail", 404, {
      remaining: null,
      reset: null,
      retryAfterSeconds: null,
    });
    const res = toResponse(err);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Upstream GitHub request failed");
    expect(body.error.message).not.toContain("ghs_secret");
  });

  it("still maps existing domain errors to their own codes", async () => {
    expect(toResponse(new NotFoundError("x")).status).toBe(404);
    expect(toResponse(new ConflictError("x")).status).toBe(409);
  });
});
