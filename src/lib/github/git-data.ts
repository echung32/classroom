import { GitHubApiError, githubRequest } from "./client";

/** A single entry in a git tree: an inline text blob or a submodule gitlink. */
export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "commit";
  content?: string;
  sha?: string;
}

/**
 * Create the grader repo, or recover the existing one. POST /orgs/{org}/repos
 * with private:true; on 422 (already exists) confirm via GET (keys on status,
 * not the fragile body message — mirrors createRepoFromTemplate).
 */
export async function ensureOrgRepo(input: {
  token: string;
  org: string;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<{ fullName: string; htmlUrl: string }> {
  const { token, org, name, fetchImpl } = input;
  try {
    const { data } = await githubRequest<{ full_name: string; html_url: string }>(
      `/orgs/${org}/repos`,
      { method: "POST", token, body: { name, private: true }, fetchImpl },
    );
    return { fullName: data.full_name, htmlUrl: data.html_url };
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 422) {
      const { data } = await githubRequest<{ full_name: string; html_url: string }>(
        `/repos/${org}/${name}`,
        { token, fetchImpl },
      );
      return { fullName: data.full_name, htmlUrl: data.html_url };
    }
    throw err;
  }
}

/** Create a git tree from inline entries (no base_tree). Returns the new tree SHA. */
export async function createTree(input: {
  token: string;
  org: string;
  repo: string;
  tree: TreeEntry[];
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { token, org, repo, tree, fetchImpl } = input;
  const { data } = await githubRequest<{ sha: string }>(
    `/repos/${org}/${repo}/git/trees`,
    { method: "POST", token, body: { tree }, fetchImpl },
  );
  return data.sha;
}

/** Create a commit pointing at a tree. Returns the new commit SHA. */
export async function createCommit(input: {
  token: string;
  org: string;
  repo: string;
  message: string;
  tree: string;
  parents: string[];
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { token, org, repo, message, tree, parents, fetchImpl } = input;
  const { data } = await githubRequest<{ sha: string }>(
    `/repos/${org}/${repo}/git/commits`,
    { method: "POST", token, body: { message, tree, parents }, fetchImpl },
  );
  return data.sha;
}

/** The current main-branch SHA, or null on 404 (first build, no commits yet). */
export async function getMainRef(input: {
  token: string;
  org: string;
  repo: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const { token, org, repo, fetchImpl } = input;
  try {
    const { data } = await githubRequest<{ object: { sha: string } }>(
      `/repos/${org}/${repo}/git/ref/heads/main`,
      { token, fetchImpl },
    );
    return data.object.sha;
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return null;
    throw err;
  }
}

/** Create refs/heads/main pointing at a commit (first build). */
export async function createMainRef(input: {
  token: string;
  org: string;
  repo: string;
  sha: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { token, org, repo, sha, fetchImpl } = input;
  await githubRequest(`/repos/${org}/${repo}/git/refs`, {
    method: "POST",
    token,
    body: { ref: "refs/heads/main", sha },
    fetchImpl,
  });
}

/** Fast-forward main to a new commit (rebuild). force:false keeps it non-destructive. */
export async function updateMainRef(input: {
  token: string;
  org: string;
  repo: string;
  sha: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { token, org, repo, sha, fetchImpl } = input;
  await githubRequest(`/repos/${org}/${repo}/git/refs/heads/main`, {
    method: "PATCH",
    token,
    body: { sha, force: false },
    fetchImpl,
  });
}
