import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import StatusBoard, { type EvalResult } from "@/components/StatusBoard";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

function makeInitial(): EvalResult {
  return {
    dueState: "evaluated",
    submissions: [
      {
        studentId: "s1",
        githubUsername: "alice",
        repoName: "hw1-alice",
        status: "on_time",
        deadlineSha: "aaaa111122223333",
        deadlineCommitAt: "2026-06-01T10:00:00Z",
        latestSha: "cccc555566667777",
        latestCommitAt: "2026-06-02T10:00:00Z",
        gradeDecision: "at_deadline",
        evaluatedAt: "2026-06-03T00:00:00Z",
      },
    ],
    errors: [],
  };
}

describe("StatusBoard", () => {
  it("renders the submission row: username, status badge, short SHAs", () => {
    render(<StatusBoard assignmentId="a1" initial={makeInitial()} graderRepo={null} />);
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("on_time")).toBeTruthy();
    expect(screen.getByText("aaaa111")).toBeTruthy();
    expect(screen.getByText("cccc555")).toBeTruthy();
  });

  it("PUTs a decision change and keeps the optimistic value on success", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { data: { studentId: "s1", gradeDecision: "accept_late" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<StatusBoard assignmentId="a1" initial={makeInitial()} graderRepo={null} />);
    await user.click(screen.getByLabelText("Decision for alice"));
    await user.click(screen.getByRole("option", { name: "Accept late" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assignments/a1/submissions/s1/decision",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ decision: "accept_late" }) }),
    );
    expect(screen.getByLabelText("Decision for alice").textContent).toContain("Accept late");
  });

  it("reverts the decision and shows an inline error when the PUT fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(404, { error: { message: "No evaluated submission for that student" } }),
      ),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<StatusBoard assignmentId="a1" initial={makeInitial()} graderRepo={null} />);
    await user.click(screen.getByLabelText("Decision for alice"));
    await user.click(screen.getByRole("option", { name: "Exclude" }));

    expect(await screen.findByText("No evaluated submission for that student")).toBeTruthy();
    expect(screen.getByLabelText("Decision for alice").textContent).toContain("At deadline");
  });

  it("Refresh replaces rows from the POST /refresh response", async () => {
    const refreshed: EvalResult = {
      dueState: "evaluated",
      submissions: [
        {
          ...makeInitial().submissions[0]!,
          status: "late",
          latestSha: "ffff000011112222",
        },
      ],
      errors: [{ studentId: "s2", repoName: "hw1-bob", message: "GitHub request failed (404)" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { data: { assignmentId: "a1", ...refreshed } })),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<StatusBoard assignmentId="a1" initial={makeInitial()} graderRepo={null} />);
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("late")).toBeTruthy();
    expect(screen.getByText("ffff000")).toBeTruthy();
    expect(screen.getByText(/hw1-bob/)).toBeTruthy();
  });

  it("Build grader renders the included/skipped result panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          data: {
            assignmentId: "a1",
            graderRepo: "my-org/grader-hw1",
            htmlUrl: "https://github.com/my-org/grader-hw1",
            commitSha: "9999888877776666",
            included: [{ username: "alice", sha: "aaaa111122223333", source: "deadline" }],
            skipped: [{ username: "bob", studentId: "s2", reason: "excluded" }],
          },
        }),
      ),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<StatusBoard assignmentId="a1" initial={makeInitial()} graderRepo={null} />);
    await user.click(screen.getByRole("button", { name: "Build grader" }));

    expect(await screen.findByText("my-org/grader-hw1")).toBeTruthy();
    expect(screen.getByText(/alice — deadline/)).toBeTruthy();
    expect(screen.getByText(/bob — excluded/)).toBeTruthy();
  });

  it("a failed decision change reverts only the affected row", async () => {
    const initial: EvalResult = {
      ...makeInitial(),
      submissions: [
        makeInitial().submissions[0]!,
        {
          ...makeInitial().submissions[0]!,
          studentId: "s2",
          githubUsername: "bob",
          repoName: "hw1-bob",
          gradeDecision: "accept_late",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: { message: "No evaluated submission for that student" } })),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<StatusBoard assignmentId="a1" initial={initial} graderRepo={null} />);
    await user.click(screen.getByLabelText("Decision for alice"));
    await user.click(screen.getByRole("option", { name: "Exclude" }));

    expect(await screen.findByText("No evaluated submission for that student")).toBeTruthy();
    expect(screen.getByLabelText("Decision for alice").textContent).toContain("At deadline");
    expect(screen.getByLabelText("Decision for bob").textContent).toContain("Accept late");
  });

  it("Build grader surfaces a 400 error in the panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, {
          error: { message: "Cannot build a grader before the assignment deadline has passed" },
        }),
      ),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<StatusBoard assignmentId="a1" initial={makeInitial()} graderRepo={null} />);
    await user.click(screen.getByRole("button", { name: "Build grader" }));

    expect(
      await screen.findByText("Cannot build a grader before the assignment deadline has passed"),
    ).toBeTruthy();
  });
});
