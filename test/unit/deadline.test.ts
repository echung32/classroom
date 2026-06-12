import { describe, expect, it } from "vitest";
import { classifySubmission } from "../../src/lib/domain/deadline";

const DEADLINE = "2026-01-01T00:00:00Z";

describe("classifySubmission", () => {
  it("returns missing when there are no student commits", () => {
    expect(
      classifySubmission({ deadlineAt: DEADLINE, latestCommitAt: null, hasStudentCommits: false }),
    ).toBe("missing");
  });

  it("returns missing for template-only repos even if a commit timestamp is present", () => {
    expect(
      classifySubmission({
        deadlineAt: DEADLINE,
        latestCommitAt: "2025-12-30T00:00:00Z",
        hasStudentCommits: false,
      }),
    ).toBe("missing");
  });

  it("treats a commit exactly at the deadline as on_time", () => {
    expect(
      classifySubmission({ deadlineAt: DEADLINE, latestCommitAt: DEADLINE, hasStudentCommits: true }),
    ).toBe("on_time");
  });

  it("treats a commit one second before the deadline as on_time", () => {
    expect(
      classifySubmission({
        deadlineAt: DEADLINE,
        latestCommitAt: "2025-12-31T23:59:59Z",
        hasStudentCommits: true,
      }),
    ).toBe("on_time");
  });

  it("treats a commit one second after the deadline as late", () => {
    expect(
      classifySubmission({
        deadlineAt: DEADLINE,
        latestCommitAt: "2026-01-01T00:00:01Z",
        hasStudentCommits: true,
      }),
    ).toBe("late");
  });

  it("returns late when all student work is after the deadline", () => {
    expect(
      classifySubmission({
        deadlineAt: DEADLINE,
        latestCommitAt: "2026-02-01T12:00:00Z",
        hasStudentCommits: true,
      }),
    ).toBe("late");
  });
});
