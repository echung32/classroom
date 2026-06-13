import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { getAssignmentById } from "../../../../lib/db/assignments";
import { getClassroomById } from "../../../../lib/db/classrooms";
import { listReposWithStudentsByAssignment } from "../../../../lib/db/repos";
import {
  freezeSubmission,
  getSubmission,
  refreshSubmissionStatus,
} from "../../../../lib/db/submissions";
import { assertOwnsClassroom } from "../../../../lib/domain/authz";
import {
  AssignmentNotFoundError,
  type EvaluationDeps,
  evaluateAssignmentSubmissions,
} from "../../../../lib/domain/evaluation";
import { getInstallationCreds } from "../../../../lib/github/app";
import { NotFoundError, toResponse } from "../../../../lib/http/errors";
import { error, json } from "../../../../lib/http/json";

type EnvDb = ReturnType<typeof getEnv>["DB"];

/** Build the EvaluationDeps that bind the orchestrator to D1 + the GitHub token. */
export function buildEvaluationDeps(db: EnvDb, token: string, org: string): EvaluationDeps {
  return {
    token,
    org,
    loadAssignment: (id) => getAssignmentById(db, id),
    loadClassroom: (id) => getClassroomById(db, id),
    listRepos: (assignmentId) => listReposWithStudentsByAssignment(db, assignmentId),
    getSubmission: (assignmentId, studentId) => getSubmission(db, assignmentId, studentId),
    freezeSubmission: (input) => freezeSubmission(db, input),
    refreshSubmissionStatus: (input) => refreshSubmissionStatus(db, input),
  };
}

export const GET: APIRoute = async ({ params, cookies }) => {
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
      refresh: false,
    });

    return json({ assignmentId: assignment.id, ...result }, 200);
  } catch (err) {
    if (err instanceof AssignmentNotFoundError) return error(err.message, 404);
    return toResponse(err);
  }
};
