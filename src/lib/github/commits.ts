import { githubRequest } from "./client";

interface GitHubCommit {
  sha: string;
  commit: { committer: { date: string } };
}

export interface RepoCommitState {
  latestCommitAt: string | null;
  hasStudentCommits: boolean;
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
}

/**
 * Read a repo's commit state against its default branch (the commits API
 * defaults to the default branch when `sha` is omitted). Two calls:
 *   1. latest 2 commits → latestCommitAt + hasStudentCommits (> the single
 *      template-import commit, i.e. length >= 2).
 *   2. last commit at-or-before the deadline → the pinned deadline SHA.
 */
export async function readRepoCommitState(input: {
  token: string;
  owner: string;
  repo: string;
  deadlineAt: string;
  fetchImpl?: typeof fetch;
}): Promise<RepoCommitState> {
  const { token, owner, repo, deadlineAt, fetchImpl } = input;

  const latest = await githubRequest<GitHubCommit[]>(
    `/repos/${owner}/${repo}/commits?per_page=2`,
    { token, fetchImpl },
  );
  const latestCommitAt = latest.data[0]?.commit.committer.date ?? null;
  const hasStudentCommits = latest.data.length >= 2;

  const atDeadline = await githubRequest<GitHubCommit[]>(
    `/repos/${owner}/${repo}/commits?until=${encodeURIComponent(deadlineAt)}&per_page=1`,
    { token, fetchImpl },
  );
  const deadlineSha = atDeadline.data[0]?.sha ?? null;
  const deadlineCommitAt = atDeadline.data[0]?.commit.committer.date ?? null;

  return { latestCommitAt, hasStudentCommits, deadlineSha, deadlineCommitAt };
}
