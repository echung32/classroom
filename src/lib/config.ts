import { env as runtimeEnv } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";

export interface AppEnv {
  DB: D1Database;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  DEBUG_ROUTES?: string;
}

const REQUIRED_KEYS = [
  "DB",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "SESSION_SECRET",
] as const;

/** Typed env access. Throws naming exactly what's missing (names only, never values). */
export function getEnv(): AppEnv {
  const env = runtimeEnv as Partial<AppEnv>;
  const missing = REQUIRED_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required bindings/secrets: ${missing.join(", ")}. ` +
        "Locally: copy .dev.vars.example to .dev.vars (see docs/github-setup.md). " +
        "Deployed: wrangler secret put <NAME>.",
    );
  }
  return env as AppEnv;
}
