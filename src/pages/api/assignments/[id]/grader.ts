import type { APIRoute } from "astro";
import { getEnv } from "../../../../lib/config";
import { requireSession } from "../../../../lib/auth/require";
import { getAssignmentById, setGraderBuilt } from "../../../../lib/db/assignments";
import { getClassroomById } from "../../../../lib/db/classrooms";
import { listSubmissionsWithStudents } from "../../../../lib/db/submissions";
import { assertOwnsClassroom } from "../../../../lib/domain/authz";
import { getInstallationToken } from "../../../../lib/github/app";
import {
  createCommit,
  createMainRef,
  createTree,
  ensureOrgRepo,
  getMainRef,
  updateMainRef,
} from "../../../../lib/github/git-data";
import { buildGrader } from "../../../../lib/domain/grader-build";
import { AssignmentNotFoundError } from "../../../../lib/domain/evaluation";
import { NotFoundError, toResponse } from "../../../../lib/http/errors";
import { json, error } from "../../../../lib/http/json";

export const POST: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    await assertOwnsClassroom(env.DB, assignment.classroomId, session.userId);

    const token = await getInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });

    const result = await buildGrader(
      {
        token,
        loadAssignment: (id) => getAssignmentById(env.DB, id),
        loadClassroom: (id) => getClassroomById(env.DB, id),
        listSubmissionsWithStudents: (id) => listSubmissionsWithStudents(env.DB, id),
        setGraderBuilt: (id, repo) => setGraderBuilt(env.DB, id, repo),
        ensureOrgRepo,
        createTree,
        getMainRef,
        createCommit,
        createMainRef,
        updateMainRef,
      },
      { assignmentId: assignment.id, now: new Date().toISOString() },
    );

    return json({ assignmentId: assignment.id, ...result }, 200);
  } catch (err) {
    if (err instanceof AssignmentNotFoundError) return error(err.message, 404);
    return toResponse(err);
  }
};
