import { describe, expect, it } from "vitest";
import {
  localDateTimeToUtcIso,
  shortSha,
  statusBadgeClass,
} from "../../src/components/client/format";

describe("localDateTimeToUtcIso", () => {
  it("converts a datetime-local value to an ISO-8601 UTC string", () => {
    const result = localDateTimeToUtcIso("2026-06-12T10:30");
    // TZ-agnostic: assert UTC ISO shape + the same instant Date derives locally.
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(result!)).toBe(new Date("2026-06-12T10:30").getTime());
  });

  it("returns undefined for a blank value (no deadline)", () => {
    expect(localDateTimeToUtcIso("")).toBeUndefined();
  });
});

describe("statusBadgeClass", () => {
  it("maps each status to its color classes", () => {
    expect(statusBadgeClass("on_time")).toContain("green");
    expect(statusBadgeClass("late")).toContain("amber");
    expect(statusBadgeClass("missing")).toContain("bg-gray-500");
    expect(statusBadgeClass("pending")).toContain("bg-gray-200");
    expect(statusBadgeClass(null)).toContain("bg-gray-200");
  });
});

describe("shortSha", () => {
  it("truncates to 7 chars and renders null as a dash", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
    expect(shortSha(null)).toBe("—");
  });
});
