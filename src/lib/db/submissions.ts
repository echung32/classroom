import type { D1Database } from "@cloudflare/workers-types";
import type { SubmissionStatus } from "../domain/deadline";

export interface Submission {
  assignmentId: string;
  studentId: string;
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
  latestCommitAt: string | null;
  status: string;
  evaluatedAt: string | null;
}

interface SubmissionRow {
  assignment_id: string;
  student_id: string;
  deadline_sha: string | null;
  deadline_commit_at: string | null;
  latest_commit_at: string | null;
  status: string;
  evaluated_at: string | null;
}

function toSubmission(row: SubmissionRow): Submission {
  return {
    assignmentId: row.assignment_id,
    studentId: row.student_id,
    deadlineSha: row.deadline_sha,
    deadlineCommitAt: row.deadline_commit_at,
    latestCommitAt: row.latest_commit_at,
    status: row.status,
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
    latestCommitAt: string | null;
    status: SubmissionStatus;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO submissions
         (assignment_id, student_id, deadline_sha, deadline_commit_at, latest_commit_at, status, evaluated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
       ON CONFLICT (assignment_id, student_id) DO UPDATE SET
         deadline_sha = COALESCE(deadline_sha, excluded.deadline_sha),
         deadline_commit_at = COALESCE(deadline_commit_at, excluded.deadline_commit_at),
         latest_commit_at = excluded.latest_commit_at,
         status = excluded.status,
         evaluated_at = excluded.evaluated_at`,
    )
    .bind(
      input.assignmentId,
      input.studentId,
      input.deadlineSha,
      input.deadlineCommitAt,
      input.latestCommitAt,
      input.status,
    )
    .run();
}

/** Re-check an already-frozen row: update status + latest_commit_at only. */
export async function refreshSubmissionStatus(
  db: D1Database,
  input: {
    assignmentId: string;
    studentId: string;
    latestCommitAt: string | null;
    status: SubmissionStatus;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE submissions
          SET status = ?3, latest_commit_at = ?4, evaluated_at = datetime('now')
        WHERE assignment_id = ?1 AND student_id = ?2`,
    )
    .bind(input.assignmentId, input.studentId, input.status, input.latestCommitAt)
    .run();
}
