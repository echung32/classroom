import type { APIRoute } from "astro";
import { requireSession } from "../../../../../lib/auth/require";
import { getEnv } from "../../../../../lib/config";
import { getAssignmentById } from "../../../../../lib/db/assignments";
import { assertOwnsClassroom } from "../../../../../lib/domain/authz";
import {
  AssignmentNotFoundError,
  evaluateAssignmentSubmissions,
} from "../../../../../lib/domain/evaluation";
import { getInstallationCreds } from "../../../../../lib/github/app";
import { NotFoundError, toResponse } from "../../../../../lib/http/errors";
import { error, json } from "../../../../../lib/http/json";
import { buildEvaluationDeps } from "../submissions";

export const POST: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    await assertOwnsClassroom(env.DB, assignment.classroomId, session.userId);

    const { token, org } = await getInstallationCreds({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });

    const result = await evaluateAssignmentSubmissions(buildEvaluationDeps(env.DB, token, org), {
      assignmentId: assignment.id,
      now: new Date().toISOString(),
      refresh: true,
    });

    return json({ assignmentId: assignment.id, ...result }, 200);
  } catch (err) {
    if (err instanceof AssignmentNotFoundError) return error(err.message, 404);
    return toResponse(err);
  }
};
