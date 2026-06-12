import type { APIRoute } from "astro";
import { requireSession } from "../../../lib/auth/require";
import { getEnv } from "../../../lib/config";
import { getAssignmentById } from "../../../lib/db/assignments";
import { assertOwnsClassroom } from "../../../lib/domain/authz";
import { NotFoundError, toResponse } from "../../../lib/http/errors";
import { error, json } from "../../../lib/http/json";

export const GET: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    // Authorize through the parent classroom (owner-scoped). Throws 404/403.
    await assertOwnsClassroom(env.DB, assignment.classroomId, session.userId);
    return json(assignment, 200);
  } catch (err) {
    return toResponse(err);
  }
};
