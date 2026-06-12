import type { D1Database } from "@cloudflare/workers-types";
import { claimStudent, createStudent, findStudentByUser, type Student } from "../db/students";

export async function resolveStudentForAccept(
  db: D1Database,
  input: { classroomId: string; userId: string; githubUsername: string; rosterStudentId?: string },
): Promise<Student> {
  const { classroomId, userId, githubUsername, rosterStudentId } = input;

  // Already enrolled (stable user_id link) → reuse, regardless of any roster selection.
  const existing = await findStudentByUser(db, classroomId, userId);
  if (existing) return existing;

  // Claiming a teacher-seeded row, or the skip path (fresh bare row).
  if (rosterStudentId) {
    return claimStudent(db, rosterStudentId, classroomId, userId, githubUsername);
  }
  return createStudent(db, { classroomId, userId, githubUsername });
}
