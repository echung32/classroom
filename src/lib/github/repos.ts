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
