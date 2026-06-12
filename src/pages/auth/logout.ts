import type { APIRoute } from "astro";
import { SESSION_COOKIE_NAME } from "../../lib/auth/session";

// Deliberately a GET so the layout can use a plain link. Worst-case CSRF here is a
// forced logout (nuisance, no data exposure), acceptable for this console.
export const GET: APIRoute = async ({ cookies, redirect }) => {
  cookies.delete(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
  return redirect("/", 302);
};
