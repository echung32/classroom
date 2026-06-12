import type { APIRoute } from "astro";
import { getEnv } from "../../lib/config";
import {
  STATE_COOKIE_NAME,
  exchangeCode,
  fetchAuthenticatedUser,
  verifyState,
} from "../../lib/auth/oauth";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS, signSession } from "../../lib/auth/session";
import { upsertUser } from "../../lib/db/users";

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const env = getEnv();
  const params = url.searchParams;

  // GitHub sent the user back with an error (e.g. access_denied).
  const githubError = params.get("error");
  if (githubError) {
    return redirect(`/?error=${encodeURIComponent(githubError)}`, 302);
  }

  const code = params.get("code");
  const state = params.get("state");
  const stateCookie = cookies.get(STATE_COOKIE_NAME)?.value;
  cookies.delete(STATE_COOKIE_NAME, { path: "/" });

  // CSRF guard: the state must be validly signed AND match the cookie set at /auth/login.
  if (
    !code ||
    !state ||
    !stateCookie ||
    state !== stateCookie ||
    !(await verifyState(state, env.SESSION_SECRET))
  ) {
    return redirect("/?error=invalid_state", 302);
  }

  try {
    const accessToken = await exchangeCode({
      code,
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
    });
    const githubUser = await fetchAuthenticatedUser(accessToken);
    const user = await upsertUser(env.DB, {
      githubId: githubUser.githubId,
      githubUsername: githubUser.login,
    });

    const session = await signSession(
      { userId: user.id, githubUsername: user.githubUsername },
      env.SESSION_SECRET,
    );
    cookies.set(SESSION_COOKIE_NAME, session, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return redirect("/", 302);
  } catch (error) {
    // Message only — GitHubApiError messages never contain tokens (client.ts).
    console.error("oauth callback failed:", error instanceof Error ? error.message : String(error));
    return redirect("/?error=oauth_failed", 302);
  }
};
