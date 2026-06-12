import { GitHubApiError } from "../github/client";
import { readRepoCommitState } from "../github/commits";
import { classifySubmission } from "./deadline";

interface AssignmentLite {
  id: string;
  classroomId: string;
  deadlineAt: string | null;
}
interface ClassroomLite {
  id: string;
  githubOrg: string;
}
interface RepoLite {
  studentId: string;
  repoName: string;
  githubUsername: string | null;
}
interface SubmissionLite {
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
  latestCommitAt: string | null;
  status: string;
  evaluatedAt: string | null;
}

export interface EvaluationDeps {
  token: string;
  fetchImpl?: typeof fetch;
  loadAssignment: (id: string) => Promise<AssignmentLite | null>;
  loadClassroom: (id: string) => Promise<ClassroomLite | null>;
  listRepos: (assignmentId: string) => Promise<RepoLite[]>;
  getSubmission: (assignmentId: string, studentId: string) => Promise<SubmissionLite | null>;
  freezeSubmission: (input: {
    assignmentId: string;
    studentId: string;
    deadlineSha: string | null;
    deadlineCommitAt: string | null;
    latestCommitAt: string | null;
    status: "on_time" | "late" | "missing";
  }) => Promise<void>;
  refreshSubmissionStatus: (input: {
    assignmentId: string;
    studentId: string;
    latestCommitAt: string | null;
    status: "on_time" | "late" | "missing";
  }) => Promise<void>;
}

export type DueState = "no-deadline" | "pending" | "evaluated";

export interface SubmissionView {
  studentId: string;
  githubUsername: string | null;
  repoName: string;
  status: string | null;
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
  latestCommitAt: string | null;
  evaluatedAt: string | null;
}

export interface EvaluationResult {
  dueState: DueState;
  submissions: SubmissionView[];
  errors: { studentId: string; repoName: string; message: string }[];
}

function blankView(repo: RepoLite, status: string | null): SubmissionView {
  return {
    studentId: repo.studentId,
    githubUsername: repo.githubUsername,
    repoName: repo.repoName,
    status,
    deadlineSha: null,
    deadlineCommitAt: null,
    latestCommitAt: null,
    evaluatedAt: null,
  };
}

function rowView(repo: RepoLite, row: SubmissionLite): SubmissionView {
  return {
    studentId: repo.studentId,
    githubUsername: repo.githubUsername,
    repoName: repo.repoName,
    status: row.status,
    deadlineSha: row.deadlineSha,
    deadlineCommitAt: row.deadlineCommitAt,
    latestCommitAt: row.latestCommitAt,
    evaluatedAt: row.evaluatedAt,
  };
}

/** The assignment id was not found. Endpoints map this to a 404. */
export class AssignmentNotFoundError extends Error {
  constructor() {
    super("Assignment not found");
    this.name = "AssignmentNotFoundError";
  }
}

export async function evaluateAssignmentSubmissions(
  deps: EvaluationDeps,
  input: { assignmentId: string; now: string; refresh: boolean },
): Promise<EvaluationResult> {
  const assignment = await deps.loadAssignment(input.assignmentId);
  if (!assignment) throw new AssignmentNotFoundError();

  const repos = await deps.listRepos(assignment.id);

  if (assignment.deadlineAt === null) {
    return { dueState: "no-deadline", submissions: repos.map((r) => blankView(r, null)), errors: [] };
  }
  if (Date.parse(input.now) < Date.parse(assignment.deadlineAt)) {
    return { dueState: "pending", submissions: repos.map((r) => blankView(r, "pending")), errors: [] };
  }

  const classroom = await deps.loadClassroom(assignment.classroomId);
  if (!classroom) throw new AssignmentNotFoundError();

  const submissions: SubmissionView[] = [];
  const errors: EvaluationResult["errors"] = [];

  for (const repo of repos) {
    const existing = await deps.getSubmission(assignment.id, repo.studentId);
    const alreadyEvaluated = Boolean(existing?.evaluatedAt);

    if (alreadyEvaluated && !input.refresh) {
      submissions.push(rowView(repo, existing!));
      continue;
    }

    try {
      const state = await readRepoCommitState({
        token: deps.token,
        owner: classroom.githubOrg,
        repo: repo.repoName,
        deadlineAt: assignment.deadlineAt,
        fetchImpl: deps.fetchImpl,
      });
      const status = classifySubmission({
        deadlineAt: assignment.deadlineAt,
        latestCommitAt: state.latestCommitAt,
        hasStudentCommits: state.hasStudentCommits,
      });

      if (alreadyEvaluated) {
        await deps.refreshSubmissionStatus({
          assignmentId: assignment.id,
          studentId: repo.studentId,
          latestCommitAt: state.latestCommitAt,
          status,
        });
      } else {
        await deps.freezeSubmission({
          assignmentId: assignment.id,
          studentId: repo.studentId,
          deadlineSha: state.deadlineSha,
          deadlineCommitAt: state.deadlineCommitAt,
          latestCommitAt: state.latestCommitAt,
          status,
        });
      }

      const row = await deps.getSubmission(assignment.id, repo.studentId);
      submissions.push(row ? rowView(repo, row) : blankView(repo, status));
    } catch (err) {
      // A single repo's GitHub failure (404 deleted, transient) is captured and
      // does not abort the others. Non-GitHub errors propagate.
      if (err instanceof GitHubApiError) {
        errors.push({
          studentId: repo.studentId,
          repoName: repo.repoName,
          message: `GitHub request failed (${err.status})`,
        });
        continue;
      }
      throw err;
    }
  }

  return { dueState: "evaluated", submissions, errors };
}
