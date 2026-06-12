import type { D1Database } from "@cloudflare/workers-types";
import { ConflictError } from "../http/errors";

export interface Student {
  id: string;
  classroomId: string;
  rosterIdentifier: string | null;
  githubUsername: string | null;
  userId: string | null;
  createdAt: string;
}

interface StudentRow {
  id: string;
  classroom_id: string;
  roster_identifier: string | null;
  github_username: string | null;
  user_id: string | null;
  created_at: string;
}

function toStudent(row: StudentRow): Student {
  return {
    id: row.id,
    classroomId: row.classroom_id,
    rosterIdentifier: row.roster_identifier,
    githubUsername: row.github_username,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

export async function listStudentsByClassroom(db: D1Database, classroomId: string): Promise<Student[]> {
  const { results } = await db
    .prepare("SELECT * FROM students WHERE classroom_id = ?1 ORDER BY created_at ASC")
    .bind(classroomId)
    .all<StudentRow>();
  return results.map(toStudent);
}

export async function listUnclaimedStudents(
  db: D1Database,
  classroomId: string,
): Promise<{ id: string; rosterIdentifier: string | null }[]> {
  const { results } = await db
    .prepare(
      "SELECT id, roster_identifier FROM students WHERE classroom_id = ?1 AND user_id IS NULL ORDER BY roster_identifier ASC",
    )
    .bind(classroomId)
    .all<{ id: string; roster_identifier: string | null }>();
  return results.map((r) => ({ id: r.id, rosterIdentifier: r.roster_identifier }));
}

export async function seedStudents(
  db: D1Database,
  classroomId: string,
  identifiers: string[],
): Promise<Student[]> {
  // Dedupe within the request, then skip identifiers that already exist in this classroom.
  const unique = [...new Set(identifiers)];
  const { results: existingRows } = await db
    .prepare(
      "SELECT roster_identifier FROM students WHERE classroom_id = ?1 AND roster_identifier IS NOT NULL",
    )
    .bind(classroomId)
    .all<{ roster_identifier: string }>();
  const existing = new Set(existingRows.map((r) => r.roster_identifier));
  const toInsert = unique.filter((id) => !existing.has(id));

  if (toInsert.length > 0) {
    await db.batch(
      toInsert.map((identifier) =>
        db
          .prepare("INSERT INTO students (id, classroom_id, roster_identifier) VALUES (?1, ?2, ?3)")
          .bind(crypto.randomUUID(), classroomId, identifier),
      ),
    );
  }

  return listStudentsByClassroom(db, classroomId);
}

export async function findStudentByUser(
  db: D1Database,
  classroomId: string,
  userId: string,
): Promise<Student | null> {
  const row = await db
    .prepare("SELECT * FROM students WHERE classroom_id = ?1 AND user_id = ?2")
    .bind(classroomId, userId)
    .first<StudentRow>();
  return row ? toStudent(row) : null;
}

export async function claimStudent(
  db: D1Database,
  studentId: string,
  classroomId: string,
  userId: string,
  githubUsername: string,
): Promise<Student> {
  // Guarded UPDATE: only succeeds when the row is in this classroom AND still unclaimed.
  // Races and a "claim a second row" attempt both resolve here, not via check-then-write.
  let row: StudentRow | null;
  try {
    row = await db
      .prepare(
        `UPDATE students
            SET user_id = ?3, github_username = ?4
          WHERE id = ?1 AND classroom_id = ?2 AND user_id IS NULL
        RETURNING *`,
      )
      .bind(studentId, classroomId, userId, githubUsername)
      .first<StudentRow>();
  } catch (err) {
    // Unique (classroom_id, user_id): this account already claimed another row.
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new ConflictError("You have already claimed a roster entry in this classroom");
    }
    throw err;
  }
  if (!row) throw new ConflictError("This roster entry has already been claimed");
  return toStudent(row);
}

export async function createStudent(
  db: D1Database,
  input: { classroomId: string; userId: string; githubUsername: string },
): Promise<Student> {
  try {
    const row = await db
      .prepare(
        `INSERT INTO students (id, classroom_id, user_id, github_username)
         VALUES (?1, ?2, ?3, ?4)
       RETURNING *`,
      )
      .bind(crypto.randomUUID(), input.classroomId, input.userId, input.githubUsername)
      .first<StudentRow>();
    if (!row) throw new Error("createStudent: INSERT ... RETURNING produced no row");
    return toStudent(row);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new ConflictError("You are already enrolled in this classroom");
    }
    throw err;
  }
}
