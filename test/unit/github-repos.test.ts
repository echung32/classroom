import { describe, expect, it, vi } from "vitest";
import { createRepoFromTemplate } from "../../src/lib/github/repos";
import { addCollaborator } from "../../src/lib/github/repos";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createRepoFromTemplate", () => {
  it("POSTs to the generate endpoint with the right body and maps the result", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ id: 42, full_name: "org/hw1-octocat", html_url: "https://github.com/org/hw1-octocat" }, 201),
    );

    const result = await createRepoFromTemplate({
      token: "ghs_x",
      templateOwner: "org",
      templateRepo: "hw1-template",
      owner: "org",
      name: "hw1-octocat",
      isPrivate: true,
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/org/hw1-template/generate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ owner: "org", name: "hw1-octocat", private: true });
    expect(result).toEqual({ repoId: 42, fullName: "org/hw1-octocat", htmlUrl: "https://github.com/org/hw1-octocat" });
  });

  it("recovers from a 422 (name already exists) by GETting the existing repo", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "name already exists on this account" }, 422))
      .mockResolvedValueOnce(
        jsonResponse({ id: 7, full_name: "org/hw1-octocat", html_url: "https://github.com/org/hw1-octocat" }, 200),
      );

    const result = await createRepoFromTemplate({
      token: "ghs_x",
      templateOwner: "org",
      templateRepo: "hw1-template",
      owner: "org",
      name: "hw1-octocat",
      isPrivate: true,
      fetchImpl,
    });

    expect((fetchImpl.mock.calls[1] as [string])[0]).toBe("https://api.github.com/repos/org/hw1-octocat");
    expect(result.repoId).toBe(7);
  });
});

describe("addCollaborator", () => {
  it("PUTs the permission and returns invited + invitationUrl on 201", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ html_url: "https://github.com/org/hw1-octocat/invitations" }, 201),
    );

    const result = await addCollaborator({
      token: "ghs_x",
      owner: "org",
      repo: "hw1-octocat",
      username: "octocat",
      permission: "push",
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/org/hw1-octocat/collaborators/octocat");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ permission: "push" });
    expect(result).toEqual({
      status: "invited",
      invitationUrl: "https://github.com/org/hw1-octocat/invitations",
    });
  });

  it("returns already_member on 204 (no body)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    const result = await addCollaborator({
      token: "ghs_x",
      owner: "org",
      repo: "hw1-octocat",
      username: "octocat",
      permission: "push",
      fetchImpl,
    });

    expect(result).toEqual({ status: "already_member" });
  });
});
