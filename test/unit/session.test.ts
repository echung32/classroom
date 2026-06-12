import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  signSession,
  signValue,
  verifySession,
  verifyValue,
} from "../../src/lib/auth/session";
import { base64UrlEncode } from "../../src/lib/encoding";

const SECRET = "unit-test-secret";
const NOW = 1_765_000_000; // fixed epoch seconds

describe("signValue / verifyValue", () => {
  it("round-trips a payload", async () => {
    const signed = await signValue({ hello: "world" }, SECRET);
    expect(await verifyValue(signed, SECRET)).toEqual({ hello: "world" });
  });

  it("rejects a tampered body", async () => {
    const signed = await signValue({ role: "student" }, SECRET);
    const [body, sig] = signed.split(".");
    const forgedBody = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ role: "teacher" })));
    expect(await verifyValue(`${forgedBody}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a signature from a different secret", async () => {
    const signed = await signValue({ a: 1 }, "other-secret");
    expect(await verifyValue(signed, SECRET)).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    for (const garbage of ["", "no-dot", "a.b.c.d", "!!!.???"]) {
      expect(await verifyValue(garbage, SECRET)).toBeNull();
    }
  });
});

describe("signSession / verifySession", () => {
  it("round-trips and stamps iat/exp", async () => {
    const cookie = await signSession({ userId: "u1", githubUsername: "octocat" }, SECRET, NOW);
    const payload = await verifySession(cookie, SECRET, NOW);
    expect(payload).toEqual({
      userId: "u1",
      githubUsername: "octocat",
      iat: NOW,
      exp: NOW + SESSION_TTL_SECONDS,
    });
  });

  it("rejects an expired session", async () => {
    const cookie = await signSession({ userId: "u1", githubUsername: "octocat" }, SECRET, NOW);
    expect(await verifySession(cookie, SECRET, NOW + SESSION_TTL_SECONDS + 1)).toBeNull();
  });

  it("rejects tampering", async () => {
    const cookie = await signSession({ userId: "u1", githubUsername: "octocat" }, SECRET, NOW);
    expect(await verifySession(cookie + "x", SECRET, NOW)).toBeNull();
  });

  it("exports the cookie name used by endpoints", () => {
    expect(SESSION_COOKIE_NAME).toBe("session");
  });
});
