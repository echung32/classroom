import { base64UrlEncode } from "../encoding";
import { githubRequest } from "./client";

export interface AppAuthOptions {
  appId: string;
  privateKey: string; // PKCS#8 PEM
  installationId: string;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
}

export interface InstallationToken {
  token: string;
  expiresAt: string; // ISO8601 from GitHub
}

async function importRs256PrivateKey(pem: string): Promise<CryptoKey> {
  if (pem.includes("RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is in PKCS#1 format (as downloaded from GitHub) but WebCrypto requires PKCS#8. " +
        "Convert it once with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.private-key.pem -out app.private-key.pkcs8.pem",
    );
  }
  const body = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  let der: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(body);
    der = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not valid PEM (base64 decode failed)");
  }
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function buildAppJwt(options: {
  appId: string;
  privateKey: string;
  nowSeconds?: number;
}): Promise<string> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  // iat backdated 60s for clock drift; exp <= 10 minutes per GitHub's limit.
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: options.appId,
    iat: now - 60,
    exp: now + 540,
  })}`;
  const key = await importRs256PrivateKey(options.privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function mintInstallationToken(options: AppAuthOptions): Promise<InstallationToken> {
  const jwt = await buildAppJwt(options);
  const { data } = await githubRequest<{ token: string; expires_at: string }>(
    `/app/installations/${options.installationId}/access_tokens`,
    { method: "POST", token: jwt, fetchImpl: options.fetchImpl },
  );
  return { token: data.token, expiresAt: data.expires_at };
}

// Module-scope cache: survives across requests within a Worker isolate,
// which is exactly the lifetime we want (spec defers KV caching).
let cachedToken: { key: string; token: string; expiresAtMs: number } | null = null;
const EXPIRY_BUFFER_MS = 60_000;

export async function getInstallationToken(options: AppAuthOptions): Promise<string> {
  const key = `${options.appId}:${options.installationId}`;
  const nowMs = (options.nowSeconds ?? Math.floor(Date.now() / 1000)) * 1000;
  if (cachedToken && cachedToken.key === key && nowMs < cachedToken.expiresAtMs - EXPIRY_BUFFER_MS) {
    return cachedToken.token;
  }
  const minted = await mintInstallationToken(options);
  cachedToken = { key, token: minted.token, expiresAtMs: Date.parse(minted.expiresAt) };
  return minted.token;
}

export function clearInstallationTokenCache(): void {
  cachedToken = null;
}
