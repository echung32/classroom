/// <reference types="astro/client" />

// Minimal declaration so `import { env } from "cloudflare:workers"` typechecks
// without pulling Cloudflare's global runtime types into the DOM-typed project.
// src/lib/config.ts narrows this to the typed AppEnv.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
