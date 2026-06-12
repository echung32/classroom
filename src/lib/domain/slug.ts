const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** url-safe charset, lowercase, no leading/trailing/double hyphens, length 1–60. */
export function isValidSlug(s: string): boolean {
  return s.length >= 1 && s.length <= 60 && SLUG_RE.test(s);
}

/** Best-effort slugify of a title. Callers still validate the result with isValidSlug. */
export function normalizeToSlug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // runs of invalid chars collapse to one hyphen
    .replace(/^-+|-+$/g, ""); // strip leading/trailing hyphens
}

/** Deterministic per-student repo name. GitHub usernames are case-insensitive. */
export function repoNameFor(slug: string, username: string): string {
  return `${slug}-${username.toLowerCase()}`;
}

/** Split an "owner/name" repo reference into its two parts. */
export function splitRepo(fullName: string): [owner: string, repo: string] {
  const slash = fullName.indexOf("/");
  return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}

/** Construct a github.com html url for a repo we own. */
export function repoUrlFor(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}
