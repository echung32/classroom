export interface SubmissionForSelection {
  studentId: string;
  githubUsername: string | null;
  /** `{slug}-{username}` student repo name; null when the student has no GitHub username. */
  repoName: string | null;
  gradeDecision: string;
  deadlineSha: string | null;
  latestSha: string | null;
}

export interface GraderEntry {
  username: string;
  repoName: string;
  sha: string;
  source: "deadline" | "latest";
}

export interface SkippedEntry {
  username: string | null;
  studentId: string;
  reason: string;
}

/**
 * Decide which submissions get pinned into the grader and why each omission happened.
 * Pure: deterministic ordering (by username) so rebuilds are reproducible.
 */
export function selectGraderEntries(submissions: SubmissionForSelection[]): {
  included: GraderEntry[];
  skipped: SkippedEntry[];
} {
  const included: GraderEntry[] = [];
  const skipped: SkippedEntry[] = [];

  for (const s of submissions) {
    if (s.githubUsername === null || s.repoName === null) {
      skipped.push({ username: s.githubUsername, studentId: s.studentId, reason: "no-github-username" });
      continue;
    }
    if (s.gradeDecision === "exclude") {
      skipped.push({ username: s.githubUsername, studentId: s.studentId, reason: "excluded" });
      continue;
    }
    if (s.gradeDecision === "accept_late") {
      if (s.latestSha === null) {
        skipped.push({ username: s.githubUsername, studentId: s.studentId, reason: "no-latest-sha" });
        continue;
      }
      included.push({ username: s.githubUsername, repoName: s.repoName, sha: s.latestSha, source: "latest" });
      continue;
    }
    // default: at_deadline
    if (s.deadlineSha === null) {
      skipped.push({ username: s.githubUsername, studentId: s.studentId, reason: "no-deadline-sha" });
      continue;
    }
    included.push({ username: s.githubUsername, repoName: s.repoName, sha: s.deadlineSha, source: "deadline" });
  }

  included.sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
  return { included, skipped };
}

/** The `.gitmodules` text — one block per included entry, tab-indented, trailing newline. */
export function buildGitmodules(entries: GraderEntry[], org: string): string {
  return entries
    .map(
      (e) =>
        `[submodule "submissions/${e.username}"]\n` +
        `\tpath = submissions/${e.username}\n` +
        `\turl = https://github.com/${org}/${e.repoName}.git\n`,
    )
    .join("");
}

/**
 * The `.devcontainer/devcontainer.json` text. Each included student repo gets a
 * codespaces read grant, without which the private submodules can't be cloned in
 * a Codespace. Built as a structured object → JSON.stringify (safe escaping,
 * deterministic key order since `entries` is pre-sorted by username).
 */
export function buildDevcontainer(entries: GraderEntry[], org: string, name: string): string {
  const repositories: Record<string, { permissions: { contents: string } }> = {};
  for (const e of entries) {
    repositories[`${org}/${e.repoName}`] = { permissions: { contents: "read" } };
  }
  const obj = {
    name,
    image: "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
    features: { "ghcr.io/devcontainers/features/git:1": {} },
    customizations: { codespaces: { repositories } },
    postCreateCommand: "git submodule update --init --recursive",
  };
  return JSON.stringify(obj, null, 2);
}

/** A short informational top-level README naming the assignment and its pinned submissions. */
export function buildReadme(assignmentTitle: string, entries: GraderEntry[]): string {
  const lines = entries.map((e) => `- \`submissions/${e.username}\` → ${e.repoName} @ \`${e.sha}\` (${e.source})`);
  return (
    `# Grader: ${assignmentTitle}\n\n` +
    `Pinned submissions (${entries.length}):\n\n` +
    `${lines.join("\n")}\n`
  );
}
