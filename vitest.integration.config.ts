import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      include: ["test/integration/**/*.test.ts"],
      setupFiles: ["./test/integration/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              SESSION_SECRET: "test-session-secret",
              GITHUB_OAUTH_CLIENT_ID: "test-client-id",
              GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
              GITHUB_APP_ID: "12345",
              GITHUB_APP_PRIVATE_KEY: "unused-in-integration-tests",
              GITHUB_APP_INSTALLATION_ID: "67890"
            },
          },
        },
      },
    },
  };
});
