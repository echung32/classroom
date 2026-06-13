import type { APIRoute } from "astro";
import { requireSession } from "../../../lib/auth/require";
import { getEnv } from "../../../lib/config";
import { createClassroom } from "../../../lib/db/classrooms";
import { toResponse } from "../../../lib/http/errors";
import { error, json } from "../../../lib/http/json";
import { classroomSchema } from "../../../lib/http/schemas";
import { parseBody } from "../../../lib/http/validation";

export const POST: APIRoute = async ({ request, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const body = await parseBody(request, classroomSchema);
    const classroom = await createClassroom(env.DB, {
      name: body.name,
      timezone: body.timezone,
      createdBy: session.userId,
    });
    return json(classroom, 201);
  } catch (err) {
    return toResponse(err);
  }
};
