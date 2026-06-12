import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { decisionSchema } from "../../src/lib/http/schemas";

describe("decisionSchema", () => {
  it("accepts the three valid decisions", () => {
    for (const decision of ["at_deadline", "accept_late", "exclude"]) {
      expect(v.parse(decisionSchema, { decision }).decision).toBe(decision);
    }
  });

  it("rejects an unknown decision", () => {
    expect(() => v.parse(decisionSchema, { decision: "maybe" })).toThrow();
  });
});
