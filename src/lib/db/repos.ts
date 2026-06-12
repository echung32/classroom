import type { D1Database } from "@cloudflare/workers-types";

export interface Repo {
  id: string;
  assignmentId: string;
  studentId: string;
  repoName: string;
  repoId: number | null;
  acceptedAt: string | null;
  permissionSyncedAt: string | null;
}

interface RepoRow {
  id: string;
  assignment_id: string;
  student_id: string;
  repo_name: string;
  repo_id: number | null;
  accepted_at: string | null;
  permission_synced_at: string | null;
}

function toRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    studentId: row.student_id,
    repoName: row.repo_name,
    repoId: row.repo_id,
    acceptedAt: row.accepted_at,
    permissionSyncedAt: row.permission_synced_at,
  };
}

export async function getRepoByAssignmentStudent(
  db: D1Database,
  assignmentId: string,
  studentId: string,
): Promise<Repo | null> {
  const row = await db
    .prepare("SELECT * FROM repos WHERE assignment_id = ?1 AND student_id = ?2")
    .bind(assignmentId, studentId)
    .first<RepoRow>();
  return row ? toRepo(row) : null;
}

export async function recordRepo(
  db: D1Database,
  input: { assignmentId: string; studentId: string; repoName: string; repoId: number },
): Promise<Repo> {
  const row = await db
    .prepare(
      `INSERT INTO repos (id, assignment_id, student_id, repo_name, repo_id, accepted_at, permission_synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))
     RETURNING *`,
    )
    .bind(crypto.randomUUID(), input.assignmentId, input.studentId, input.repoName, input.repoId)
    .first<RepoRow>();
  if (!row) throw new Error("recordRepo: INSERT ... RETURNING produced no row");
  return toRepo(row);
}

export async function touchPermissionSynced(db: D1Database, repoRowId: string): Promise<void> {
  await db
    .prepare("UPDATE repos SET permission_synced_at = datetime('now') WHERE id = ?1")
    .bind(repoRowId)
    .run();
}
