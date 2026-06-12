import { githubRequest } from "../github/client";
import { signValue, verifyValue } from "./session";

export const STATE_COOKIE_NAME = "oauth_state";
export const STATE_TTL_SECONDS = 600; // 10 minutes

export const RETURN_TO_COOKIE_NAME = "return_to";

/** Same-origin guard for post-login redirects. Returns `value` only when it is
 *  an absolute same-origin path: starts with "/" but not "//" or "/\" (browsers
 *  treat both as protocol-relative). Anything else falls back to "/". */
export function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

interface StatePayload {
  t: "oauth-state"; // type tag: a signed session can never pass as a state
  nonce: string;
  exp: number; // epoch seconds
}

export function buildAuthorizeUrl(options: { clientId: string; state: string }): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("state", options.state);
  return url.toString();
}

export async function createState(
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: StatePayload = {
    t: "oauth-state",
    nonce: crypto.randomUUID(),
    exp: nowSeconds + STATE_TTL_SECONDS,
  };
  return signValue(payload, secret);
}

export async function verifyState(
  state: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const payload = await verifyValue<StatePayload>(state, secret);
  return payload !== null && payload.t === "oauth-state" && payload.exp > nowSeconds;
}

export async function exchangeCode(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { data } = await githubRequest<{
    access_token?: string;
    error?: string;
    error_description?: string;
  }>("https://github.com/login/oauth/access_token", {
    method: "POST",
    accept: "application/json",
    body: {
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
    },
    fetchImpl: options.fetchImpl,
  });

  // GitHub returns 200 with an error body on failure — fail closed.
  if (data.error) {
    throw new Error(
      `OAuth code exchange failed: ${data.error}${data.error_description ? ` (${data.error_description})` : ""}`,
    );
  }
  if (!data.access_token) {
    throw new Error("OAuth code exchange failed: no access_token in response");
  }
  return data.access_token;
}

export async function fetchAuthenticatedUser(
  token: string,
  fetchImpl?: typeof fetch,
): Promise<{ githubId: number; login: string }> {
  const { data } = await githubRequest<{ id: number; login: string }>("/user", {
    token,
    fetchImpl,
  });
  return { githubId: data.id, login: data.login };
}
