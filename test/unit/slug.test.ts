import { describe, expect, it } from "vitest";
import { isValidSlug, normalizeToSlug, repoNameFor } from "../../src/lib/domain/slug";

describe("isValidSlug", () => {
  it("accepts lowercase alphanumeric hyphen-separated slugs", () => {
    expect(isValidSlug("hw1")).toBe(true);
    expect(isValidSlug("intro-to-loops")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
    expect(isValidSlug("project2-final")).toBe(true);
  });

  it("rejects uppercase, edge hyphens, double hyphens, empty, and >60 chars", () => {
    expect(isValidSlug("HW1")).toBe(false);
    expect(isValidSlug("-lead")).toBe(false);
    expect(isValidSlug("trail-")).toBe(false);
    expect(isValidSlug("double--hyphen")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("a".repeat(61))).toBe(false);
    expect(isValidSlug("has space")).toBe(false);
    expect(isValidSlug("under_score")).toBe(false);
  });

  it("accepts exactly 60 chars", () => {
    expect(isValidSlug("a".repeat(60))).toBe(true);
  });
});

describe("normalizeToSlug", () => {
  it("slugifies messy titles into valid slugs", () => {
    expect(normalizeToSlug("Intro To Loops")).toBe("intro-to-loops");
    expect(normalizeToSlug("  HW #1: Arrays!  ")).toBe("hw-1-arrays");
    expect(normalizeToSlug("a___b")).toBe("a-b");
    expect(isValidSlug(normalizeToSlug("Project 2 — Final!!!"))).toBe(true);
  });
});

describe("repoNameFor", () => {
  it("composes {slug}-{username} and lowercases the username", () => {
    expect(repoNameFor("hw1", "OctoCat")).toBe("hw1-octocat");
    expect(repoNameFor("intro-to-loops", "alice")).toBe("intro-to-loops-alice");
  });
});
