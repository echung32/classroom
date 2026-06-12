const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Success envelope: `{ data }`. create → 201, read → 200. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: JSON_HEADERS });
}

/** Failure envelope: `{ error: { message, fields? } }`. */
export function error(message: string, status: number, fields?: Record<string, string>): Response {
  const body = fields ? { error: { message, fields } } : { error: { message } };
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
