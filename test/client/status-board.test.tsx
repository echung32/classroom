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
});
