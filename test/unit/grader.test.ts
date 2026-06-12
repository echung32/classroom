import { describe, expect, it } from "vitest";
import {
  buildDevcontainer,
  buildGitmodules,
  buildReadme,
  selectGraderEntries,
  type SubmissionForSelection,
} from "../../src/lib/domain/grader";

function sub(over: Partial<SubmissionForSelection>): SubmissionForSelection {
  return {
    studentId: "s",
    githubUsername: "user",
    repoName: "hw1-user",
    gradeDecision: "at_deadline",
    deadlineSha: "dsha",
    latestSha: "lsha",
    ...over,
  };
}

describe("selectGraderEntries", () => {
  it("pins deadline_sha for at_deadline and latest_sha for accept_late; excludes exclude", () => {
    const { included, skipped } = selectGraderEntries([
      sub({ studentId: "a", githubUsername: "ada", repoName: "hw1-ada", gradeDecision: "at_deadline", deadlineSha: "d-a", latestSha: "l-a" }),
      sub({ studentId: "b", githubUsername: "ben", repoName: "hw1-ben", gradeDecision: "accept_late", deadlineSha: "d-b", latestSha: "l-b" }),
      sub({ studentId: "c", githubUsername: "cid", repoName: "hw1-cid", gradeDecision: "exclude", deadlineSha: "d-c", latestSha: "l-c" }),
    ]);
    expect(included).toEqual([
      { username: "ada", repoName: "hw1-ada", sha: "d-a", source: "deadline" },
      { username: "ben", repoName: "hw1-ben", sha: "l-b", source: "latest" },
    ]);
    expect(skipped).toEqual([{ username: "cid", studentId: "c", reason: "excluded" }]);
  });

  it("skips a null selected SHA with the matching reason (not a failure)", () => {
    const { included, skipped } = selectGraderEntries([
      sub({ studentId: "a", githubUsername: "ada", gradeDecision: "at_deadline", deadlineSha: null }),
      sub({ studentId: "b", githubUsername: "ben", gradeDecision: "accept_late", latestSha: null }),
    ]);
    expect(included).toEqual([]);
    expect(skipped).toEqual([
      { username: "ada", studentId: "a", reason: "no-deadline-sha" },
      { username: "ben", studentId: "b", reason: "no-latest-sha" },
    ]);
  });

  it("skips a student with no github username", () => {
    const { included, skipped } = selectGraderEntries([
      sub({ studentId: "a", githubUsername: null, repoName: null }),
    ]);
    expect(included).toEqual([]);
    expect(skipped).toEqual([{ username: null, studentId: "a", reason: "no-github-username" }]);
  });

  it("orders included entries deterministically by username", () => {
    const { included } = selectGraderEntries([
      sub({ studentId: "z", githubUsername: "zed", repoName: "hw1-zed", deadlineSha: "d-z" }),
      sub({ studentId: "a", githubUsername: "ann", repoName: "hw1-ann", deadlineSha: "d-a" }),
    ]);
    expect(included.map((e) => e.username)).toEqual(["ann", "zed"]);
  });
});

describe("buildGitmodules", () => {
  it("emits one submodule block per entry, ordered by username", () => {
    const text = buildGitmodules(
      [
        { username: "ann", repoName: "hw1-ann", sha: "x", source: "deadline" },
        { username: "zed", repoName: "hw1-zed", sha: "y", source: "latest" },
      ],
      "org",
    );
    expect(text).toBe(
      `[submodule "submissions/ann"]\n` +
        `\tpath = submissions/ann\n` +
        `\turl = https://github.com/org/hw1-ann.git\n` +
        `[submodule "submissions/zed"]\n` +
        `\tpath = submissions/zed\n` +
        `\turl = https://github.com/org/hw1-zed.git\n`,
    );
  });
});

describe("buildDevcontainer", () => {
  it("includes one codespaces repositories read entry per included repo + postCreateCommand", () => {
    const text = buildDevcontainer(
      [
        { username: "ann", repoName: "hw1-ann", sha: "x", source: "deadline" },
        { username: "zed", repoName: "hw1-zed", sha: "y", source: "latest" },
      ],
      "org",
      "grader-hw1",
    );
    const obj = JSON.parse(text);
    expect(obj.name).toBe("grader-hw1");
    expect(obj.postCreateCommand).toBe("git submodule update --init --recursive");
    expect(obj.customizations.codespaces.repositories).toEqual({
      "org/hw1-ann": { permissions: { contents: "read" } },
      "org/hw1-zed": { permissions: { contents: "read" } },
    });
  });
});

describe("buildReadme", () => {
  it("names the assignment and lists pinned submissions", () => {
    const text = buildReadme("Assignment 3", [
      { username: "ann", repoName: "hw1-ann", sha: "abc123", source: "deadline" },
    ]);
    expect(text).toContain("Assignment 3");
    expect(text).toContain("ann");
    expect(text).toContain("abc123");
  });
});
