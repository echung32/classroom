import { describe, expect, it, vi } from "vitest";
import { evaluateAssignmentSubmissions } from "../../src/lib/domain/evaluation";

const DEADLINE = "2026-01-01T00:00:00Z";
const PAST_NOW = "2026-06-01T00:00:00Z";
const BEFORE_NOW = "2025-06-01T00:00:00Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function commit(sha: string, date: string) {
  return { sha, commit: { committer: { date } } };
}

// Minimal in-memory stand-ins for the db helpers the orchestrator calls. We
// inject them through `deps` so the orchestrator never touches a real D1.
function makeDeps(overrides: Partial<Parameters<typeof evaluateAssignmentSubmissions>[0]>) {
  const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("hw1-late")) {
      if (u.includes("until=")) return jsonResponse([commit("d-late", "2025-12-31T00:00:00Z")]);
      return jsonResponse([commit("l-late", "2026-02-01T00:00:00Z"), commit("tmpl", "2025-12-30T00:00:00Z")]);
    }
    // ontime
    if (u.includes("until=")) return jsonResponse([commit("d-ontime", "2025-12-31T00:00:00Z")]);
    return jsonResponse([commit("l-ontime", "2025-12-31T00:00:00Z"), commit("tmpl", "2025-12-30T00:00:00Z")]);
  });
  return {
    token: "ghs_x",
    fetchImpl,
    loadAssignment: vi.fn(async () => ({ id: "a1", classroomId: "c1", deadlineAt: DEADLINE })),
    loadClassroom: vi.fn(async () => ({ id: "c1", githubOrg: "org" })),
    listRepos: vi.fn(async () => [
      { studentId: "s1", repoName: "hw1-ontime", githubUsername: "ontime" },
      { studentId: "s2", repoName: "hw1-late", githubUsername: "late" },
    ]),
    getSubmission: vi.fn(async () => null),
    freezeSubmission: vi.fn(async () => {}),
    refreshSubmissionStatus: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("evaluateAssignmentSubmissions", () => {
  it("returns no-deadline without GitHub calls when the assignment has no deadline", async () => {
    const deps = makeDeps({ loadAssignment: vi.fn(async () => ({ id: "a1", classroomId: "c1", deadlineAt: null })) });
    const result = await evaluateAssignmentSubmissions(deps, { assignmentId: "a1", now: PAST_NOW, refresh: false });
    expect(result.dueState).toBe("no-deadline");
    expect(result.submissions.every((s) => s.status === null)).toBe(true);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.freezeSubmission).not.toHaveBeenCalled();
  });

  it("returns pending without freezing when now is before the deadline", async () => {
    const deps = makeDeps({});
    const result = await evaluateAssignmentSubmissions(deps, { assignmentId: "a1", now: BEFORE_NOW, refresh: false });
    expect(result.dueState).toBe("pending");
    expect(result.submissions.every((s) => s.status === "pending")).toBe(true);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.freezeSubmission).not.toHaveBeenCalled();
  });

  it("evaluates + freezes each repo past the deadline", async () => {
    const frozen: Record<string, string> = {};
    const deps = makeDeps({
      freezeSubmission: vi.fn(async (input: { studentId: string; status: string }) => {
        frozen[input.studentId] = input.status;
      }),
      getSubmission: vi.fn(async (_a: string, studentId: string) =>
        frozen[studentId]
          ? {
              assignmentId: "a1",
              studentId,
              deadlineSha: "d",
              deadlineCommitAt: "2025-12-31T00:00:00Z",
              latestSha: null,
              latestCommitAt: "x",
              status: frozen[studentId],
              gradeDecision: "at_deadline",
              evaluatedAt: "2026-06-01T00:00:00Z",
            }
          : null,
      ),
    });
    const result = await evaluateAssignmentSubmissions(deps, { assignmentId: "a1", now: PAST_NOW, refresh: false });
    expect(result.dueState).toBe("evaluated");
    expect(frozen).toEqual({ s1: "on_time", s2: "late" });
    expect(result.errors).toEqual([]);
  });

  it("uses the cached row (no GitHub call) for an already-evaluated repo when refresh is false", async () => {
    const deps = makeDeps({
      listRepos: vi.fn(async () => [{ studentId: "s1", repoName: "hw1-ontime", githubUsername: "ontime" }]),
      getSubmission: vi.fn(async () => ({
        assignmentId: "a1",
        studentId: "s1",
        deadlineSha: "frozen",
        deadlineCommitAt: "2025-12-31T00:00:00Z",
        latestSha: null,
        latestCommitAt: "2025-12-31T00:00:00Z",
        status: "on_time",
        gradeDecision: "at_deadline",
        evaluatedAt: "2026-05-01T00:00:00Z",
      })),
    });
    const result = await evaluateAssignmentSubmissions(deps, { assignmentId: "a1", now: PAST_NOW, refresh: false });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.freezeSubmission).not.toHaveBeenCalled();
    expect(result.submissions[0].status).toBe("on_time");
  });

  it("surfaces latestSha and gradeDecision in evaluated submission views", async () => {
    const deps = makeDeps({
      getSubmission: vi.fn(async () => ({
        deadlineSha: "dsha",
        deadlineCommitAt: "2025-12-31T00:00:00Z",
        latestSha: "lsha",
        latestCommitAt: "2026-02-01T00:00:00Z",
        status: "late",
        gradeDecision: "accept_late",
        evaluatedAt: "2026-02-02T00:00:00Z",
      })),
    });
    const result = await evaluateAssignmentSubmissions(deps, {
      assignmentId: "a1",
      now: PAST_NOW,
      refresh: false,
    });
    expect(result.submissions[0]).toMatchObject({ latestSha: "lsha", gradeDecision: "accept_late" });
  });

  it("records a per-repo error and continues when a repo's GitHub read fails", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("hw1-late")) return jsonResponse({ message: "not found" }, 404);
        if (String(url).includes("until=")) return jsonResponse([commit("d-ontime", "2025-12-31T00:00:00Z")]);
        return jsonResponse([commit("l-ontime", "2025-12-31T00:00:00Z"), commit("tmpl", "2025-12-30T00:00:00Z")]);
      }),
    });
    const result = await evaluateAssignmentSubmissions(deps, { assignmentId: "a1", now: PAST_NOW, refresh: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].repoName).toBe("hw1-late");
  });
});
