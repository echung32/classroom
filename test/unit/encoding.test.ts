import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "../../src/lib/encoding";

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 62, 63, 127]);
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
  });

  it("emits no +, / or = characters", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("round-trips utf-8 JSON text", () => {
    const text = JSON.stringify({ user: "octocat", emoji: "✨" });
    const bytes = new TextEncoder().encode(text);
    expect(new TextDecoder().decode(base64UrlDecode(base64UrlEncode(bytes)))).toBe(text);
  });
});
