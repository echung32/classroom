import type { APIRoute } from "astro";
import { requireSession } from "../../../../lib/auth/require";
import { getEnv } from "../../../../lib/config";
import { createAssignment } from "../../../../lib/db/assignments";
import { assertOwnsClassroom } from "../../../../lib/domain/authz";
import { splitRepo } from "../../../../lib/domain/slug";
import { getInstallationToken } from "../../../../lib/github/app";
import { getRepoMeta } from "../../../../lib/github/repos";
import { ValidationError, toResponse } from "../../../../lib/http/errors";
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

    // Validate the template now (teacher-time) instead of letting it fail at
    // student-accept time as an opaque 502.
    const token = await getInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });
    const [owner, name] = splitRepo(body.template_repo);
    const meta = await getRepoMeta({ token, owner, name });
    if (meta === null) {
      throw new ValidationError("Invalid template repository", {
        template_repo: "Template repo not found or not accessible to the app",
      });
    }
    if (!meta.isTemplate) {
      throw new ValidationError("Invalid template repository", {
        template_repo: "Not a template repository — enable 'Template repository' in its GitHub settings",
      });
    }

    const assignment = await createAssignment(env.DB, {
      classroomId: classroom.id,
      slug: body.slug,
      title: body.title,
      templateRepo: body.template_repo,
      deadlineAt: body.deadline_at,
    });
    return json(assignment, 201);
  } catch (err) {
    return toResponse(err);
  }
};
