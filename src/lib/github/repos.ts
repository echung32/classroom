import { GitHubApiError, githubRequest } from "./client";

interface GitHubRepo {
  id: number;
  full_name: string;
  html_url: string;
}

export interface CreateRepoResult {
  repoId: number;
  fullName: string;
  htmlUrl: string;
}

export async function createRepoFromTemplate(input: {
  token: string;
  templateOwner: string;
  templateRepo: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  fetchImpl?: typeof fetch;
}): Promise<CreateRepoResult> {
  const { token, templateOwner, templateRepo, owner, name, isPrivate, fetchImpl } = input;
  try {
    const { data } = await githubRequest<GitHubRepo>(
      `/repos/${templateOwner}/${templateRepo}/generate`,
      { method: "POST", token, body: { owner, name, private: isPrivate }, fetchImpl },
    );
    return { repoId: data.id, fullName: data.full_name, htmlUrl: data.html_url };
  } catch (err) {
    // Partial-failure recovery: the repo already exists from a prior attempt.
    // Key on status 422 alone, then confirm via GET (body messages are fragile).
    if (err instanceof GitHubApiError && err.status === 422) {
      const { data } = await githubRequest<GitHubRepo>(`/repos/${owner}/${name}`, { token, fetchImpl });
      return { repoId: data.id, fullName: data.full_name, htmlUrl: data.html_url };
    }
    throw err;
  }
}

export interface AddCollaboratorResult {
  status: "invited" | "already_member";
  invitationUrl?: string;
}

/**
 * Look up a repo's template-readiness at assignment-creation time. Returns null
 * when GitHub answers 404 (repo missing or not visible to the installation) so
 * the caller can map it to a friendly 400; rethrows any other GitHub error.
 */
export async function getRepoMeta(input: {
  token: string;
  owner: string;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<{ isTemplate: boolean } | null> {
  const { token, owner, name, fetchImpl } = input;
  try {
    const { data } = await githubRequest<{ is_template?: boolean }>(
      `/repos/${owner}/${name}`,
      { token, fetchImpl },
    );
    return { isTemplate: data.is_template === true };
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return null;
    throw err;
  }
}

export async function addCollaborator(input: {
  token: string;
  owner: string;
  repo: string;
  username: string;
  permission: string;
  fetchImpl?: typeof fetch;
}): Promise<AddCollaboratorResult> {
  const { token, owner, repo, username, permission, fetchImpl } = input;
  const { data, status } = await githubRequest<{ html_url?: string } | undefined>(
    `/repos/${owner}/${repo}/collaborators/${username}`,
    { method: "PUT", token, body: { permission }, fetchImpl },
  );
  // 201 → a repository invitation was created; 204 → already a collaborator.
  if (status === 201) {
    return { status: "invited", invitationUrl: data?.html_url };
  }
  return { status: "already_member" };
}
