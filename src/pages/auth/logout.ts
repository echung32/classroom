import type { APIRoute } from "astro";
import { SESSION_COOKIE_NAME } from "../../lib/auth/session";

export const GET: APIRoute = async ({ cookies, redirect }) => {
  cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
  return redirect("/", 302);
};
