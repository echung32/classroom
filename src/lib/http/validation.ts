import * as v from "valibot";
import { ValidationError } from "./errors";

/** Parse a JSON request body against a Valibot schema. Throws ValidationError on failure. */
export async function parseBody<S extends v.GenericSchema>(
  request: Request,
  schema: S,
): Promise<v.InferOutput<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }

  const result = v.safeParse(schema, raw);
  if (result.success) return result.output;

  // Flatten per-field issues into { field: firstMessage } for a future UI.
  const flat = v.flatten(result.issues);
  const fields: Record<string, string> = {};
  for (const [key, messages] of Object.entries(flat.nested ?? {})) {
    if (messages && messages.length > 0) fields[key] = messages[0];
  }
  throw new ValidationError("Validation failed", fields);
}
