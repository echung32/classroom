import { GitHubApiError } from "../github/client";
import { error } from "./json";

/** Request body / slug failed validation. `fields` is per-field messages for a future UI. */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** Map a thrown domain error to an HTTP response. Unknown errors → 500 (message hidden). */
export function toResponse(err: unknown): Response {
  if (err instanceof ValidationError) return error(err.message, 400, err.fields);
  if (err instanceof ForbiddenError) return error(err.message, 403);
  if (err instanceof NotFoundError) return error(err.message, 404);
  if (err instanceof ConflictError) return error(err.message, 409);
  if (err instanceof GitHubApiError) {
    // Log the real upstream detail server-side; never return it (it may contain tokens).
    console.error("github upstream error:", err.status, err.message);
    return error("Upstream GitHub request failed", 502);
  }
  console.error("unhandled endpoint error:", err instanceof Error ? err.message : String(err));
  return error("Internal Server Error", 500);
}
