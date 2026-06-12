import type { APIRoute } from "astro";
import { getEnv } from "../../../../../../lib/config";
import { requireSession } from "../../../../../../lib/auth/require";
import { getAssignmentById } from "../../../../../../lib/db/assignments";
import { getSubmission, setGradeDecision } from "../../../../../../lib/db/submissions";
import { assertOwnsClassroom } from "../../../../../../lib/domain/authz";
import { decisionSchema } from "../../../../../../lib/http/schemas";
import { parseBody } from "../../../../../../lib/http/validation";
import { NotFoundError, toResponse } from "../../../../../../lib/http/errors";
import { json, error } from "../../../../../../lib/http/json";

export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    await assertOwnsClassroom(env.DB, assignment.classroomId, session.userId);

    const body = await parseBody(request, decisionSchema);
    const ok = await setGradeDecision(env.DB, assignment.id, params.studentId!, body.decision);
    if (!ok) throw new NotFoundError("No evaluated submission for that student");

    const updated = await getSubmission(env.DB, assignment.id, params.studentId!);
    return json(updated, 200);
  } catch (err) {
    return toResponse(err);
  }
};
