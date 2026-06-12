import * as v from "valibot";
import { isValidSlug } from "../domain/slug";

/** True if `tz` is a timezone the runtime's Intl accepts. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// owner/name — GitHub-ish chars only, exactly one slash. Existence NOT checked (Phase 2).
const TEMPLATE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const classroomSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "name is required")),
  github_org: v.pipe(v.string(), v.trim(), v.minLength(1, "github_org is required")),
  timezone: v.optional(
    v.pipe(v.string(), v.check(isValidTimezone, "timezone must be a valid IANA timezone")),
    "UTC",
  ),
});

export const assignmentSchema = v.object({
  slug: v.pipe(
    v.string(),
    v.check(isValidSlug, "slug must be url-safe: lowercase, hyphen-separated, 1–60 chars"),
  ),
  title: v.pipe(v.string(), v.trim(), v.minLength(1, "title is required")),
  template_repo: v.pipe(
    v.string(),
    v.regex(TEMPLATE_REPO_RE, "template_repo must be in owner/name form"),
  ),
  deadline_at: v.optional(
    v.pipe(v.string(), v.isoTimestamp("deadline_at must be an ISO-8601 UTC timestamp")),
  ),
  grace_minutes: v.optional(
    v.pipe(v.number(), v.integer("grace_minutes must be an integer"), v.minValue(0, "grace_minutes must be >= 0")),
    0,
  ),
});

export type ClassroomBody = v.InferOutput<typeof classroomSchema>;
export type AssignmentBody = v.InferOutput<typeof assignmentSchema>;

export const seedRosterSchema = v.object({
  identifiers: v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.minLength(1, "identifier must not be empty"))),
    v.minLength(1, "identifiers must contain at least one entry"),
  ),
});

export const acceptAssignmentSchema = v.object({
  rosterStudentId: v.optional(v.pipe(v.string(), v.uuid("rosterStudentId must be a valid id"))),
});

export type SeedRosterBody = v.InferOutput<typeof seedRosterSchema>;
export type AcceptAssignmentBody = v.InferOutput<typeof acceptAssignmentSchema>;
