import { env } from "cloudflare:test";
import { SESSION_COOKIE_NAME, signSession } from "../../src/lib/auth/session";
import { type User, upsertUser } from "../../src/lib/db/users";

/** Seed a user in the test D1 and return a Cookie header carrying their signed session. */
export async function seedUserAndCookie(input: {
  githubId: number;
  login: string;
}): Promise<{ user: User; cookie: string }> {
  const user = await upsertUser(env.DB, { githubId: input.githubId, githubUsername: input.login });
  const token = await signSession(
    { userId: user.id, githubUsername: user.githubUsername },
    env.SESSION_SECRET,
  );
  return { user, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}
