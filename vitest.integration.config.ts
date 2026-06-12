import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Point at the build-generated wrangler config (dist/server/wrangler.json),
      // not the source ./wrangler.jsonc. The source config's `main` is the
      // adapter shim package export which has no Astro manifest, so SELF.fetch
      // would hit a manifest-less worker. `yarn test:integration` runs
      // `yarn build` first, so this file exists before vitest starts and points
      // at the real built SSR worker (entry.mjs) with the bundled route manifest.
      wrangler: { configPath: "./dist/server/wrangler.json" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          SESSION_SECRET: "test-session-secret",
          GITHUB_OAUTH_CLIENT_ID: "test-client-id",
          GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
          GITHUB_APP_ID: "12345",
          GITHUB_APP_PRIVATE_KEY: "unused-in-integration-tests",
          GITHUB_APP_INSTALLATION_ID: "67890",
        },
      },
    }),
  ],
  test: {
    include: ["test/integration/**/*.test.ts"],
    setupFiles: ["./test/integration/apply-migrations.ts"],
  },
});
