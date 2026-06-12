import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import RosterPanel from "@/components/RosterPanel";

afterEach(() => vi.unstubAllGlobals());

const students = [
  { id: "s1", rosterIdentifier: "Ada Lovelace", githubUsername: "ada" },
  { id: "s2", rosterIdentifier: "Bob Smith", githubUsername: null },
];

describe("RosterPanel", () => {
  it("lists students with their link state", () => {
    render(<RosterPanel classroomId="c1" students={students} onSuccess={() => {}} />);
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("ada")).toBeTruthy();
    expect(screen.getByText("Bob Smith")).toBeTruthy();
    expect(screen.getByText("unlinked")).toBeTruthy();
  });

  it("parses the textarea into identifiers and POSTs them", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ data: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn();
    const user = userEvent.setup();

    render(<RosterPanel classroomId="c1" students={[]} onSuccess={onSuccess} />);
    await user.type(
      screen.getByLabelText("Roster names (one per line)"),
      "Carol Chen{enter}  {enter}Dan Diaz",
    );
    await user.click(screen.getByRole("button", { name: "Add to roster" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/classrooms/c1/students",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ identifiers: ["Carol Chen", "Dan Diaz"] }),
      }),
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it("shows an error and does not POST when all lines are blank", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<RosterPanel classroomId="c1" students={[]} onSuccess={() => {}} />);
    await user.type(screen.getByLabelText("Roster names (one per line)"), "   {enter}  ");
    await user.click(screen.getByRole("button", { name: "Add to roster" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Enter at least one roster name");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
