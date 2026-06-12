import type { APIRoute } from "astro";
import { getEnv } from "../../lib/config";
import {
  STATE_COOKIE_NAME,
  STATE_TTL_SECONDS,
  buildAuthorizeUrl,
  createState,
} from "../../lib/auth/oauth";

export const GET: APIRoute = async ({ cookies, redirect }) => {
  const env = getEnv();
  const state = await createState(env.SESSION_SECRET);
  cookies.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return redirect(buildAuthorizeUrl({ clientId: env.GITHUB_OAUTH_CLIENT_ID, state }), 302);
};
