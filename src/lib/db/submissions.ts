import type { D1Database } from "@cloudflare/workers-types";
import type { SubmissionStatus } from "../domain/deadline";

export interface Submission {
  assignmentId: string;
  studentId: string;
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
  latestSha: string | null;
  latestCommitAt: string | null;
  status: string;
  gradeDecision: string;
  evaluatedAt: string | null;
}

interface SubmissionRow {
  assignment_id: string;
  student_id: string;
  deadline_sha: string | null;
  deadline_commit_at: string | null;
  latest_sha: string | null;
  latest_commit_at: string | null;
  status: string;
  grade_decision: string;
  evaluated_at: string | null;
}

function toSubmission(row: SubmissionRow): Submission {
  return {
    assignmentId: row.assignment_id,
    studentId: row.student_id,
    deadlineSha: row.deadline_sha,
    deadlineCommitAt: row.deadline_commit_at,
    latestSha: row.latest_sha,
    latestCommitAt: row.latest_commit_at,
    status: row.status,
    gradeDecision: row.grade_decision,
    evaluatedAt: row.evaluated_at,
  };
}

export async function getSubmission(
  db: D1Database,
  assignmentId: string,
  studentId: string,
): Promise<Submission | null> {
  const row = await db
    .prepare("SELECT * FROM submissions WHERE assignment_id = ?1 AND student_id = ?2")
    .bind(assignmentId, studentId)
    .first<SubmissionRow>();
  return row ? toSubmission(row) : null;
}

export async function listSubmissionsByAssignment(
  db: D1Database,
  assignmentId: string,
): Promise<Submission[]> {
  const { results } = await db
    .prepare("SELECT * FROM submissions WHERE assignment_id = ?1")
    .bind(assignmentId)
    .all<SubmissionRow>();
  return results.map(toSubmission);
}

/**
 * Insert or update a frozen submission. `deadline_sha`/`deadline_commit_at` are
 * immutable once written: the UPSERT uses COALESCE so an existing (non-null)
 * pinned SHA is preserved while `latest_commit_at`/`status`/`evaluated_at` are
 * refreshed. The bare column names in DO UPDATE refer to the existing row.
 */
export async function freezeSubmission(
  db: D1Database,
  input: {
    assignmentId: string;
    studentId: string;
    deadlineSha: string | null;
    deadlineCommitAt: string | null;
    latestSha: string | null;
    latestCommitAt: string | null;
    status: SubmissionStatus;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO submissions
         (assignment_id, student_id, deadline_sha, deadline_commit_at, latest_sha, latest_commit_at, status, evaluated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
       ON CONFLICT (assignment_id, student_id) DO UPDATE SET
         deadline_sha = COALESCE(deadline_sha, excluded.deadline_sha),
         deadline_commit_at = COALESCE(deadline_commit_at, excluded.deadline_commit_at),
         latest_sha = excluded.latest_sha,
         latest_commit_at = excluded.latest_commit_at,
         status = excluded.status,
         evaluated_at = excluded.evaluated_at`,
    )
    .bind(
      input.assignmentId,
      input.studentId,
      input.deadlineSha,
      input.deadlineCommitAt,
      input.latestSha,
      input.latestCommitAt,
      input.status,
    )
    .run();
}

/** Re-check an already-frozen row: update status + latest_sha + latest_commit_at only. */
export async function refreshSubmissionStatus(
  db: D1Database,
  input: {
    assignmentId: string;
    studentId: string;
    latestSha: string | null;
    latestCommitAt: string | null;
    status: SubmissionStatus;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE submissions
          SET status = ?3, latest_sha = ?4, latest_commit_at = ?5, evaluated_at = datetime('now')
        WHERE assignment_id = ?1 AND student_id = ?2`,
    )
    .bind(input.assignmentId, input.studentId, input.status, input.latestSha, input.latestCommitAt)
    .run();
}

export interface SubmissionWithStudent {
  studentId: string;
  githubUsername: string | null;
  /** The student repo name `{slug}-{username}`; null when the student has no linked GitHub username. */
  repoName: string | null;
  gradeDecision: string;
  deadlineSha: string | null;
  latestSha: string | null;
  status: string;
}

/**
 * Submissions for an assignment, joined to students and the assignment, yielding
 * the student repo name (`{slug}-{username}`) the grader build needs. Reuses the
 * join shape of listReposWithStudentsByAssignment.
 */
export async function listSubmissionsWithStudents(
  db: D1Database,
  assignmentId: string,
): Promise<SubmissionWithStudent[]> {
  const { results } = await db
    .prepare(
      `SELECT sub.student_id,
              s.github_username,
              a.slug,
              sub.grade_decision,
              sub.deadline_sha,
              sub.latest_sha,
              sub.status
         FROM submissions sub
         JOIN students s ON s.id = sub.student_id
         JOIN assignments a ON a.id = sub.assignment_id
        WHERE sub.assignment_id = ?1
        ORDER BY s.github_username ASC`,
    )
    .bind(assignmentId)
    .all<{
      student_id: string;
      github_username: string | null;
      slug: string;
      grade_decision: string;
      deadline_sha: string | null;
      latest_sha: string | null;
      status: string;
    }>();
  return results.map((r) => ({
    studentId: r.student_id,
    githubUsername: r.github_username,
    repoName: r.github_username ? `${r.slug}-${r.github_username}` : null,
    gradeDecision: r.grade_decision,
    deadlineSha: r.deadline_sha,
    latestSha: r.latest_sha,
    status: r.status,
  }));
}

/** UPDATE grade_decision on an existing (evaluated) row. False when no row matched. */
export async function setGradeDecision(
  db: D1Database,
  assignmentId: string,
  studentId: string,
  decision: "at_deadline" | "accept_late" | "exclude",
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE submissions SET grade_decision = ?3 WHERE assignment_id = ?1 AND student_id = ?2",
    )
    .bind(assignmentId, studentId, decision)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
