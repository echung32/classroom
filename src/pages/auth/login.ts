import type { APIRoute } from "astro";
import { getEnv } from "../../lib/config";
import {
  RETURN_TO_COOKIE_NAME,
  STATE_COOKIE_NAME,
  STATE_TTL_SECONDS,
  buildAuthorizeUrl,
  createState,
  sanitizeReturnTo,
} from "../../lib/auth/oauth";

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const env = getEnv();
  const state = await createState(env.SESSION_SECRET);
  cookies.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });

  // Invite-link support: remember where to land after the OAuth round-trip.
  // Sanitized on write AND on read (callback) — a hostile value never sticks.
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"));
  if (returnTo !== "/") {
    cookies.set(RETURN_TO_COOKIE_NAME, returnTo, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: STATE_TTL_SECONDS,
    });
  }

  return redirect(buildAuthorizeUrl({ clientId: env.GITHUB_OAUTH_CLIENT_ID, state }), 302);
};
