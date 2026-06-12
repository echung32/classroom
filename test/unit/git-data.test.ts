import { describe, expect, it, vi } from "vitest";
import {
  createCommit,
  createMainRef,
  createTree,
  ensureOrgRepo,
  getMainRef,
  updateMainRef,
  type TreeEntry,
} from "../../src/lib/github/git-data";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ensureOrgRepo", () => {
  it("POSTs /orgs/{org}/repos with private:true and returns fullName/htmlUrl", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { full_name: "org/grader-hw1", html_url: "https://github.com/org/grader-hw1" }),
    );
    const res = await ensureOrgRepo({ token: "t", org: "org", name: "grader-hw1", fetchImpl });
    expect(res).toEqual({ fullName: "org/grader-hw1", htmlUrl: "https://github.com/org/grader-hw1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.github.com/orgs/org/repos");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ name: "grader-hw1", private: true });
  });

  it("on 422 (already exists) confirms via GET /repos/{org}/{name}", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(422, { message: "name already exists" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { full_name: "org/grader-hw1", html_url: "https://github.com/org/grader-hw1" }),
      );
    const res = await ensureOrgRepo({ token: "t", org: "org", name: "grader-hw1", fetchImpl });
    expect(res.fullName).toBe("org/grader-hw1");
    expect(String((fetchImpl.mock.calls[1] as unknown as [string])[0])).toBe("https://api.github.com/repos/org/grader-hw1");
  });
});

describe("createTree", () => {
  it("POSTs the tree entries (no base_tree) and returns the sha", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { sha: "tree-sha" }));
    const tree: TreeEntry[] = [{ path: "README.md", mode: "100644", type: "blob", content: "hi" }];
    const sha = await createTree({ token: "t", org: "org", repo: "grader-hw1", tree, fetchImpl });
    expect(sha).toBe("tree-sha");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.github.com/repos/org/grader-hw1/git/trees");
    expect(JSON.parse(String(init.body))).toEqual({ tree });
  });
});

describe("createCommit", () => {
  it("POSTs message/tree/parents and returns the commit sha", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { sha: "commit-sha" }));
    const sha = await createCommit({
      token: "t", org: "org", repo: "grader-hw1", message: "build", tree: "tree-sha", parents: [], fetchImpl,
    });
    expect(sha).toBe("commit-sha");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.github.com/repos/org/grader-hw1/git/commits");
    expect(JSON.parse(String(init.body))).toEqual({ message: "build", tree: "tree-sha", parents: [] });
  });
});

describe("getMainRef", () => {
  it("returns the sha from git/ref/heads/main", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { object: { sha: "main-sha" } }));
    const sha = await getMainRef({ token: "t", org: "org", repo: "grader-hw1", fetchImpl });
    expect(sha).toBe("main-sha");
    expect(String((fetchImpl.mock.calls[0] as unknown as [string])[0])).toBe(
      "https://api.github.com/repos/org/grader-hw1/git/ref/heads/main",
    );
  });

  it("returns null on 404 (first build, no commits yet)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { message: "Not Found" }));
    const sha = await getMainRef({ token: "t", org: "org", repo: "grader-hw1", fetchImpl });
    expect(sha).toBeNull();
  });
});

describe("createMainRef / updateMainRef", () => {
  it("createMainRef POSTs refs/heads/main", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { ref: "refs/heads/main" }));
    await createMainRef({ token: "t", org: "org", repo: "grader-hw1", sha: "c", fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.github.com/repos/org/grader-hw1/git/refs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ ref: "refs/heads/main", sha: "c" });
  });

  it("updateMainRef PATCHes git/refs/heads/main with force:false", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ref: "refs/heads/main" }));
    await updateMainRef({ token: "t", org: "org", repo: "grader-hw1", sha: "c", fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.github.com/repos/org/grader-hw1/git/refs/heads/main");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ sha: "c", force: false });
  });
});
