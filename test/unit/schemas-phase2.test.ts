import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { acceptAssignmentSchema, seedRosterSchema } from "../../src/lib/http/schemas";

describe("seedRosterSchema", () => {
  it("accepts a non-empty list of trimmed identifiers", () => {
    const out = v.parse(seedRosterSchema, { identifiers: ["  alice  ", "bob"] });
    expect(out.identifiers).toEqual(["alice", "bob"]);
  });

  it("rejects an empty identifiers array", () => {
    expect(() => v.parse(seedRosterSchema, { identifiers: [] })).toThrow();
  });

  it("rejects an empty-string identifier", () => {
    expect(() => v.parse(seedRosterSchema, { identifiers: ["ok", "  "] })).toThrow();
  });

  it("rejects a missing identifiers field", () => {
    expect(() => v.parse(seedRosterSchema, {})).toThrow();
  });
});

describe("acceptAssignmentSchema", () => {
  it("accepts an empty body (skip path)", () => {
    const out = v.parse(acceptAssignmentSchema, {});
    expect(out.rosterStudentId).toBeUndefined();
  });

  it("accepts a valid uuid rosterStudentId (claim path)", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const out = v.parse(acceptAssignmentSchema, { rosterStudentId: id });
    expect(out.rosterStudentId).toBe(id);
  });

  it("rejects a non-uuid rosterStudentId", () => {
    expect(() => v.parse(acceptAssignmentSchema, { rosterStudentId: "not-a-uuid" })).toThrow();
  });
});
