import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { getAssignmentById } from "../../../../lib/db/assignments";
import { getClassroomById } from "../../../../lib/db/classrooms";
import { getRepoByAssignmentStudent, touchPermissionSynced } from "../../../../lib/db/repos";
import { findStudentByUser } from "../../../../lib/db/students";
import { getInstallationToken } from "../../../../lib/github/app";
import { addCollaborator } from "../../../../lib/github/repos";
import { NotFoundError, toResponse } from "../../../../lib/http/errors";
import { error, json } from "../../../../lib/http/json";

export const POST: APIRoute = async ({ params, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    const classroom = await getClassroomById(env.DB, assignment.classroomId);
    if (!classroom) throw new NotFoundError("Classroom not found");

    const student = await findStudentByUser(env.DB, assignment.classroomId, session.userId);
    if (!student) throw new NotFoundError("You are not enrolled in this classroom");

    const repo = await getRepoByAssignmentStudent(env.DB, assignment.id, student.id);
    if (!repo) throw new NotFoundError("Accept the assignment first");

    const token = await getInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });

    const collab = await addCollaborator({
      token,
      owner: classroom.githubOrg,
      repo: repo.repoName,
      username: session.githubUsername,
      permission: "push",
    });

    await touchPermissionSynced(env.DB, repo.id);

    return json({ status: collab.status, invitationUrl: collab.invitationUrl }, 200);
  } catch (err) {
    return toResponse(err);
  }
};
