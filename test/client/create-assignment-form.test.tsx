import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import CreateAssignmentForm from "@/components/CreateAssignmentForm";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

describe("CreateAssignmentForm", () => {
  it("POSTs the assignment with deadline converted to UTC ISO", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { data: { id: "a1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn();
    const user = userEvent.setup();

    render(<CreateAssignmentForm classroomId="c1" onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText("Slug"), "hw1");
    await user.type(screen.getByLabelText("Title"), "Homework 1");
    await user.type(screen.getByLabelText("Template repo"), "org/hw1-template");
    fireEvent.change(screen.getByLabelText("Deadline"), {
      target: { value: "2026-06-30T23:59" },
    });
    await user.click(screen.getByRole("button", { name: "Create assignment" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/classrooms/c1/assignments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          slug: "hw1",
          title: "Homework 1",
          template_repo: "org/hw1-template",
          deadline_at: new Date("2026-06-30T23:59").toISOString(),
        }),
      }),
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it("omits deadline_at when the deadline is blank and shows field errors", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, {
        error: { message: "Validation failed", fields: { slug: "slug must be url-safe: lowercase, hyphen-separated, 1–60 chars" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<CreateAssignmentForm classroomId="c1" onSuccess={() => {}} />);
    await user.type(screen.getByLabelText("Slug"), "Bad Slug");
    await user.type(screen.getByLabelText("Title"), "Homework 1");
    await user.type(screen.getByLabelText("Template repo"), "org/hw1-template");
    await user.click(screen.getByRole("button", { name: "Create assignment" }));

    const sentBody = JSON.parse(((fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1]).body as string);
    expect(sentBody).not.toHaveProperty("deadline_at");
    expect(await screen.findByText(/slug must be url-safe/)).toBeTruthy();
  });
});
