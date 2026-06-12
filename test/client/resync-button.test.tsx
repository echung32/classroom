import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResyncButton from "@/components/ResyncButton";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

describe("ResyncButton", () => {
  it("posts to resync and renders the re-issued invitation", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        data: { status: "invited", invitationUrl: "https://github.com/test-org/hw1-a/invitations" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ResyncButton assignmentId="a1" />);
    await user.click(screen.getByRole("button", { name: "Fix my access" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assignments/a1/resync",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText(/Invite re-sent/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "accept it on GitHub" })).toBeTruthy();
  });

  it("renders the already_member outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { data: { status: "already_member" } })),
    );
    const user = userEvent.setup();

    render(<ResyncButton assignmentId="a1" />);
    await user.click(screen.getByRole("button", { name: "Fix my access" }));

    expect(await screen.findByText(/already have push access/)).toBeTruthy();
  });

  it("renders API errors inline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: { message: "Accept the assignment first" } })),
    );
    const user = userEvent.setup();

    render(<ResyncButton assignmentId="a1" />);
    await user.click(screen.getByRole("button", { name: "Fix my access" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Accept the assignment first",
    );
  });
});
