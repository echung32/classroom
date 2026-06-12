import type { APIRoute } from "astro";
import { getEnv } from "../../lib/config";
import { getInstallationToken } from "../../lib/github/app";
import { GitHubApiError, githubRequest } from "../../lib/github/client";

export const GET: APIRoute = async () => {
  const env = getEnv();
  if (env.DEBUG_ROUTES !== "1") {
    return new Response("Not found", { status: 404 });
  }

  try {
    const token = await getInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });
    const { data, rateLimit } = await githubRequest<{ total_count: number }>(
      "/installation/repositories",
      { token },
    );
    return Response.json({
      ok: true,
      installationRepoCount: data.total_count,
      rateLimitRemaining: rateLimit.remaining,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof GitHubApiError ? 502 : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
};
