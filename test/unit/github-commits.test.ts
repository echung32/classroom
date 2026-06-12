import { describe, expect, it, vi } from "vitest";
import { readRepoCommitState } from "../../src/lib/github/commits";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DEADLINE = "2026-01-01T00:00:00Z";

function commit(sha: string, date: string) {
  return { sha, commit: { committer: { date } } };
}

describe("readRepoCommitState", () => {
  it("issues the two documented requests and maps an on-time repo", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("until=")) {
        return jsonResponse([commit("deadline-sha", "2025-12-31T00:00:00Z")]);
      }
      return jsonResponse([
        commit("latest-sha", "2025-12-31T00:00:00Z"),
        commit("template-sha", "2025-12-30T00:00:00Z"),
      ]);
    });

    const state = await readRepoCommitState({
      token: "ghs_x",
      owner: "org",
      repo: "hw1-ontime",
      deadlineAt: DEADLINE,
      fetchImpl,
    });

    const latestUrl = String((fetchImpl.mock.calls[0] as [string])[0]);
    const untilUrl = String((fetchImpl.mock.calls[1] as [string])[0]);
    expect(latestUrl).toBe("https://api.github.com/repos/org/hw1-ontime/commits?per_page=2");
    expect(untilUrl).toBe(
      `https://api.github.com/repos/org/hw1-ontime/commits?until=${encodeURIComponent(DEADLINE)}&per_page=1`,
    );
    expect(state).toEqual({
      latestCommitAt: "2025-12-31T00:00:00Z",
      latestSha: "latest-sha",
      hasStudentCommits: true,
      deadlineSha: "deadline-sha",
      deadlineCommitAt: "2025-12-31T00:00:00Z",
    });
  });

  it("maps a template-only repo as having no student commits", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("until=")) return jsonResponse([commit("template-sha", "2025-12-30T00:00:00Z")]);
      return jsonResponse([commit("template-sha", "2025-12-30T00:00:00Z")]);
    });

    const state = await readRepoCommitState({
      token: "ghs_x",
      owner: "org",
      repo: "hw1-missing",
      deadlineAt: DEADLINE,
      fetchImpl,
    });

    expect(state.hasStudentCommits).toBe(false);
    expect(state.latestCommitAt).toBe("2025-12-30T00:00:00Z");
    expect(state.deadlineSha).toBe("template-sha");
  });

  it("maps an empty repo (no commits) to nulls and no student commits", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));

    const state = await readRepoCommitState({
      token: "ghs_x",
      owner: "org",
      repo: "hw1-empty",
      deadlineAt: DEADLINE,
      fetchImpl,
    });

    expect(state).toEqual({
      latestCommitAt: null,
      latestSha: null,
      hasStudentCommits: false,
      deadlineSha: null,
      deadlineCommitAt: null,
    });
  });

  it("returns latestSha=null for a repo with no commits", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const state = await readRepoCommitState({
      token: "ghs_x",
      owner: "org",
      repo: "empty",
      deadlineAt: DEADLINE,
      fetchImpl,
    });
    expect(state.latestSha).toBeNull();
  });
});
