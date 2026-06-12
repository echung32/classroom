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
