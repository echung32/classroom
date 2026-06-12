import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// @cloudflare/vitest-pool-workers v4 has no per-test `isolatedStorage`, so D1 state
// persists across tests. Reset every mutable table before each test for isolation.
// Order respects foreign keys (children before parents).
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM submissions"),
    env.DB.prepare("DELETE FROM repos"),
    env.DB.prepare("DELETE FROM students"),
    env.DB.prepare("DELETE FROM assignments"),
    env.DB.prepare("DELETE FROM classrooms"),
    env.DB.prepare("DELETE FROM users"),
  ]);
});
