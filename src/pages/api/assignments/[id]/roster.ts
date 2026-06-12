import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { getAssignmentById } from "../../../../lib/db/assignments";
import { listUnclaimedStudents } from "../../../../lib/db/students";
import { NotFoundError, toResponse } from "../../../../lib/http/errors";
import { error, json } from "../../../../lib/http/json";

export const GET: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    const options = await listUnclaimedStudents(env.DB, assignment.classroomId);
    return json({ options }, 200);
  } catch (err) {
    return toResponse(err);
  }
};
