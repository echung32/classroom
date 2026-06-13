import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../src/lib/http/errors";
import { AssignmentNotFoundError } from "../../src/lib/domain/evaluation";
import { buildGrader, type GraderBuildDeps } from "../../src/lib/domain/grader-build";

const DEADLINE = "2026-01-01T00:00:00Z";
const AFTER = "2026-02-01T00:00:00Z";
const BEFORE = "2025-12-01T00:00:00Z";

function makeDeps(over: Partial<GraderBuildDeps> = {}): GraderBuildDeps {
  return {
    token: "t",
    org: "org",
    fetchImpl: vi.fn(),
    loadAssignment: vi.fn(async () => ({
      id: "a1", classroomId: "c1", slug: "hw1", title: "HW 1", deadlineAt: DEADLINE,
    })),
    loadClassroom: vi.fn(async () => ({ id: "c1" })),
    listSubmissionsWithStudents: vi.fn(async () => [
      { studentId: "s1", githubUsername: "ada", repoName: "hw1-ada", gradeDecision: "at_deadline", deadlineSha: "d-ada", latestSha: "l-ada", status: "on_time" },
    ]),
    setGraderBuilt: vi.fn(async () => {}),
    ensureOrgRepo: vi.fn(async () => ({ fullName: "org/grader-hw1", htmlUrl: "https://github.com/org/grader-hw1" })),
    createTree: vi.fn(async () => "tree-sha"),
    getMainRef: vi.fn(async () => null),
    createCommit: vi.fn(async () => "commit-sha"),
    createMainRef: vi.fn(async () => {}),
    updateMainRef: vi.fn(async () => {}),
    ...over,
  };
}

describe("buildGrader", () => {
  it("builds the grader, pins included SHAs, sets grader_repo + returns the result", async () => {
    const deps = makeDeps();
    const result = await buildGrader(deps, { assignmentId: "a1", now: AFTER });
    expect(result.graderRepo).toBe("org/grader-hw1");
    expect(result.htmlUrl).toBe("https://github.com/org/grader-hw1");
    expect(result.commitSha).toBe("commit-sha");
    expect(result.included).toEqual([{ username: "ada", sha: "d-ada", source: "deadline" }]);
    expect(result.skipped).toEqual([]);
    expect(deps.ensureOrgRepo).toHaveBeenCalledWith(expect.objectContaining({ org: "org", name: "grader-hw1" }));
    expect(deps.setGraderBuilt).toHaveBeenCalledWith("a1", "org/grader-hw1");
    // first build: no parent → createMainRef, not updateMainRef
    expect(deps.createMainRef).toHaveBeenCalledOnce();
    expect(deps.updateMainRef).not.toHaveBeenCalled();
    // the tree carries a 160000 gitlink for the included entry
    const treeArg = (deps.createTree as ReturnType<typeof vi.fn>).mock.calls[0][0].tree;
    expect(treeArg).toContainEqual({ path: "submissions/ada", mode: "160000", type: "commit", sha: "d-ada" });
  });

  it("updates main when a parent ref exists (rebuild)", async () => {
    const deps = makeDeps({ getMainRef: vi.fn(async () => "old-sha") });
    await buildGrader(deps, { assignmentId: "a1", now: AFTER });
    expect(deps.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: ["old-sha"] }));
    expect(deps.updateMainRef).toHaveBeenCalledOnce();
    expect(deps.createMainRef).not.toHaveBeenCalled();
  });

  it("throws AssignmentNotFoundError when the assignment is missing", async () => {
    const deps = makeDeps({ loadAssignment: vi.fn(async () => null) });
    await expect(buildGrader(deps, { assignmentId: "a1", now: AFTER })).rejects.toBeInstanceOf(
      AssignmentNotFoundError,
    );
  });

  it("rejects with 400 (ValidationError) when the deadline has not passed", async () => {
    const deps = makeDeps();
    await expect(buildGrader(deps, { assignmentId: "a1", now: BEFORE })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(deps.ensureOrgRepo).not.toHaveBeenCalled();
  });

  it("rejects with 400 when there is no deadline at all", async () => {
    const deps = makeDeps({
      loadAssignment: vi.fn(async () => ({ id: "a1", classroomId: "c1", slug: "hw1", title: "HW 1", deadlineAt: null })),
    });
    await expect(buildGrader(deps, { assignmentId: "a1", now: AFTER })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects with 400 when nothing is includable (all skipped)", async () => {
    const deps = makeDeps({
      listSubmissionsWithStudents: vi.fn(async () => [
        { studentId: "s1", githubUsername: "ada", repoName: "hw1-ada", gradeDecision: "exclude", deadlineSha: "d", latestSha: "l", status: "on_time" },
      ]),
    });
    await expect(buildGrader(deps, { assignmentId: "a1", now: AFTER })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(deps.ensureOrgRepo).not.toHaveBeenCalled();
  });

  it("reports skipped entries in the result", async () => {
    const deps = makeDeps({
      listSubmissionsWithStudents: vi.fn(async () => [
        { studentId: "s1", githubUsername: "ada", repoName: "hw1-ada", gradeDecision: "at_deadline", deadlineSha: "d-ada", latestSha: "l-ada", status: "on_time" },
        { studentId: "s2", githubUsername: "ben", repoName: "hw1-ben", gradeDecision: "exclude", deadlineSha: "d", latestSha: "l", status: "on_time" },
      ]),
    });
    const result = await buildGrader(deps, { assignmentId: "a1", now: AFTER });
    expect(result.included.map((e) => e.username)).toEqual(["ada"]);
    expect(result.skipped).toEqual([{ username: "ben", studentId: "s2", reason: "excluded" }]);
  });
});
