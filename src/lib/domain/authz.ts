import type { D1Database } from "@cloudflare/workers-types";
import { type Classroom, getClassroomById } from "../db/classrooms";
import { ForbiddenError, NotFoundError } from "../http/errors";

/** Owner-scoped guard. Throws NotFoundError if absent, ForbiddenError if not the owner. */
export async function assertOwnsClassroom(
  db: D1Database,
  classroomId: string,
  userId: string,
): Promise<Classroom> {
  const classroom = await getClassroomById(db, classroomId);
  if (!classroom) throw new NotFoundError("Classroom not found");
  if (classroom.createdBy !== userId) throw new ForbiddenError("You do not own this classroom");
  return classroom;
}
