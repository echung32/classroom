import type { APIRoute } from "astro";
import { requireSession } from "../../../lib/auth/require";
import { getEnv } from "../../../lib/config";
import { listAssignmentsByClassroom } from "../../../lib/db/assignments";
import { assertOwnsClassroom } from "../../../lib/domain/authz";
import { toResponse } from "../../../lib/http/errors";
import { error, json } from "../../../lib/http/json";

export const GET: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const classroom = await assertOwnsClassroom(env.DB, params.id!, session.userId);
    const assignments = await listAssignmentsByClassroom(env.DB, classroom.id);
    return json({ classroom, assignments }, 200);
  } catch (err) {
    return toResponse(err);
  }
};
