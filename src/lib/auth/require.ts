import type { AstroCookies } from "astro";
import { SESSION_COOKIE_NAME, type SessionPayload, verifySession } from "./session";

/** Read + verify the session cookie. Endpoints turn `null` into a 401. */
export async function requireSession(
  cookies: AstroCookies,
  secret: string,
): Promise<SessionPayload | null> {
  const value = cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!value) return null;
  return verifySession(value, secret);
}
