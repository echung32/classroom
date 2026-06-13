import type { D1Database } from "@cloudflare/workers-types";

export interface Classroom {
  id: string;
  name: string;
  timezone: string;
  createdBy: string | null;
  createdAt: string;
}

interface ClassroomRow {
  id: string;
  name: string;
  timezone: string;
  created_by: string | null;
  created_at: string;
}

function toClassroom(row: ClassroomRow): Classroom {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function createClassroom(
  db: D1Database,
  input: { name: string; timezone: string; createdBy: string },
): Promise<Classroom> {
  const row = await db
    .prepare(
      `INSERT INTO classrooms (id, name, timezone, created_by)
       VALUES (?1, ?2, ?3, ?4)
       RETURNING *`,
    )
    .bind(crypto.randomUUID(), input.name, input.timezone, input.createdBy)
    .first<ClassroomRow>();
  if (!row) throw new Error("createClassroom: INSERT ... RETURNING produced no row");
  return toClassroom(row);
}

export async function getClassroomById(db: D1Database, id: string): Promise<Classroom | null> {
  const row = await db
    .prepare("SELECT * FROM classrooms WHERE id = ?1")
    .bind(id)
    .first<ClassroomRow>();
  return row ? toClassroom(row) : null;
}

export async function listClassroomsByOwner(
  db: D1Database,
  userId: string,
): Promise<Classroom[]> {
  const { results } = await db
    .prepare("SELECT * FROM classrooms WHERE created_by = ?1 ORDER BY created_at DESC")
    .bind(userId)
    .all<ClassroomRow>();
  return results.map(toClassroom);
}
