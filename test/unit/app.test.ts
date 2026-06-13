import { beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlDecode } from "../../src/lib/encoding";
import {
  buildAppJwt,
  clearInstallationOrgCache,
  clearInstallationTokenCache,
  getInstallationCreds,
  getInstallationOrg,
  getInstallationToken,
  mintInstallationToken,
} from "../../src/lib/github/app";

const NOW = 1_765_000_000;

async function generateTestKeyPair(): Promise<{ privateKeyPem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const b64 = btoa(binary);
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return {
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
}

describe("buildAppJwt", () => {
  it("produces an RS256 JWT with iss/iat/exp that verifies against the public key", async () => {
    const { privateKeyPem, publicKey } = await generateTestKeyPair();
    const jwt = await buildAppJwt({ appId: "12345", privateKey: privateKeyPem, nowSeconds: NOW });

    const [header, claims, signature] = jwt.split(".");
    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(claims)).toEqual({ iss: "12345", iat: NOW - 60, exp: NOW + 540 });

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64UrlDecode(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it("rejects a PKCS#1 key with a conversion hint", async () => {
    const pkcs1 = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----";
    await expect(buildAppJwt({ appId: "1", privateKey: pkcs1, nowSeconds: NOW })).rejects.toThrow(
      /pkcs8/i,
    );
  });
});

describe("mintInstallationToken", () => {
  it("exchanges the JWT at the installation access_tokens endpoint", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ token: "ghs_minted", expires_at: "2026-06-12T01:00:00Z" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await mintInstallationToken({
      appId: "12345",
      privateKey: privateKeyPem,
      installationId: "67890",
      fetchImpl,
      nowSeconds: NOW,
    });
    expect(result).toEqual({ token: "ghs_minted", expiresAt: "2026-06-12T01:00:00Z" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/67890/access_tokens");
    expect(init.method).toBe("POST");
    const auth = (init.headers as Record<string, string>).authorization;
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/); // Bearer <jwt>
  });

  it("throws on a non-2xx response without leaking the JWT", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const fetchImpl = vi.fn(async () => new Response("Integration not found", { status: 404 }));
    const error = await mintInstallationToken({
      appId: "12345",
      privateKey: privateKeyPem,
      installationId: "67890",
      fetchImpl,
      nowSeconds: NOW,
    }).catch((e) => e);
    expect(error.message).toMatch(/404/);
    expect(error.message).not.toMatch(/Bearer/);
  });
});

describe("getInstallationToken cache", () => {
  beforeEach(() => clearInstallationTokenCache());

  function mintingFetch(token: string, expiresAt: string) {
    return vi.fn(
      async () =>
        new Response(JSON.stringify({ token, expires_at: expiresAt }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
  }

  it("reuses the cached token before expiry", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const expiresAt = new Date((NOW + 3600) * 1000).toISOString();
    const fetchImpl = mintingFetch("ghs_one", expiresAt);
    const base = { appId: "1", privateKey: privateKeyPem, installationId: "2", fetchImpl };

    expect(await getInstallationToken({ ...base, nowSeconds: NOW })).toBe("ghs_one");
    expect(await getInstallationToken({ ...base, nowSeconds: NOW + 1800 })).toBe("ghs_one");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-mints within 60s of expiry", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const expiresAt = new Date((NOW + 3600) * 1000).toISOString();
    const fetchImpl = mintingFetch("ghs_two", expiresAt);
    const base = { appId: "1", privateKey: privateKeyPem, installationId: "2", fetchImpl };

    await getInstallationToken({ ...base, nowSeconds: NOW });
    await getInstallationToken({ ...base, nowSeconds: NOW + 3600 - 30 }); // inside the 60s buffer
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not serve a token cached for a different app/installation", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const expiresAt = new Date((NOW + 3600) * 1000).toISOString();
    const fetchImpl = mintingFetch("ghs_three", expiresAt);

    await getInstallationToken({ appId: "1", privateKey: privateKeyPem, installationId: "2", fetchImpl, nowSeconds: NOW });
    await getInstallationToken({ appId: "1", privateKey: privateKeyPem, installationId: "999", fetchImpl, nowSeconds: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("getInstallationOrg cache", () => {
  beforeEach(() => clearInstallationOrgCache());

  function orgFetch(login: string) {
    return vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ account: { login } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  }

  it("resolves account.login from GET /app/installations/:id", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const fetchImpl = orgFetch("acme-org");
    const org = await getInstallationOrg({
      appId: "1", privateKey: privateKeyPem, installationId: "42", fetchImpl, nowSeconds: NOW,
    });
    expect(org).toBe("acme-org");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/42");
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("caches per appId:installationId within the isolate", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const fetchImpl = orgFetch("acme-org");
    const base = { appId: "1", privateKey: privateKeyPem, installationId: "42", fetchImpl, nowSeconds: NOW };
    await getInstallationOrg(base);
    await getInstallationOrg(base);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not serve an org cached for a different installation", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const fetchImpl = orgFetch("acme-org");
    await getInstallationOrg({ appId: "1", privateKey: privateKeyPem, installationId: "42", fetchImpl, nowSeconds: NOW });
    await getInstallationOrg({ appId: "1", privateKey: privateKeyPem, installationId: "99", fetchImpl, nowSeconds: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("getInstallationCreds", () => {
  beforeEach(() => {
    clearInstallationTokenCache();
    clearInstallationOrgCache();
  });

  it("resolves the token and org together", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    // Route both the token-mint POST and the installation GET through one mock.
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(url as string).pathname;
      const body = path.endsWith("/access_tokens")
        ? { token: "ghs_creds", expires_at: new Date((NOW + 3600) * 1000).toISOString() }
        : { account: { login: "acme-org" } };
      return new Response(JSON.stringify(body), {
        status: path.endsWith("/access_tokens") ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    });

    const creds = await getInstallationCreds({
      appId: "1", privateKey: privateKeyPem, installationId: "42", fetchImpl, nowSeconds: NOW,
    });
    expect(creds).toEqual({ token: "ghs_creds", org: "acme-org" });
  });
});
