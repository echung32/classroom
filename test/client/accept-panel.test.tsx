import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AcceptPanel from "@/components/AcceptPanel";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

const rosterOptions = [
  { id: "11111111-1111-4111-8111-111111111111", rosterIdentifier: "Ada Lovelace" },
  { id: "22222222-2222-4222-8222-222222222222", rosterIdentifier: "Bob Smith" },
];

describe("AcceptPanel", () => {
  it("disables Accept until a roster choice is made", () => {
    render(<AcceptPanel assignmentId="a1" enrolled={false} rosterOptions={rosterOptions} />);
    const button = screen.getByRole("button", { name: "Accept assignment" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("claim path: sends the selected rosterStudentId and renders the success state", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        data: {
          repoUrl: "https://github.com/test-org/hw1-ada",
          invitationUrl: "https://github.com/test-org/hw1-ada/invitations",
          status: "invited",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<AcceptPanel assignmentId="a1" enrolled={false} rosterOptions={rosterOptions} />);
    await user.click(screen.getByLabelText("Roster name"));
    await user.click(screen.getByRole("option", { name: "Ada Lovelace" }));
    await user.click(screen.getByRole("button", { name: "Accept assignment" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assignments/a1/accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ rosterStudentId: rosterOptions[0].id }),
      }),
    );
    expect(await screen.findByText("https://github.com/test-org/hw1-ada")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Accept the invite on GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it('skip path: "I\'m not on the list" sends no rosterStudentId', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        data: { repoUrl: "https://github.com/test-org/hw1-x", status: "invited" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<AcceptPanel assignmentId="a1" enrolled={false} rosterOptions={rosterOptions} />);
    await user.click(screen.getByLabelText("Roster name"));
    await user.click(screen.getByRole("option", { name: "I'm not on the list" }));
    await user.click(screen.getByRole("button", { name: "Accept assignment" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assignments/a1/accept",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(await screen.findByText("https://github.com/test-org/hw1-x")).toBeTruthy();
  });

  it("renders a 409 conflict inline and keeps the form usable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(409, { error: { message: "This roster entry has already been claimed" } }),
      ),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<AcceptPanel assignmentId="a1" enrolled={false} rosterOptions={rosterOptions} />);
    await user.click(screen.getByLabelText("Roster name"));
    await user.click(screen.getByRole("option", { name: "Bob Smith" }));
    await user.click(screen.getByRole("button", { name: "Accept assignment" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "This roster entry has already been claimed",
    );
    expect(screen.getByRole("button", { name: "Accept assignment" })).toBeTruthy();
  });

  it("appends a retry note on 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(502, { error: { message: "GitHub request failed (500)" } })),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<AcceptPanel assignmentId="a1" enrolled={true} rosterOptions={[]} />);
    await user.click(screen.getByRole("button", { name: "Accept assignment" }));

    expect((await screen.findByRole("alert")).textContent).toContain("try again");
  });

  it("enrolled mode: no select, accept posts an empty body, already_accepted renders success", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        data: { repoUrl: "https://github.com/test-org/hw1-y", status: "already_accepted" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<AcceptPanel assignmentId="a1" enrolled={true} rosterOptions={[]} />);
    expect(screen.queryByLabelText("Roster name")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Accept assignment" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assignments/a1/accept",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(await screen.findByText("https://github.com/test-org/hw1-y")).toBeTruthy();
  });
});
