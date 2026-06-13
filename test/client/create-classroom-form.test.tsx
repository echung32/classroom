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
    await user.click(screen.getByRole("button", { name: "Create classroom" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/classrooms",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "CS101", timezone: "UTC" }),
      }),
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it("renders per-field errors from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, {
          error: { message: "Validation failed", fields: { name: "name is required" } },
        }),
      ),
    );
    const onSuccess = vi.fn();
    const user = userEvent.setup();

    render(<CreateClassroomForm onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText("Name"), "CS101");
    await user.click(screen.getByRole("button", { name: "Create classroom" }));

    expect(await screen.findByText("name is required")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Validation failed");
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
