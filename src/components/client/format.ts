/** Convert an `<input type="datetime-local">` value (teacher's local wall clock)
 *  to an ISO-8601 UTC string for `deadline_at`. Blank → undefined (no deadline). */
export function localDateTimeToUtcIso(local: string): string | undefined {
  if (!local) return undefined;
  return new Date(local).toISOString();
}

/** Tailwind classes for the submission-status Badge:
 *  on_time green, late amber, missing gray, pending/unknown muted gray. */
export function statusBadgeClass(status: string | null): string {
  switch (status) {
    case "on_time":
      return "bg-green-600 text-white";
    case "late":
      return "bg-amber-500 text-white";
    case "missing":
      return "bg-gray-500 text-white";
    default:
      return "bg-gray-200 text-gray-700";
  }
}

/** First 7 chars of a commit SHA; em-dash when absent. */
export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}
