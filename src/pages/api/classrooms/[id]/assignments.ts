import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { createAssignment } from "../../../../lib/db/assignments";
import { assertOwnsClassroom } from "../../../../lib/domain/authz";
import { toResponse } from "../../../../lib/http/errors";
import { error, json } from "../../../../lib/http/json";
import { assignmentSchema } from "../../../../lib/http/schemas";
import { parseBody } from "../../../../lib/http/validation";

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const classroom = await assertOwnsClassroom(env.DB, params.id!, session.userId);
    const body = await parseBody(request, assignmentSchema);
    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: body.slug,
      title: body.title,
      templateRepo: body.template_repo,
      deadlineAt: body.deadline_at,
      graceMinutes: body.grace_minutes,
    });
    return json(assignment, 201);
  } catch (err) {
    return toResponse(err);
  }
};
