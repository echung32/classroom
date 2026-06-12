import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import CreateClassroomForm from "@/components/CreateClassroomForm";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

describe("CreateClassroomForm", () => {
  it("POSTs the classroom payload and calls onSuccess on 201", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { data: { id: "c1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn();
    const user = userEvent.setup();

    render(<CreateClassroomForm onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText("Name"), "CS101");
    await user.type(screen.getByLabelText("GitHub org"), "my-org");
    await user.click(screen.getByRole("button", { name: "Create classroom" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/classrooms",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "CS101", github_org: "my-org", timezone: "UTC" }),
      }),
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it("renders per-field errors from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, {
          error: { message: "Validation failed", fields: { github_org: "github_org is required" } },
        }),
      ),
    );
    const onSuccess = vi.fn();
    const user = userEvent.setup();

    render(<CreateClassroomForm onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText("Name"), "CS101");
    await user.click(screen.getByRole("button", { name: "Create classroom" }));

    expect(await screen.findByText("github_org is required")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Validation failed");
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
