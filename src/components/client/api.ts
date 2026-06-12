/** A non-2xx API response, carrying the server's `{ error: { message, fields? } }`. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The single request path for all islands. Always sends the JSON content-type
 * (required by Astro CSRF even for body-less POSTs) and unwraps the `{ data }`
 * success envelope. Throws ApiError on any non-2xx.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: { method: "POST" | "PUT"; body?: unknown },
): Promise<T> {
  const res = await fetch(path, {
    method: init.method,
    headers: { "content-type": "application/json" },
    body: init.body === undefined ? "{}" : JSON.stringify(init.body),
  });

  let payload: { data?: T; error?: { message?: string; fields?: Record<string, string> } } | null =
    null;
  try {
    payload = await res.json();
  } catch {
    // non-JSON body (e.g. CSRF 403 / gateway error) — fall through to the generic error
  }

  if (!res.ok) {
    throw new ApiError(
      payload?.error?.message ?? `Request failed (${res.status})`,
      res.status,
      payload?.error?.fields,
    );
  }
  if (payload === null) {
    throw new ApiError(`Unexpected non-JSON response (${res.status})`, res.status);
  }
  return payload.data as T;
}
