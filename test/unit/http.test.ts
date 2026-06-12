import { describe, expect, it } from "vitest";
import { error, json } from "../../src/lib/http/json";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  toResponse,
} from "../../src/lib/http/errors";

describe("json", () => {
  it("wraps data under `data` with the given status and JSON content-type", async () => {
    const res = json({ id: "x" }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ data: { id: "x" } });
  });

  it("defaults to status 200", () => {
    expect(json({ ok: true }).status).toBe(200);
  });
});

describe("error", () => {
  it("shapes failures under `error` with message and optional fields", async () => {
    expect(await error("nope", 403).json()).toEqual({ error: { message: "nope" } });
    const withFields = error("bad", 400, { name: "required" });
    expect(withFields.status).toBe(400);
    expect(await withFields.json()).toEqual({ error: { message: "bad", fields: { name: "required" } } });
  });
});

describe("toResponse", () => {
  it("maps each typed error to its status", async () => {
    expect(toResponse(new ValidationError("v", { f: "x" })).status).toBe(400);
    expect(toResponse(new ForbiddenError("f")).status).toBe(403);
    expect(toResponse(new NotFoundError("n")).status).toBe(404);
    expect(toResponse(new ConflictError("c")).status).toBe(409);
  });

  it("carries ValidationError field messages through to the body", async () => {
    const res = toResponse(new ValidationError("Validation failed", { slug: "invalid" }));
    expect(await res.json()).toEqual({
      error: { message: "Validation failed", fields: { slug: "invalid" } },
    });
  });

  it("maps unknown errors to a 500 without leaking the message", async () => {
    const res = toResponse(new Error("secret internal detail"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: "Internal Server Error" } });
  });
});
