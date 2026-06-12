// The integration runtime types (@cloudflare/vitest-pool-workers) type
// `env` from "cloudflare:test" as `Cloudflare.Env`. Augment that interface
// (declared empty in @cloudflare/workers-types/experimental) with the bindings
// and miniflare-provided values used by the integration tests.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    SESSION_SECRET: string;
    GITHUB_OAUTH_CLIENT_ID: string;
    GITHUB_OAUTH_CLIENT_SECRET: string;
    GITHUB_APP_ID: string;
    GITHUB_APP_PRIVATE_KEY: string;
    GITHUB_APP_INSTALLATION_ID: string;
  }
}
