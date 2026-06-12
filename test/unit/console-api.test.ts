import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "../../src/components/client/api";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

describe("apiFetch", () => {
  it("sends JSON with the content-type header and unwraps { data }", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { data: { id: "c1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await apiFetch<{ id: string }>("/api/classrooms", {
      method: "POST",
      body: { name: "x" },
    });

    expect(data).toEqual({ id: "c1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/classrooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
  });

  it("sends '{}' for body-less calls (Astro CSRF needs the JSON content-type)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/assignments/a1/submissions/refresh", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledWith("/api/assignments/a1/submissions/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  });

  it("throws ApiError carrying message, status, and fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, { error: { message: "bad", fields: { slug: "invalid slug" } } }),
      ),
    );

    const err = await apiFetch("/api/x", { method: "POST" }).catch((e) => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("bad");
    expect(err.status).toBe(400);
    expect(err.fields).toEqual({ slug: "invalid slug" });
  });

  it("throws a generic ApiError when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error("not json"); } })),
    );

    const err = await apiFetch("/api/x", { method: "POST" }).catch((e) => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("Request failed (502)");
    expect(err.status).toBe(502);
  });
});
