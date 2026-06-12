import { base64UrlDecode, base64UrlEncode } from "../encoding";

export const SESSION_COOKIE_NAME = "session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  userId: string;
  githubUsername: string;
  iat: number; // epoch seconds
  exp: number; // epoch seconds
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** Generic HMAC-SHA256-signed value: `base64url(json).base64url(mac)`. */
export async function signValue(payload: unknown, secret: string): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret, "sign");
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(mac))}`;
}

/** Returns the payload, or null for anything invalid. Never throws. */
export async function verifyValue<T>(value: string, secret: string): Promise<T | null> {
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;
  let sigBytes: Uint8Array;
  let bodyBytes: Uint8Array;
  try {
    sigBytes = base64UrlDecode(sig);
    bodyBytes = base64UrlDecode(body);
  } catch {
    return null;
  }
  const key = await hmacKey(secret, "verify");
  // crypto.subtle.verify is constant-time; never compare MACs with ===.
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(body));
  if (!valid) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bodyBytes)) as T;
  } catch {
    return null;
  }
}

export async function signSession(
  data: { userId: string; githubUsername: string },
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: SessionPayload = {
    ...data,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
  };
  return signValue(payload, secret);
}

export async function verifySession(
  value: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SessionPayload | null> {
  const payload = await verifyValue<SessionPayload>(value, secret);
  if (!payload || typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
  if (typeof payload.userId !== "string" || typeof payload.githubUsername !== "string") return null;
  return payload;
}
