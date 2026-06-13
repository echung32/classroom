import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { getAssignmentById } from "../../../../lib/db/assignments";
import { getClassroomById } from "../../../../lib/db/classrooms";
import { getRepoByAssignmentStudent, recordRepo } from "../../../../lib/db/repos";
import { resolveStudentForAccept } from "../../../../lib/domain/enrollment";
import { repoNameFor, repoUrlFor, splitRepo } from "../../../../lib/domain/slug";
import { getInstallationOrg, getInstallationToken } from "../../../../lib/github/app";
import { addCollaborator, createRepoFromTemplate } from "../../../../lib/github/repos";
import { NotFoundError, toResponse } from "../../../../lib/http/errors";
import { error, json } from "../../../../lib/http/json";
import { acceptAssignmentSchema } from "../../../../lib/http/schemas";
import { parseBody } from "../../../../lib/http/validation";

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const env = getEnv();
  const session = await requireSession(cookies, env.SESSION_SECRET);
  if (!session) return error("Authentication required", 401);

  try {
    const body = await parseBody(request, acceptAssignmentSchema);

    const assignment = await getAssignmentById(env.DB, params.id!);
    if (!assignment) throw new NotFoundError("Assignment not found");
    // Existence check only — the org now comes from getInstallationOrg, not the classroom row.
    const classroom = await getClassroomById(env.DB, assignment.classroomId);
    if (!classroom) throw new NotFoundError("Classroom not found");

    const student = await resolveStudentForAccept(env.DB, {
      classroomId: assignment.classroomId,
      userId: session.userId,
      githubUsername: session.githubUsername,
      rosterStudentId: body.rosterStudentId,
    });

    const org = await getInstallationOrg({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });

    // Idempotency: if a repo already exists for (assignment, student), accept is
    // already done. This short-circuit mints no token and writes nothing; the
    // only GitHub call is the org lookup above (cached per isolate after the
    // first). Org stays a separate getInstallationOrg (not getInstallationCreds)
    // so the token is minted lazily and only on the create path below.
    const existing = await getRepoByAssignmentStudent(env.DB, assignment.id, student.id);
    if (existing) {
      return json(
        { repoUrl: repoUrlFor(org, existing.repoName), status: "already_accepted" },
        201,
      );
    }

    const token = await getInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });

    const [templateOwner, templateRepo] = splitRepo(assignment.templateRepo);
    const repoName = repoNameFor(assignment.slug, session.githubUsername);

    const created = await createRepoFromTemplate({
      token,
      templateOwner,
      templateRepo,
      owner: org,
      name: repoName,
      isPrivate: true,
    });

    const collab = await addCollaborator({
      token,
      owner: org,
      repo: repoName,
      username: session.githubUsername,
      permission: "push",
    });

    await recordRepo(env.DB, {
      assignmentId: assignment.id,
      studentId: student.id,
      repoName,
      repoId: created.repoId,
    });

    return json(
      { repoUrl: created.htmlUrl, invitationUrl: collab.invitationUrl, status: collab.status },
      201,
    );
  } catch (err) {
    return toResponse(err);
  }
};
