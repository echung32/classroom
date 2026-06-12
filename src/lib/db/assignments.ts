import type { D1Database } from "@cloudflare/workers-types";
import { ConflictError } from "../http/errors";

export interface Assignment {
  id: string;
  classroomId: string;
  slug: string;
  title: string;
  templateRepo: string;
  deadlineAt: string | null;
  status: string;
  graderRepo: string | null;
  closedAt: string | null;
  createdAt: string;
}

interface AssignmentRow {
  id: string;
  classroom_id: string;
  slug: string;
  title: string;
  template_repo: string;
  deadline_at: string | null;
  status: string;
  grader_repo: string | null;
  closed_at: string | null;
  created_at: string;
}

function toAssignment(row: AssignmentRow): Assignment {
  return {
    id: row.id,
    classroomId: row.classroom_id,
    slug: row.slug,
    title: row.title,
    templateRepo: row.template_repo,
    deadlineAt: row.deadline_at,
    status: row.status,
    graderRepo: row.grader_repo,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

export async function createAssignment(
  db: D1Database,
  input: {
    classroomId: string;
    slug: string;
    title: string;
    templateRepo: string;
    deadlineAt?: string;
  },
): Promise<Assignment> {
  try {
    const row = await db
      .prepare(
        `INSERT INTO assignments (id, classroom_id, slug, title, template_repo, deadline_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         RETURNING *`,
      )
      .bind(
        crypto.randomUUID(),
        input.classroomId,
        input.slug,
        input.title,
        input.templateRepo,
        input.deadlineAt ?? null,
      )
      .first<AssignmentRow>();
    if (!row) throw new Error("createAssignment: INSERT ... RETURNING produced no row");
    return toAssignment(row);
  } catch (err) {
    // The UNIQUE(classroom_id, slug) constraint is the authoritative slug-uniqueness
    // check (no pre-flight SELECT → no check-then-insert race). D1 surfaces it as an
    // Error whose message contains "UNIQUE constraint failed".
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new ConflictError(`An assignment with slug "${input.slug}" already exists in this classroom`);
    }
    throw err;
  }
}

export async function getAssignmentById(db: D1Database, id: string): Promise<Assignment | null> {
  const row = await db
    .prepare("SELECT * FROM assignments WHERE id = ?1")
    .bind(id)
    .first<AssignmentRow>();
  return row ? toAssignment(row) : null;
}

export async function listAssignmentsByClassroom(
  db: D1Database,
  classroomId: string,
): Promise<Assignment[]> {
  const { results } = await db
    .prepare("SELECT * FROM assignments WHERE classroom_id = ?1 ORDER BY created_at ASC")
    .bind(classroomId)
    .all<AssignmentRow>();
  return results.map(toAssignment);
}

export interface StudentAssignment {
  assignmentId: string;
  title: string;
  slug: string;
  deadlineAt: string | null;
  classroomName: string;
  accepted: boolean;
}

/** Every assignment in classrooms where this user has a student row, joined to
 *  the classroom name; accepted = a repo row exists for (assignment, student).
 *  Deadline ascending with NULL (no deadline) last, created_at as tiebreaker. */
export async function listAssignmentsForStudentUser(
  db: D1Database,
  userId: string,
): Promise<StudentAssignment[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id AS assignment_id, a.title, a.slug, a.deadline_at,
              c.name AS classroom_name,
              CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS accepted
         FROM students s
         JOIN assignments a ON a.classroom_id = s.classroom_id
         JOIN classrooms c ON c.id = s.classroom_id
         LEFT JOIN repos r ON r.assignment_id = a.id AND r.student_id = s.id
        WHERE s.user_id = ?1
        ORDER BY a.deadline_at IS NULL, a.deadline_at ASC, a.created_at ASC`,
    )
    .bind(userId)
    .all<{
      assignment_id: string;
      title: string;
      slug: string;
      deadline_at: string | null;
      classroom_name: string;
      accepted: number;
    }>();
  return results.map((r) => ({
    assignmentId: r.assignment_id,
    title: r.title,
    slug: r.slug,
    deadlineAt: r.deadline_at,
    classroomName: r.classroom_name,
    accepted: r.accepted !== 0,
  }));
}

/** Mark an assignment's grader as built: record grader_repo and flip status to 'built'. */
export async function setGraderBuilt(
  db: D1Database,
  assignmentId: string,
  graderRepo: string,
): Promise<void> {
  await db
    .prepare("UPDATE assignments SET grader_repo = ?2, status = 'built' WHERE id = ?1")
    .bind(assignmentId, graderRepo)
    .run();
}
