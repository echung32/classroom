import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { listStudentsByClassroom, seedStudents } from "../../../../lib/db/students";
import { assertOwnsClassroom } from "../../../../lib/domain/authz";
import { toResponse } from "../../../../lib/http/errors";
import { error, json } from "../../../../lib/http/json";
import { seedRosterSchema } from "../../../../lib/http/schemas";
import { parseBody } from "../../../../lib/http/validation";

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const classroom = await assertOwnsClassroom(env.DB, params.id!, session.userId);
    const body = await parseBody(request, seedRosterSchema);
    const students = await seedStudents(env.DB, classroom.id, body.identifiers);
    return json(students, 201);
  } catch (err) {
    return toResponse(err);
  }
};

export const GET: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const classroom = await assertOwnsClassroom(env.DB, params.id!, session.userId);
    const students = await listStudentsByClassroom(env.DB, classroom.id);
    return json(students, 200);
  } catch (err) {
    return toResponse(err);
  }
};
