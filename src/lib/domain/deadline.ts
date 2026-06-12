export type SubmissionStatus = "on_time" | "late" | "missing";

/**
 * Pure deadline classifier. Timestamps are parsed to epoch ms and compared as
 * instants — never string-compared. The boundary is the deadline alone (grace
 * was dropped in Phase 3); a commit whose timestamp equals the deadline counts
 * as on_time (`<=`).
 */
export function classifySubmission(input: {
  deadlineAt: string;
  latestCommitAt: string | null;
  hasStudentCommits: boolean;
}): SubmissionStatus {
  if (!input.hasStudentCommits || input.latestCommitAt === null) return "missing";
  const deadline = Date.parse(input.deadlineAt);
  const latest = Date.parse(input.latestCommitAt);
  return latest <= deadline ? "on_time" : "late";
}
