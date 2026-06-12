# Classroom Phase 0 (Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed-ready Astro-on-Cloudflare Worker where a real GitHub OAuth login stores the user's GitHub identity in D1, and the GitHub App path mints an installation token via WebCrypto RS256 and makes one authenticated API call.

**Architecture:** Single Cloudflare Worker built with Astro 6 + `@astrojs/cloudflare`. All logic lives in framework-agnostic modules under `src/lib/` (dependency-injected: secrets, `fetch`, and clock are passed as parameters), so plain Vitest unit-tests them in Node. Astro endpoints are thin adapters that read env via `cloudflare:workers` and call into `src/lib/`. The Worker boundary (endpoints, cookies, D1) is integration-tested with `@cloudflare/vitest-pool-workers` against the **built** Astro worker.

**Tech Stack:** TypeScript, Astro `^6.4.6`, `@astrojs/cloudflare` `^13.7.0`, Wrangler `^4.100.0`, Cloudflare D1, Vitest `^4.1.8`, `@cloudflare/vitest-pool-workers` `^0.16.15`, Yarn 4 (node-modules linker).

**Spec:** `docs/superpowers/specs/2026-06-12-classroom-phase-0-skeleton-design.md`

---

## Resolutions of the spec's "Open Items for Implementation Planning" (§11)

1. **Custom worker entry:** Not needed in Phase 0. Stock adapter; `wrangler.jsonc` `main` points at Astro's build output `./dist/_worker.js/index.js`. Phase 3 will add `src/worker.ts` that imports Astro's SSR handler and adds `scheduled`/`queue` exports, then repoint `main` there.
2. **Smoke call:** `GET /installation/repositories` authenticated with the **installation token** (works with only Metadata: read, and proves the full JWT → installation-token → API-call chain). Exposed as a flag-gated route `GET /debug/github-app`.
3. **Session cookie:** name `session`, `HttpOnly; Secure; SameSite=Lax; Path=/`, TTL **7 days** (`Max-Age=604800`). OAuth state cookie: name `oauth_state`, same attributes, TTL **10 minutes**.
4. **D1 migrations:** Wrangler's migrations workflow. Schema lives at `migrations/0001_init.sql` (this **is** the spec's `schema.sql` deliverable — moved out of `src/lib/db/` because `wrangler d1 migrations apply` and the test helpers `readD1Migrations`/`applyD1Migrations` both consume the `migrations/` directory). Local: `yarn db:migrate:local`. Remote: `yarn db:migrate:remote`. Tests: migrations applied per-test via a setup file.

## Deviations from the spec (flagged, with reasons)

- **`.yarnrc.yml` with `nodeLinker: node-modules`:** the repo currently uses Yarn PnP (`.pnp.cjs`). Wrangler, workerd, and the vitest workers pool resolve files from `node_modules` at runtime and do not work under PnP.
- **OAuth `state` is double-checked:** signed HMAC value (per spec) **and** echoed in a short-lived `oauth_state` cookie that must match the query param. Signature alone doesn't bind the state to the victim's browser (login-CSRF: attacker hands their own validly-signed state+code to the victim). The cookie adds that binding with no server-side storage.
- **`src/lib/encoding.ts` added:** shared base64url helpers used by both HMAC signing and the RS256 JWT (DRY).
- **State failures redirect** (`302` to `/?error=invalid_state`) rather than render a bare 400 page. Spec §7 says "400 logged-out redirect, not 500" — the intent (fail closed, logged out, no 500) is honored; a redirect gives the user a page with a login link instead of a dead end.

## File structure (end state)

```
.yarnrc.yml                      # nodeLinker: node-modules
package.json                     # scripts + deps (modified)
astro.config.mjs                 # cloudflare adapter, output: server, platformProxy
wrangler.jsonc                   # D1 binding DB, nodejs_compat, assets, vars
tsconfig.json                    # astro strict; src + test/unit
vitest.unit.config.ts            # plain node pool, test/unit/**
vitest.integration.config.ts     # workers pool, test/integration/**
.dev.vars.example                # template for local secrets
migrations/0001_init.sql         # full build-plan schema + users table
src/
├─ env.d.ts                      # astro client types + cloudflare:workers module decl
├─ lib/
│  ├─ config.ts                  # typed env access (ONLY file importing cloudflare:workers)
│  ├─ encoding.ts                # base64url encode/decode
│  ├─ auth/
│  │  ├─ session.ts              # signValue/verifyValue (HMAC) + session cookie payload
│  │  └─ oauth.ts                # authorize URL, state create/verify, code exchange, GET /user
│  ├─ github/
│  │  ├─ app.ts                  # RS256 app JWT, installation-token mint, module-scope cache
│  │  └─ client.ts               # fetch wrapper + rate-limit header surfacing
│  └─ db/
│     └─ users.ts                # upsertUser / findUserById (D1)
└─ pages/
   ├─ index.astro                # landing: username or login link
   ├─ debug/github-app.ts        # flag-gated live smoke endpoint
   └─ auth/
      ├─ login.ts                # signed state + redirect to GitHub
      └─ callback.ts             # verify state, exchange code, upsert user, set cookie
test/
├─ unit/                         # plain vitest (Node 24: global fetch + WebCrypto)
│  ├─ encoding.test.ts
│  ├─ client.test.ts
│  ├─ session.test.ts
│  ├─ oauth.test.ts
│  └─ app.test.ts
└─ integration/                  # vitest-pool-workers (real workerd + D1)
   ├─ tsconfig.json              # workers types (kept separate from DOM types)
   ├─ env.d.ts                   # ProvidedEnv declaration
   ├─ apply-migrations.ts        # setup file
   ├─ users.test.ts
   ├─ auth-endpoints.test.ts
   └─ index-page.test.ts
docs/github-setup.md             # operator guide: GitHub App + OAuth app + secrets
```

**Conventions used throughout:**
- Every `src/lib/` function takes its dependencies as explicit parameters (`secret`, `fetchImpl`, `nowSeconds`). No `src/lib/` file except `config.ts` may import `cloudflare:workers` — that keeps unit tests bootable in plain Node.
- All commands run from the repo root with `yarn` (Yarn 4 via Volta, already installed).

---

### Task 1: Toolchain — Yarn linker, dependencies, Astro/Wrangler/TS/Vitest config

**Files:**
- Create: `.yarnrc.yml`, `astro.config.mjs`, `wrangler.jsonc`, `tsconfig.json`, `vitest.unit.config.ts`, `vitest.integration.config.ts`, `.dev.vars.example`, `src/env.d.ts`, `src/pages/index.astro` (placeholder, replaced in Task 9)
- Modify: `package.json`, `.gitignore`

- [ ] **Step 1: Switch Yarn off PnP**

Create `.yarnrc.yml`:

```yaml
nodeLinker: node-modules
```

Then remove the stale PnP artifact:

```bash
rm -f /workspaces/classroom/.pnp.cjs
```

- [ ] **Step 2: Replace `package.json`**

```json
{
  "name": "classroom",
  "private": true,
  "type": "module",
  "packageManager": "yarn@4.16.0",
  "volta": {
    "node": "24.16.0",
    "yarn": "4.16.0"
  },
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "yarn build && wrangler dev",
    "deploy": "yarn build && wrangler deploy",
    "db:migrate:local": "wrangler d1 migrations apply classroom --local",
    "db:migrate:remote": "wrangler d1 migrations apply classroom --remote",
    "typecheck": "tsc --noEmit && tsc --noEmit -p test/integration",
    "test:unit": "vitest run -c vitest.unit.config.ts",
    "test:integration": "yarn build && vitest run -c vitest.integration.config.ts",
    "test": "yarn test:unit && yarn test:integration"
  },
  "dependencies": {
    "@astrojs/cloudflare": "^13.7.0",
    "astro": "^6.4.6"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.16.15",
    "@cloudflare/workers-types": "^4.20260611.1",
    "typescript": "^5.9.0",
    "vitest": "^4.1.8",
    "wrangler": "^4.100.0"
  }
}
```

- [ ] **Step 3: Install**

Run: `yarn install`
Expected: succeeds, creates `node_modules/` (not `.pnp.cjs`).

- [ ] **Step 4: Write `astro.config.mjs`**

```js
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),
});
```

- [ ] **Step 5: Write `wrangler.jsonc`**

`database_id` stays a placeholder until the operator runs `wrangler d1 create classroom` (covered in `docs/github-setup.md`, Task 10). Local dev and tests work with the placeholder.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "classroom",
  "main": "./dist/_worker.js/index.js",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "binding": "ASSETS",
    "directory": "./dist"
  },
  "observability": { "enabled": true },
  "vars": {
    "DEBUG_ROUTES": "0"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "classroom",
      "database_id": "REPLACE_AFTER_WRANGLER_D1_CREATE",
      "migrations_dir": "migrations"
    }
  ]
}
```

- [ ] **Step 6: Write `tsconfig.json`**

`test/integration` is deliberately excluded — it gets its own tsconfig in Task 7 because Cloudflare's global runtime types conflict with the DOM types Astro needs.

```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "skipLibCheck": true
  },
  "include": [".astro/types.d.ts", "src/**/*", "test/unit/**/*"],
  "exclude": ["dist", "node_modules", "test/integration"]
}
```

- [ ] **Step 7: Write `src/env.d.ts`**

```ts
/// <reference types="astro/client" />

// Minimal declaration so `import { env } from "cloudflare:workers"` typechecks
// without pulling Cloudflare's global runtime types into the DOM-typed project.
// src/lib/config.ts narrows this to the typed AppEnv.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
```

- [ ] **Step 8: Write placeholder `src/pages/index.astro`**

```astro
---
---
<html lang="en">
  <head><meta charset="utf-8" /><title>Classroom</title></head>
  <body>
    <h1>Classroom</h1>
  </body>
</html>
```

- [ ] **Step 9: Write `vitest.unit.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 10: Write `vitest.integration.config.ts`**

```ts
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
```

- [ ] **Step 11: Write `.dev.vars.example`**

```ini
# Copy to .dev.vars (gitignored) and fill in after following docs/github-setup.md.
# `astro dev` and `wrangler dev` read this file for local secrets.
GITHUB_APP_ID=
# PKCS#8 PEM, single line with \n escapes or quoted multiline — see docs/github-setup.md
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
# openssl rand -hex 32
SESSION_SECRET=
# enables GET /debug/github-app locally
DEBUG_ROUTES=1
```

- [ ] **Step 12: Append to `.gitignore`**

Add these lines to the end of the existing `.gitignore`:

```
# astro / cloudflare
dist/
.astro/
.wrangler/
.dev.vars
worker-configuration.d.ts
```

- [ ] **Step 13: Verify build and typecheck**

Run: `yarn build`
Expected: succeeds; `dist/_worker.js/index.js` exists (`ls dist/_worker.js/index.js`).

Run: `tsc --noEmit` (only the root project — the integration tsconfig doesn't exist yet)
Expected: no errors.

If `yarn build` fails on `output: "server"` (Astro 6 may have renamed the option), check `node_modules/astro/dist/types/public/config.d.ts` for the current equivalent and adapt — the requirement is "all pages SSR by default".

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "chore: scaffold Astro 6 + Cloudflare Worker toolchain (yarn node-modules linker, wrangler, vitest)"
```

---

### Task 2: D1 schema migration

**Files:**
- Create: `migrations/0001_init.sql`

This is the **full** build-plan §4 schema plus the `users` table from the design (§3). Phase 0 only touches `users`; the rest exists so later phases migrate forward, not sideways.

- [ ] **Step 1: Write `migrations/0001_init.sql`**

```sql
-- Phase 0: full schema from the build plan §4, plus `users` (design §3).
-- Only `users` is read/written in Phase 0.

CREATE TABLE users (
  id              TEXT PRIMARY KEY,                 -- uuid
  github_id       INTEGER NOT NULL UNIQUE,          -- stable identity (usernames change)
  github_username TEXT NOT NULL,                    -- latest known login
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at   TEXT
);

CREATE TABLE classrooms (
  id            TEXT PRIMARY KEY,            -- uuid
  name          TEXT NOT NULL,
  github_org    TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assignments (
  id            TEXT PRIMARY KEY,            -- uuid
  classroom_id  TEXT NOT NULL REFERENCES classrooms(id),
  slug          TEXT NOT NULL,               -- url-safe, unique per classroom
  title         TEXT NOT NULL,
  template_repo TEXT NOT NULL,               -- "org/template-name"
  deadline_at   TEXT,                        -- UTC ISO8601, nullable = no deadline
  grace_minutes INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open',-- open | closed | building | built
  grader_repo   TEXT,                        -- "org/{slug}-grader" once created
  closed_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (classroom_id, slug)
);

CREATE TABLE students (
  id                 TEXT PRIMARY KEY,        -- uuid
  classroom_id       TEXT NOT NULL REFERENCES classrooms(id),
  roster_identifier  TEXT,                    -- optional friendly id (student #, email)
  github_username    TEXT,                    -- nullable until linked
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (classroom_id, github_username)
);

CREATE TABLE repos (
  id                  TEXT PRIMARY KEY,       -- uuid
  assignment_id       TEXT NOT NULL REFERENCES assignments(id),
  student_id          TEXT NOT NULL REFERENCES students(id),
  repo_name           TEXT NOT NULL,          -- "{slug}-{username}"
  repo_id             INTEGER,                -- GitHub numeric repo id
  accepted_at         TEXT,
  permission_synced_at TEXT,
  UNIQUE (assignment_id, student_id)
);

CREATE TABLE submissions (
  assignment_id   TEXT NOT NULL REFERENCES assignments(id),
  student_id      TEXT NOT NULL REFERENCES students(id),
  last_commit_sha TEXT,
  last_commit_at  TEXT,                       -- UTC ISO8601
  status          TEXT NOT NULL DEFAULT 'missing', -- on_time | late | missing
  evaluated_at    TEXT,
  PRIMARY KEY (assignment_id, student_id)
);
```

- [ ] **Step 2: Apply locally and verify**

Run: `yarn db:migrate:local`
Expected: `1 migration(s) applied`.

Run: `yarn wrangler d1 execute classroom --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"`
Expected output includes: `assignments`, `classrooms`, `repos`, `students`, `submissions`, `users`.

- [ ] **Step 3: Commit**

```bash
git add migrations/
git commit -m "feat: add D1 schema migration (build-plan tables + users)"
```

---

### Task 3: `src/lib/encoding.ts` + `src/lib/github/client.ts`

**Files:**
- Create: `src/lib/encoding.ts`, `src/lib/github/client.ts`
- Test: `test/unit/encoding.test.ts`, `test/unit/client.test.ts`

Unit tests run in plain Node 24: `fetch`, `Response`, `crypto.subtle`, `atob`/`btoa` are all global — no polyfills.

- [ ] **Step 1: Write the failing encoding tests** — `test/unit/encoding.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "../../src/lib/encoding";

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 62, 63, 127]);
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
  });

  it("emits no +, / or = characters", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("round-trips utf-8 JSON text", () => {
    const text = JSON.stringify({ user: "octocat", emoji: "✨" });
    const bytes = new TextEncoder().encode(text);
    expect(new TextDecoder().decode(base64UrlDecode(base64UrlEncode(bytes)))).toBe(text);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn test:unit`
Expected: FAIL — cannot resolve `../../src/lib/encoding`.

- [ ] **Step 3: Implement `src/lib/encoding.ts`**

```ts
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
```

- [ ] **Step 4: Run tests, expect PASS, then write the failing client tests** — `test/unit/client.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { GitHubApiError, githubRequest } from "../../src/lib/github/client";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("githubRequest", () => {
  it("prefixes api.github.com, sends auth + accept + api-version headers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    await githubRequest("/user", { token: "tok-123", fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-123");
    expect(headers.accept).toBe("application/vnd.github+json");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
    expect(headers["user-agent"]).toBe("classroom-worker");
  });

  it("passes absolute URLs through untouched and JSON-encodes the body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await githubRequest("https://github.com/login/oauth/access_token", {
      method: "POST",
      body: { code: "abc" },
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ code: "abc" }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("returns parsed data plus rate-limit info", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ login: "octocat" }, {
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4998",
          "x-ratelimit-reset": "1765500000",
        },
      }),
    );
    const result = await githubRequest<{ login: string }>("/user", { fetchImpl });
    expect(result.data.login).toBe("octocat");
    expect(result.rateLimit).toEqual({
      remaining: 4998,
      reset: 1765500000,
      retryAfterSeconds: null,
    });
  });

  it("throws GitHubApiError carrying status and rate-limit headers on 403", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("rate limited", {
          status: 403,
          headers: { "retry-after": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1765500000" },
        }),
    );
    const error = await githubRequest("/user", { fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error.status).toBe(403);
    expect(error.rateLimit).toEqual({ remaining: 0, reset: 1765500000, retryAfterSeconds: 60 });
  });

  it("returns undefined data on 204", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await githubRequest("/user", { fetchImpl });
    expect(result.status).toBe(204);
    expect(result.data).toBeUndefined();
  });
});
```

- [ ] **Step 5: Run to verify the new tests fail**

Run: `yarn test:unit`
Expected: encoding PASS, client FAIL (module not found).

- [ ] **Step 6: Implement `src/lib/github/client.ts`**

```ts
const GITHUB_API_BASE = "https://api.github.com";

export interface RateLimitInfo {
  remaining: number | null;
  reset: number | null;
  retryAfterSeconds: number | null;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly rateLimit: RateLimitInfo,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubRequestOptions {
  method?: string;
  token?: string;
  body?: unknown;
  accept?: string;
  fetchImpl?: typeof fetch;
}

export interface GitHubResponse<T> {
  data: T;
  status: number;
  rateLimit: RateLimitInfo;
}

function readRateLimit(headers: Headers): RateLimitInfo {
  const int = (name: string): number | null => {
    const value = headers.get(name);
    return value === null ? null : Number.parseInt(value, 10);
  };
  return {
    remaining: int("x-ratelimit-remaining"),
    reset: int("x-ratelimit-reset"),
    retryAfterSeconds: int("retry-after"),
  };
}

export async function githubRequest<T = unknown>(
  path: string,
  options: GitHubRequestOptions = {},
): Promise<GitHubResponse<T>> {
  const url = path.startsWith("https://") ? path : `${GITHUB_API_BASE}${path}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const method = options.method ?? "GET";

  const headers: Record<string, string> = {
    accept: options.accept ?? "application/vnd.github+json",
    "user-agent": "classroom-worker",
    "x-github-api-version": "2022-11-28",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetchImpl(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const rateLimit = readRateLimit(response.headers);
  if (!response.ok) {
    // Body excerpt only; never include auth material in the message.
    const excerpt = (await response.text()).slice(0, 300);
    throw new GitHubApiError(
      `GitHub ${method} ${path} failed with ${response.status}: ${excerpt}`,
      response.status,
      rateLimit,
    );
  }

  const data = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  return { data, status: response.status, rateLimit };
}
```

- [ ] **Step 7: Run tests, expect all PASS**

Run: `yarn test:unit`
Expected: PASS (encoding + client).

- [ ] **Step 8: Commit**

```bash
git add src/lib/encoding.ts src/lib/github/client.ts test/unit/encoding.test.ts test/unit/client.test.ts
git commit -m "feat: base64url helpers and GitHub fetch wrapper with rate-limit surfacing"
```

---

### Task 4: `src/lib/auth/session.ts` — HMAC signing + session payload

**Files:**
- Create: `src/lib/auth/session.ts`
- Test: `test/unit/session.test.ts`

`signValue`/`verifyValue` are the generic HMAC-SHA256 primitive (also reused by OAuth state in Task 5). `signSession`/`verifySession` wrap them with `iat`/`exp` handling.

- [ ] **Step 1: Write the failing tests** — `test/unit/session.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  signSession,
  signValue,
  verifySession,
  verifyValue,
} from "../../src/lib/auth/session";

const SECRET = "unit-test-secret";
const NOW = 1_765_000_000; // fixed epoch seconds

describe("signValue / verifyValue", () => {
  it("round-trips a payload", async () => {
    const signed = await signValue({ hello: "world" }, SECRET);
    expect(await verifyValue(signed, SECRET)).toEqual({ hello: "world" });
  });

  it("rejects a tampered body", async () => {
    const signed = await signValue({ role: "student" }, SECRET);
    const [body, sig] = signed.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ role: "teacher" }))
      .toString("base64url");
    expect(await verifyValue(`${forgedBody}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a signature from a different secret", async () => {
    const signed = await signValue({ a: 1 }, "other-secret");
    expect(await verifyValue(signed, SECRET)).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    for (const garbage of ["", "no-dot", "a.b.c.d", "!!!.???"]) {
      expect(await verifyValue(garbage, SECRET)).toBeNull();
    }
  });
});

describe("signSession / verifySession", () => {
  it("round-trips and stamps iat/exp", async () => {
    const cookie = await signSession({ userId: "u1", githubUsername: "octocat" }, SECRET, NOW);
    const payload = await verifySession(cookie, SECRET, NOW);
    expect(payload).toEqual({
      userId: "u1",
      githubUsername: "octocat",
      iat: NOW,
      exp: NOW + SESSION_TTL_SECONDS,
    });
  });

  it("rejects an expired session", async () => {
    const cookie = await signSession({ userId: "u1", githubUsername: "octocat" }, SECRET, NOW);
    expect(await verifySession(cookie, SECRET, NOW + SESSION_TTL_SECONDS + 1)).toBeNull();
  });

  it("rejects tampering", async () => {
    const cookie = await signSession({ userId: "u1", githubUsername: "octocat" }, SECRET, NOW);
    expect(await verifySession(cookie + "x", SECRET, NOW)).toBeNull();
  });

  it("exports the cookie name used by endpoints", () => {
    expect(SESSION_COOKIE_NAME).toBe("session");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn test:unit`
Expected: FAIL — cannot resolve `../../src/lib/auth/session`.

- [ ] **Step 3: Implement `src/lib/auth/session.ts`**

```ts
import { base64UrlDecode, base64UrlEncode } from "../encoding";

export const SESSION_COOKIE_NAME = "session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  userId: string;
  githubUsername: string;
  iat: number; // epoch seconds
  exp: number; // epoch seconds
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** Generic HMAC-SHA256-signed value: `base64url(json).base64url(mac)`. */
export async function signValue(payload: unknown, secret: string): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret, "sign");
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(mac))}`;
}

/** Returns the payload, or null for anything invalid. Never throws. */
export async function verifyValue<T>(value: string, secret: string): Promise<T | null> {
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;
  let sigBytes: Uint8Array;
  let bodyBytes: Uint8Array;
  try {
    sigBytes = base64UrlDecode(sig);
    bodyBytes = base64UrlDecode(body);
  } catch {
    return null;
  }
  const key = await hmacKey(secret, "verify");
  // crypto.subtle.verify is constant-time; never compare MACs with ===.
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(body));
  if (!valid) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bodyBytes)) as T;
  } catch {
    return null;
  }
}

export async function signSession(
  data: { userId: string; githubUsername: string },
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: SessionPayload = {
    ...data,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
  };
  return signValue(payload, secret);
}

export async function verifySession(
  value: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SessionPayload | null> {
  const payload = await verifyValue<SessionPayload>(value, secret);
  if (!payload || typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
  if (typeof payload.userId !== "string" || typeof payload.githubUsername !== "string") return null;
  return payload;
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/session.ts test/unit/session.test.ts
git commit -m "feat: stateless HMAC-signed session cookie primitives"
```

---

### Task 5: `src/lib/auth/oauth.ts` — authorize URL, state, code exchange, user fetch

**Files:**
- Create: `src/lib/auth/oauth.ts`
- Test: `test/unit/oauth.test.ts`

- [ ] **Step 1: Write the failing tests** — `test/unit/oauth.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import {
  STATE_COOKIE_NAME,
  STATE_TTL_SECONDS,
  buildAuthorizeUrl,
  createState,
  exchangeCode,
  fetchAuthenticatedUser,
  verifyState,
} from "../../src/lib/auth/oauth";

const SECRET = "unit-test-secret";
const NOW = 1_765_000_000;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("authorize URL", () => {
  it("targets github.com/login/oauth/authorize with client_id and state", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "cid-1", state: "the-state" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid-1");
    expect(url.searchParams.get("state")).toBe("the-state");
  });
});

describe("state", () => {
  it("verifies a fresh state", async () => {
    const state = await createState(SECRET, NOW);
    expect(await verifyState(state, SECRET, NOW)).toBe(true);
  });

  it("rejects an expired state", async () => {
    const state = await createState(SECRET, NOW);
    expect(await verifyState(state, SECRET, NOW + STATE_TTL_SECONDS + 1)).toBe(false);
  });

  it("rejects a tampered state", async () => {
    const state = await createState(SECRET, NOW);
    expect(await verifyState(state.slice(0, -2), SECRET, NOW)).toBe(false);
  });

  it("rejects a session cookie passed off as state (type confusion)", async () => {
    const { signSession } = await import("../../src/lib/auth/session");
    const sessionValue = await signSession({ userId: "u1", githubUsername: "x" }, SECRET, NOW);
    expect(await verifyState(sessionValue, SECRET, NOW)).toBe(false);
  });

  it("exports the state cookie name", () => {
    expect(STATE_COOKIE_NAME).toBe("oauth_state");
  });
});

describe("exchangeCode", () => {
  it("POSTs code + client credentials and returns the access token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "gho_abc" }));
    const token = await exchangeCode({
      code: "the-code",
      clientId: "cid-1",
      clientSecret: "csec-1",
      fetchImpl,
    });
    expect(token).toBe("gho_abc");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "cid-1",
      client_secret: "csec-1",
      code: "the-code",
    });
    expect((init.headers as Record<string, string>).accept).toBe("application/json");
  });

  it("fails closed when GitHub returns an error body with status 200", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "bad_verification_code", error_description: "expired" }),
    );
    await expect(
      exchangeCode({ code: "x", clientId: "c", clientSecret: "s", fetchImpl }),
    ).rejects.toThrow(/bad_verification_code/);
  });

  it("fails closed when access_token is missing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await expect(
      exchangeCode({ code: "x", clientId: "c", clientSecret: "s", fetchImpl }),
    ).rejects.toThrow(/no access_token/);
  });
});

describe("fetchAuthenticatedUser", () => {
  it("GETs /user with the bearer token and maps id/login", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 583231, login: "octocat" }));
    const user = await fetchAuthenticatedUser("gho_abc", fetchImpl);
    expect(user).toEqual({ githubId: 583231, login: "octocat" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer gho_abc");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn test:unit`
Expected: FAIL — cannot resolve `../../src/lib/auth/oauth`.

- [ ] **Step 3: Implement `src/lib/auth/oauth.ts`**

No `scope` parameter on the authorize URL: the default (no scope) grants read access to the public profile, which is all Phase 0 needs (`id`, `login`).

```ts
import { githubRequest } from "../github/client";
import { signValue, verifyValue } from "./session";

export const STATE_COOKIE_NAME = "oauth_state";
export const STATE_TTL_SECONDS = 600; // 10 minutes

interface StatePayload {
  t: "oauth-state"; // type tag: a signed session can never pass as a state
  nonce: string;
  exp: number; // epoch seconds
}

export function buildAuthorizeUrl(options: { clientId: string; state: string }): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("state", options.state);
  return url.toString();
}

export async function createState(
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: StatePayload = {
    t: "oauth-state",
    nonce: crypto.randomUUID(),
    exp: nowSeconds + STATE_TTL_SECONDS,
  };
  return signValue(payload, secret);
}

export async function verifyState(
  state: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const payload = await verifyValue<StatePayload>(state, secret);
  return payload !== null && payload.t === "oauth-state" && payload.exp > nowSeconds;
}

export async function exchangeCode(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { data } = await githubRequest<{
    access_token?: string;
    error?: string;
    error_description?: string;
  }>("https://github.com/login/oauth/access_token", {
    method: "POST",
    accept: "application/json",
    body: {
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
    },
    fetchImpl: options.fetchImpl,
  });

  // GitHub returns 200 with an error body on failure — fail closed.
  if (data.error) {
    throw new Error(
      `OAuth code exchange failed: ${data.error}${data.error_description ? ` (${data.error_description})` : ""}`,
    );
  }
  if (!data.access_token) {
    throw new Error("OAuth code exchange failed: no access_token in response");
  }
  return data.access_token;
}

export async function fetchAuthenticatedUser(
  token: string,
  fetchImpl?: typeof fetch,
): Promise<{ githubId: number; login: string }> {
  const { data } = await githubRequest<{ id: number; login: string }>("/user", {
    token,
    fetchImpl,
  });
  return { githubId: data.id, login: data.login };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `yarn test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/oauth.ts test/unit/oauth.test.ts
git commit -m "feat: GitHub OAuth helpers (authorize URL, signed state, code exchange, user fetch)"
```

---

### Task 6: `src/lib/github/app.ts` — RS256 app JWT, installation token, cache

**Files:**
- Create: `src/lib/github/app.ts`
- Test: `test/unit/app.test.ts`

**Domain background for the tests:** a GitHub App authenticates by signing a short-lived JWT with its RSA private key (`iss` = app id), then POSTs it to `/app/installations/{id}/access_tokens` to receive an installation token (`ghs_…`, expires in ~1 hour). GitHub serves private keys in PKCS#1 format (`BEGIN RSA PRIVATE KEY`), but WebCrypto only imports PKCS#8 (`BEGIN PRIVATE KEY`) — the operator converts once with openssl (setup guide, Task 10); the importer must detect PKCS#1 and fail with a message that says exactly how to convert.

- [ ] **Step 1: Write the failing tests** — `test/unit/app.test.ts`

The tests generate a real RSA keypair, sign a JWT with the private key, and verify the signature with the public key — no GitHub involved.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlDecode } from "../../src/lib/encoding";
import {
  buildAppJwt,
  clearInstallationTokenCache,
  getInstallationToken,
  mintInstallationToken,
} from "../../src/lib/github/app";

const NOW = 1_765_000_000;

async function generateTestKeyPair(): Promise<{ privateKeyPem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = Buffer.from(pkcs8).toString("base64");
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return {
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
}

describe("buildAppJwt", () => {
  it("produces an RS256 JWT with iss/iat/exp that verifies against the public key", async () => {
    const { privateKeyPem, publicKey } = await generateTestKeyPair();
    const jwt = await buildAppJwt({ appId: "12345", privateKey: privateKeyPem, nowSeconds: NOW });

    const [header, claims, signature] = jwt.split(".");
    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(claims)).toEqual({ iss: "12345", iat: NOW - 60, exp: NOW + 540 });

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64UrlDecode(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it("rejects a PKCS#1 key with a conversion hint", async () => {
    const pkcs1 = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----";
    await expect(buildAppJwt({ appId: "1", privateKey: pkcs1, nowSeconds: NOW })).rejects.toThrow(
      /pkcs8/i,
    );
  });
});

describe("mintInstallationToken", () => {
  it("exchanges the JWT at the installation access_tokens endpoint", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "ghs_minted", expires_at: "2026-06-12T01:00:00Z" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await mintInstallationToken({
      appId: "12345",
      privateKey: privateKeyPem,
      installationId: "67890",
      fetchImpl,
      nowSeconds: NOW,
    });
    expect(result).toEqual({ token: "ghs_minted", expiresAt: "2026-06-12T01:00:00Z" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/67890/access_tokens");
    expect(init.method).toBe("POST");
    const auth = (init.headers as Record<string, string>).authorization;
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/); // Bearer <jwt>
  });

  it("throws on a non-2xx response without leaking the JWT", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const fetchImpl = vi.fn(async () => new Response("Integration not found", { status: 404 }));
    const error = await mintInstallationToken({
      appId: "12345",
      privateKey: privateKeyPem,
      installationId: "67890",
      fetchImpl,
      nowSeconds: NOW,
    }).catch((e) => e);
    expect(error.message).toMatch(/404/);
    expect(error.message).not.toMatch(/Bearer/);
  });
});

describe("getInstallationToken cache", () => {
  beforeEach(() => clearInstallationTokenCache());

  function mintingFetch(token: string, expiresAt: string) {
    return vi.fn(
      async () =>
        new Response(JSON.stringify({ token, expires_at: expiresAt }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
  }

  it("reuses the cached token before expiry", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    // expires 1 hour after NOW
    const expiresAt = new Date((NOW + 3600) * 1000).toISOString();
    const fetchImpl = mintingFetch("ghs_one", expiresAt);
    const base = { appId: "1", privateKey: privateKeyPem, installationId: "2", fetchImpl };

    expect(await getInstallationToken({ ...base, nowSeconds: NOW })).toBe("ghs_one");
    expect(await getInstallationToken({ ...base, nowSeconds: NOW + 1800 })).toBe("ghs_one");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-mints within 60s of expiry", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const expiresAt = new Date((NOW + 3600) * 1000).toISOString();
    const fetchImpl = mintingFetch("ghs_two", expiresAt);
    const base = { appId: "1", privateKey: privateKeyPem, installationId: "2", fetchImpl };

    await getInstallationToken({ ...base, nowSeconds: NOW });
    await getInstallationToken({ ...base, nowSeconds: NOW + 3600 - 30 }); // inside the 60s buffer
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not serve a token cached for a different app/installation", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const expiresAt = new Date((NOW + 3600) * 1000).toISOString();
    const fetchImpl = mintingFetch("ghs_three", expiresAt);

    await getInstallationToken({ appId: "1", privateKey: privateKeyPem, installationId: "2", fetchImpl, nowSeconds: NOW });
    await getInstallationToken({ appId: "1", privateKey: privateKeyPem, installationId: "999", fetchImpl, nowSeconds: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn test:unit`
Expected: FAIL — cannot resolve `../../src/lib/github/app`.

- [ ] **Step 3: Implement `src/lib/github/app.ts`**

```ts
import { base64UrlEncode } from "../encoding";
import { githubRequest } from "./client";

export interface AppAuthOptions {
  appId: string;
  privateKey: string; // PKCS#8 PEM
  installationId: string;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
}

export interface InstallationToken {
  token: string;
  expiresAt: string; // ISO8601 from GitHub
}

async function importRs256PrivateKey(pem: string): Promise<CryptoKey> {
  if (pem.includes("RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is in PKCS#1 format (as downloaded from GitHub) but WebCrypto requires PKCS#8. " +
        "Convert it once with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.private-key.pem -out app.private-key.pkcs8.pem",
    );
  }
  const body = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  let der: Uint8Array;
  try {
    const binary = atob(body);
    der = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not valid PEM (base64 decode failed)");
  }
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function buildAppJwt(options: {
  appId: string;
  privateKey: string;
  nowSeconds?: number;
}): Promise<string> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  // iat backdated 60s for clock drift; exp <= 10 minutes per GitHub's limit.
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: options.appId,
    iat: now - 60,
    exp: now + 540,
  })}`;
  const key = await importRs256PrivateKey(options.privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function mintInstallationToken(options: AppAuthOptions): Promise<InstallationToken> {
  const jwt = await buildAppJwt(options);
  const { data } = await githubRequest<{ token: string; expires_at: string }>(
    `/app/installations/${options.installationId}/access_tokens`,
    { method: "POST", token: jwt, fetchImpl: options.fetchImpl },
  );
  return { token: data.token, expiresAt: data.expires_at };
}

// Module-scope cache: survives across requests within a Worker isolate,
// which is exactly the lifetime we want (spec defers KV caching).
let cachedToken: { key: string; token: string; expiresAtMs: number } | null = null;
const EXPIRY_BUFFER_MS = 60_000;

export async function getInstallationToken(options: AppAuthOptions): Promise<string> {
  const key = `${options.appId}:${options.installationId}`;
  const nowMs = (options.nowSeconds ?? Math.floor(Date.now() / 1000)) * 1000;
  if (cachedToken && cachedToken.key === key && nowMs < cachedToken.expiresAtMs - EXPIRY_BUFFER_MS) {
    return cachedToken.token;
  }
  const minted = await mintInstallationToken(options);
  cachedToken = { key, token: minted.token, expiresAtMs: Date.parse(minted.expiresAt) };
  return minted.token;
}

export function clearInstallationTokenCache(): void {
  cachedToken = null;
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `yarn test:unit`
Expected: PASS (all unit suites).

- [ ] **Step 5: Commit**

```bash
git add src/lib/github/app.ts test/unit/app.test.ts
git commit -m "feat: GitHub App RS256 JWT signing and cached installation-token minting"
```

---

### Task 7: Integration harness + `src/lib/db/users.ts`

**Files:**
- Create: `test/integration/tsconfig.json`, `test/integration/env.d.ts`, `test/integration/apply-migrations.ts`, `src/lib/db/users.ts`
- Test: `test/integration/users.test.ts`

The workers pool runs tests inside real `workerd`. Cloudflare's global runtime types clash with the DOM types Astro needs, so the integration directory gets its own standalone tsconfig (this is the layout the official vitest-pool-workers templates use).

- [ ] **Step 1: Write `test/integration/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "types": ["@cloudflare/workers-types/experimental", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["./**/*", "../../src/lib/**/*"]
}
```

- [ ] **Step 2: Write `test/integration/env.d.ts`**

```ts
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    SESSION_SECRET: string;
    GITHUB_OAUTH_CLIENT_ID: string;
    GITHUB_OAUTH_CLIENT_SECRET: string;
    GITHUB_APP_ID: string;
    GITHUB_APP_PRIVATE_KEY: string;
    GITHUB_APP_INSTALLATION_ID: string;
  }
}
```

- [ ] **Step 3: Write `test/integration/apply-migrations.ts`**

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 4: Write the failing tests** — `test/integration/users.test.ts`

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { findUserById, upsertUser } from "../../src/lib/db/users";

describe("users repository", () => {
  it("inserts a new user with a uuid and last_login_at", async () => {
    const user = await upsertUser(env.DB, { githubId: 583231, githubUsername: "octocat" });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.githubId).toBe(583231);
    expect(user.githubUsername).toBe("octocat");
    expect(user.createdAt).toBeTruthy();
    expect(user.lastLoginAt).toBeTruthy();
  });

  it("updates username and last_login_at on conflict by github_id, keeping the same row", async () => {
    const first = await upsertUser(env.DB, { githubId: 583231, githubUsername: "octocat" });
    const second = await upsertUser(env.DB, { githubId: 583231, githubUsername: "octocat-renamed" });

    expect(second.id).toBe(first.id);
    expect(second.githubUsername).toBe("octocat-renamed");
    expect(second.createdAt).toBe(first.createdAt);

    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });

  it("findUserById returns the user or null", async () => {
    const user = await upsertUser(env.DB, { githubId: 1, githubUsername: "someone" });
    expect(await findUserById(env.DB, user.id)).toEqual(user);
    expect(await findUserById(env.DB, "missing-id")).toBeNull();
  });
});
```

- [ ] **Step 5: Run to verify failure**

Run: `yarn test:integration`
Expected: `yarn build` succeeds, then vitest FAILS — cannot resolve `../../src/lib/db/users`.

If the run fails **before** the test executes with an error about the `assets` config or about loading `dist/_worker.js/index.js`, see the contingency note at the top of Task 8 — fix that first, it affects this task's runner too.

- [ ] **Step 6: Implement `src/lib/db/users.ts`**

```ts
import type { D1Database } from "@cloudflare/workers-types";

export interface User {
  id: string;
  githubId: number;
  githubUsername: string;
  createdAt: string;
  lastLoginAt: string | null;
}

interface UserRow {
  id: string;
  github_id: number;
  github_username: string;
  created_at: string;
  last_login_at: string | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    githubId: row.github_id,
    githubUsername: row.github_username,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export async function upsertUser(
  db: D1Database,
  input: { githubId: number; githubUsername: string },
): Promise<User> {
  const row = await db
    .prepare(
      `INSERT INTO users (id, github_id, github_username, last_login_at)
       VALUES (?1, ?2, ?3, datetime('now'))
       ON CONFLICT (github_id) DO UPDATE SET
         github_username = excluded.github_username,
         last_login_at = datetime('now')
       RETURNING *`,
    )
    .bind(crypto.randomUUID(), input.githubId, input.githubUsername)
    .first<UserRow>();
  if (!row) throw new Error("upsertUser: INSERT ... RETURNING produced no row");
  return toUser(row);
}

export async function findUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE id = ?1").bind(id).first<UserRow>();
  return row ? toUser(row) : null;
}
```

- [ ] **Step 7: Run tests, expect PASS**

Run: `yarn test:integration`
Expected: PASS.

Run: `yarn typecheck`
Expected: both projects pass.

- [ ] **Step 8: Commit**

```bash
git add test/integration/ src/lib/db/users.ts
git commit -m "feat: users D1 repository + vitest-pool-workers integration harness"
```

---

### Task 8: `src/lib/config.ts` + OAuth endpoints, integration-tested through the built worker

**Files:**
- Create: `src/lib/config.ts`, `src/pages/auth/login.ts`, `src/pages/auth/callback.ts`
- Test: `test/integration/auth-endpoints.test.ts`

These tests `SELF.fetch` the **built Astro worker** (`wrangler.jsonc` `main`) inside workerd, with GitHub mocked at the outbound-fetch boundary via `fetchMock` from `cloudflare:test`. `yarn test:integration` rebuilds first, so endpoint code changes are picked up.

> **Contingency (known risk):** running Astro's built worker under vitest-pool-workers depends on the pool supporting the `assets` config from `wrangler.jsonc`. If the pool errors on it, set `poolOptions.workers.miniflare.assets = { directory: "./dist", binding: "ASSETS" }` in `vitest.integration.config.ts` (and if it *still* fails, remove the `assets` key from a test-only copy of the wrangler config passed via `wrangler.configPath` — the SSR routes under test never touch static assets). Do not silently drop the endpoint tests.

- [ ] **Step 1: Write the failing tests** — `test/integration/auth-endpoints.test.ts`

```ts
import { SELF, env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createState } from "../../src/lib/auth/oauth";
import { verifySession } from "../../src/lib/auth/session";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function setCookies(response: Response): string {
  return response.headers.getSetCookie().join("; ");
}

describe("GET /auth/login", () => {
  it("redirects to GitHub with a signed state and sets the state cookie", async () => {
    const response = await SELF.fetch("https://example.com/auth/login", { redirect: "manual" });
    expect(response.status).toBe(302);

    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");

    const state = location.searchParams.get("state")!;
    expect(state).toBeTruthy();
    expect(setCookies(response)).toContain(`oauth_state=${state}`);
  });
});

describe("GET /auth/callback", () => {
  function mockGitHubLogin(user: { id: number; login: string }) {
    fetchMock
      .get("https://github.com")
      .intercept({ method: "POST", path: "/login/oauth/access_token" })
      .reply(200, { access_token: "gho_test" }, { headers: { "content-type": "application/json" } });
    fetchMock
      .get("https://api.github.com")
      .intercept({ path: "/user" })
      .reply(200, user, { headers: { "content-type": "application/json" } });
  }

  it("happy path: upserts the user, sets a session cookie, redirects to /", async () => {
    mockGitHubLogin({ id: 583231, login: "octocat" });
    const state = await createState(env.SESSION_SECRET);

    const response = await SELF.fetch(
      `https://example.com/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `oauth_state=${state}` } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");

    const sessionCookie = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("session="))!;
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(sessionCookie).toContain("Path=/");

    const value = sessionCookie.split(";")[0].slice("session=".length);
    const payload = await verifySession(decodeURIComponent(value), env.SESSION_SECRET);
    expect(payload?.githubUsername).toBe("octocat");

    const row = await env.DB.prepare("SELECT * FROM users WHERE github_id = 583231").first<{
      github_username: string;
      id: string;
    }>();
    expect(row?.github_username).toBe("octocat");
    expect(payload?.userId).toBe(row?.id);
  });

  it("rejects a state that does not match the cookie", async () => {
    const state = await createState(env.SESSION_SECRET);
    const otherState = await createState(env.SESSION_SECRET);

    const response = await SELF.fetch(
      `https://example.com/auth/callback?code=c&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `oauth_state=${otherState}` } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?error=invalid_state");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("rejects a tampered state even when the cookie matches", async () => {
    const state = (await createState(env.SESSION_SECRET)).slice(0, -2);
    const response = await SELF.fetch(
      `https://example.com/auth/callback?code=c&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `oauth_state=${state}` } },
    );
    expect(response.headers.get("location")).toBe("/?error=invalid_state");
  });

  it("surfaces GitHub error params as a logged-out redirect", async () => {
    const response = await SELF.fetch(
      "https://example.com/auth/callback?error=access_denied&error_description=denied",
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?error=access_denied");
  });

  it("fails closed when the token exchange fails", async () => {
    fetchMock
      .get("https://github.com")
      .intercept({ method: "POST", path: "/login/oauth/access_token" })
      .reply(200, { error: "bad_verification_code" }, { headers: { "content-type": "application/json" } });
    const state = await createState(env.SESSION_SECRET);

    const response = await SELF.fetch(
      `https://example.com/auth/callback?code=bad&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `oauth_state=${state}` } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?error=oauth_failed");
    expect(response.headers.getSetCookie().some((c) => c.startsWith("session="))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn test:integration`
Expected: users tests PASS; auth-endpoints tests FAIL (404s — the routes don't exist in the built worker yet).

- [ ] **Step 3: Implement `src/lib/config.ts`**

```ts
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
```

- [ ] **Step 4: Implement `src/pages/auth/login.ts`**

```ts
import type { APIRoute } from "astro";
import { getEnv } from "../../lib/config";
import { STATE_COOKIE_NAME, STATE_TTL_SECONDS, buildAuthorizeUrl, createState } from "../../lib/auth/oauth";

export const GET: APIRoute = async ({ cookies, redirect }) => {
  const env = getEnv();
  const state = await createState(env.SESSION_SECRET);
  cookies.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return redirect(buildAuthorizeUrl({ clientId: env.GITHUB_OAUTH_CLIENT_ID, state }), 302);
};
```

- [ ] **Step 5: Implement `src/pages/auth/callback.ts`**

```ts
import type { APIRoute } from "astro";
import { getEnv } from "../../lib/config";
import { STATE_COOKIE_NAME, exchangeCode, fetchAuthenticatedUser, verifyState } from "../../lib/auth/oauth";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS, signSession } from "../../lib/auth/session";
import { upsertUser } from "../../lib/db/users";

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const env = getEnv();
  const params = url.searchParams;

  // GitHub sent the user back with an error (e.g. access_denied).
  const githubError = params.get("error");
  if (githubError) {
    return redirect(`/?error=${encodeURIComponent(githubError)}`, 302);
  }

  const code = params.get("code");
  const state = params.get("state");
  const stateCookie = cookies.get(STATE_COOKIE_NAME)?.value;
  cookies.delete(STATE_COOKIE_NAME, { path: "/" });

  // CSRF guard: the state must be validly signed AND match the cookie set at /auth/login.
  if (
    !code ||
    !state ||
    !stateCookie ||
    state !== stateCookie ||
    !(await verifyState(state, env.SESSION_SECRET))
  ) {
    return redirect("/?error=invalid_state", 302);
  }

  try {
    const accessToken = await exchangeCode({
      code,
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
    });
    const githubUser = await fetchAuthenticatedUser(accessToken);
    const user = await upsertUser(env.DB, {
      githubId: githubUser.githubId,
      githubUsername: githubUser.login,
    });

    const session = await signSession(
      { userId: user.id, githubUsername: user.githubUsername },
      env.SESSION_SECRET,
    );
    cookies.set(SESSION_COOKIE_NAME, session, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return redirect("/", 302);
  } catch (error) {
    // Message only — GitHubApiError messages never contain tokens (client.ts).
    console.error("oauth callback failed:", error instanceof Error ? error.message : String(error));
    return redirect("/?error=oauth_failed", 302);
  }
};
```

- [ ] **Step 6: Run tests, expect PASS**

Run: `yarn test:integration`
Expected: PASS (users + auth-endpoints).

Run: `yarn typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/config.ts src/pages/auth/ test/integration/auth-endpoints.test.ts
git commit -m "feat: GitHub OAuth login + callback endpoints with CSRF-bound state"
```

---

### Task 9: Landing page + flag-gated GitHub App smoke route

**Files:**
- Modify: `src/pages/index.astro` (replace the Task 1 placeholder)
- Create: `src/pages/debug/github-app.ts`
- Test: `test/integration/index-page.test.ts`

- [ ] **Step 1: Write the failing tests** — `test/integration/index-page.test.ts`

```ts
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signSession } from "../../src/lib/auth/session";

describe("GET /", () => {
  it("shows a login link when logged out", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/auth/login"');
    expect(html).not.toContain("Logged in as");
  });

  it("shows the username with a valid session cookie", async () => {
    const cookie = await signSession({ userId: "u1", githubUsername: "octocat" }, env.SESSION_SECRET);
    const response = await SELF.fetch("https://example.com/", {
      headers: { cookie: `session=${cookie}` },
    });
    const html = await response.text();
    expect(html).toContain("Logged in as");
    expect(html).toContain("octocat");
  });

  it("treats a tampered session as logged out (no 500)", async () => {
    const cookie = await signSession({ userId: "u1", githubUsername: "octocat" }, env.SESSION_SECRET);
    const response = await SELF.fetch("https://example.com/", {
      headers: { cookie: `session=${cookie}tampered` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('href="/auth/login"');
  });

  it("renders the error hint from the query string", async () => {
    const response = await SELF.fetch("https://example.com/?error=invalid_state");
    expect(await response.text()).toContain("invalid_state");
  });
});

describe("GET /debug/github-app", () => {
  it("is 404 when DEBUG_ROUTES is not enabled", async () => {
    // vitest.integration.config.ts does not override DEBUG_ROUTES; wrangler.jsonc vars set "0".
    const response = await SELF.fetch("https://example.com/debug/github-app");
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn test:integration`
Expected: index-page tests FAIL (placeholder page has no login link; debug route 404s for the *wrong* reason — route missing — which incidentally passes that one test; the page tests must fail).

- [ ] **Step 3: Replace `src/pages/index.astro`**

```astro
---
import { getEnv } from "../lib/config";
import { SESSION_COOKIE_NAME, verifySession } from "../lib/auth/session";

const env = getEnv();
const cookie = Astro.cookies.get(SESSION_COOKIE_NAME)?.value;
const session = cookie ? await verifySession(cookie, env.SESSION_SECRET) : null;
const error = Astro.url.searchParams.get("error");
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Classroom</title>
  </head>
  <body>
    <h1>Classroom</h1>
    {error && <p role="alert">Login failed: <code>{error}</code></p>}
    {
      session ? (
        <p>Logged in as <strong>{session.githubUsername}</strong></p>
      ) : (
        <p><a href="/auth/login">Log in with GitHub</a></p>
      )
    }
  </body>
</html>
```

- [ ] **Step 4: Implement `src/pages/debug/github-app.ts`**

The live smoke endpoint (design §6): mints an installation token and lists installation repositories — reachable with only Metadata: read. Returns counts and expiry, never the token.

```ts
import type { APIRoute } from "astro";
import { getEnv } from "../../lib/config";
import { getInstallationToken } from "../../lib/github/app";
import { GitHubApiError, githubRequest } from "../../lib/github/client";

export const GET: APIRoute = async () => {
  const env = getEnv();
  if (env.DEBUG_ROUTES !== "1") {
    return new Response("Not found", { status: 404 });
  }

  try {
    const token = await getInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });
    const { data, rateLimit } = await githubRequest<{ total_count: number }>(
      "/installation/repositories",
      { token },
    );
    return Response.json({
      ok: true,
      installationRepoCount: data.total_count,
      rateLimitRemaining: rateLimit.remaining,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof GitHubApiError ? 502 : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
};
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `yarn test:integration`
Expected: PASS (all integration suites).

Run: `yarn typecheck && yarn test:unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pages/index.astro src/pages/debug/ test/integration/index-page.test.ts
git commit -m "feat: landing page with session rendering + flag-gated GitHub App smoke route"
```

---

### Task 10: GitHub setup guide (operator deliverable)

**Files:**
- Create: `docs/github-setup.md`

This is a documentation task — no tests. The guide must be followable by an operator who has a GitHub account but **no** GitHub App, OAuth app, or org yet (design §2, §9).

- [ ] **Step 1: Write `docs/github-setup.md`**

````markdown
# GitHub Setup Guide (Phase 0)

Follow this once, in order. At the end you will have every secret the Worker needs,
local dev working, and the live smoke test passing.

## 0. Prerequisites

- A GitHub account, and a **test organization** (create one free at
  <https://github.com/account/organizations/new> — choose the free plan). The GitHub App
  is installed on this org; later phases create student repos in it.
- `wrangler` authenticated: `yarn wrangler login`.
- `openssl` (preinstalled in the devcontainer).

## 1. Create the GitHub App (org-level actions)

1. Go to your org's settings → **Developer settings → GitHub Apps → New GitHub App**
   (`https://github.com/organizations/<YOUR_ORG>/settings/apps/new`).
2. Fill in:
   - **GitHub App name:** anything unique, e.g. `classroom-<yourname>`.
   - **Homepage URL:** `http://localhost:4321` (placeholder; update when deployed).
   - **Webhook:** uncheck **Active** (this project polls; no webhooks).
3. **Repository permissions** (the full set for later phases; only Metadata is exercised in Phase 0):
   - Administration: **Read and write**
   - Contents: **Read and write**
   - Metadata: **Read-only** (forced on automatically)
   - **Organization permissions** → Members: **Read and write**
4. **Where can this GitHub App be installed?** → *Only on this account*.
5. Click **Create GitHub App**. On the app page, note the **App ID** → this is `GITHUB_APP_ID`.

## 2. Private key (and the PKCS#8 conversion — do not skip)

1. On the app page, scroll to **Private keys** → **Generate a private key**.
   A `.pem` file downloads. It is in **PKCS#1** format (`-----BEGIN RSA PRIVATE KEY-----`),
   which WebCrypto on Workers cannot import.
2. Convert it:

   ```bash
   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
     -in <downloaded>.private-key.pem -out github-app.pkcs8.pem
   ```

3. Verify the converted file starts with `-----BEGIN PRIVATE KEY-----` (no "RSA").
   The converted file's **contents** are `GITHUB_APP_PRIVATE_KEY`.
4. Delete both files once the secret is stored (step 5).

## 3. Install the App and capture the installation id

1. App page → **Install App** (left sidebar) → install on your test org → **All repositories**.
2. After installing, the browser URL is
   `https://github.com/organizations/<ORG>/settings/installations/<NUMBER>`.
   That `<NUMBER>` is `GITHUB_APP_INSTALLATION_ID`.

## 4. Create the OAuth app (user login)

> Separate from the GitHub App. Create one for local dev now; repeat with the deployed
> URL when you deploy (GitHub OAuth apps have a single callback URL).

1. Org settings → **Developer settings → OAuth Apps → New OAuth App**.
2. Fill in:
   - **Application name:** `classroom-dev`
   - **Homepage URL:** `http://localhost:4321`
   - **Authorization callback URL:** `http://localhost:4321/auth/callback`
3. Create, then note the **Client ID** → `GITHUB_OAUTH_CLIENT_ID`.
4. **Generate a new client secret** → `GITHUB_OAUTH_CLIENT_SECRET` (shown once).

## 5. Configure secrets

### Local (`.dev.vars`)

```bash
cp .dev.vars.example .dev.vars
python3 - <<'EOF'  # flattens the PEM into a single line with \n escapes
key = open("github-app.pkcs8.pem").read()
print("GITHUB_APP_PRIVATE_KEY=\"" + key.replace("\n", "\\n") + "\"")
EOF
```

Paste the printed line into `.dev.vars` and fill in the rest. Generate the session secret:

```bash
openssl rand -hex 32   # → SESSION_SECRET
```

`.dev.vars` is gitignored. Never commit it.

### Deployed (Cloudflare)

```bash
yarn wrangler secret put GITHUB_APP_ID
yarn wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste the PKCS#8 PEM as-is (multiline OK)
yarn wrangler secret put GITHUB_APP_INSTALLATION_ID
yarn wrangler secret put GITHUB_OAUTH_CLIENT_ID
yarn wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
yarn wrangler secret put SESSION_SECRET
```

## 6. Create the D1 database

```bash
yarn wrangler d1 create classroom
```

Copy the printed `database_id` into `wrangler.jsonc` (replacing
`REPLACE_AFTER_WRANGLER_D1_CREATE`), then apply the schema:

```bash
yarn db:migrate:local    # local dev database
yarn db:migrate:remote   # the real D1 database
```

## 7. Live smoke test (Phase 0 exit gate)

```bash
yarn dev   # http://localhost:4321
```

1. **OAuth:** open <http://localhost:4321>, click **Log in with GitHub**, authorize.
   You should land back on `/` and see *Logged in as <your-username>*. Verify the row:

   ```bash
   yarn wrangler d1 execute classroom --local \
     --command "SELECT github_id, github_username, last_login_at FROM users"
   ```

2. **GitHub App:** open <http://localhost:4321/debug/github-app>
   (enabled by `DEBUG_ROUTES=1` in `.dev.vars`). Expect
   `{"ok":true,"installationRepoCount":<n>,...}`. If it reports a PKCS#1 error,
   redo section 2.

## 8. Deploy (optional in Phase 0)

```bash
yarn deploy
```

Then create a production OAuth app (section 4) with the deployed URL
(`https://classroom.<your-subdomain>.workers.dev`) as homepage and
`https://…/auth/callback` as the callback, and update the
`GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET` secrets to its values.
`DEBUG_ROUTES` stays `"0"` in production (`wrangler.jsonc` vars); to smoke-test the
deployed App path, temporarily set it to `"1"`, `yarn deploy`, check
`/debug/github-app`, set it back, and redeploy.
````

- [ ] **Step 2: Self-check the guide**

Re-read the guide and confirm every secret named in `src/lib/config.ts` (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`) is produced by some numbered step and appears in both the `.dev.vars` and `wrangler secret put` flows.

- [ ] **Step 3: Commit**

```bash
git add docs/github-setup.md
git commit -m "docs: GitHub App + OAuth app setup guide with secret provisioning"
```

---

### Task 11: Final verification + handoff

**Files:** none new.

- [ ] **Step 1: Full clean verification**

```bash
yarn typecheck
yarn test
```

Expected: typecheck passes for both projects; all unit and integration suites green. (`yarn test` runs `test:unit` then `test:integration`, which rebuilds via `yarn build`.)

- [ ] **Step 2: Verify clean git state**

Run: `git status --porcelain`
Expected: empty (everything committed). If anything is uncommitted, review and commit it with an appropriate message.

- [ ] **Step 3: Report the operator's remaining manual steps**

Phase 0's exit gate has a manual tail that no test can cover. In the final hand-off message, tell the user explicitly:

> Code is done and all tests pass. To close Phase 0's exit gate, follow `docs/github-setup.md` end-to-end (create the GitHub App + OAuth app, provision secrets, create the D1 database), then run the live smoke test in its section 7: a real OAuth login showing your username on `/` plus `{"ok":true,...}` from `/debug/github-app`.

---

## Self-Review (performed while writing this plan)

**Spec coverage check** against `2026-06-12-classroom-phase-0-skeleton-design.md`:

| Spec section | Covered by |
| --- | --- |
| §3 `users` table + full schema | Task 2 |
| §5 `config.ts` | Task 8 step 3 |
| §5 `session.ts` (incl. invalid → `null`, never 500) | Task 4; Task 9 tampered-session test |
| §5 `oauth.ts` (authorize URL, signed state, exchange, GET /user) | Task 5 |
| §5 `github/app.ts` (RS256, mint, module-scope cache) | Task 6 |
| §5 `github/client.ts` (rate-limit surfacing) | Task 3 |
| §5 `db/users.ts` (upsert by `github_id`, find) | Task 7 |
| §5 endpoints `login` / `callback` / `index.astro` | Tasks 8–9 |
| §6 OAuth data flow (state → exchange → upsert → cookie → `/`) | Task 8 tests |
| §6 App-token flow + one smoke call | Task 6 + Task 9 debug route + guide §7 |
| §7 error handling (state 400-class, fail-closed exchange, 403/429 headers, no token leaks) | Tasks 3, 5, 6, 8 tests |
| §8 unit tests (JWT, OAuth, session, cache) | Tasks 3–6 |
| §8 integration tests (upsert, callback happy path, `/` rendering) | Tasks 7–9 |
| §8 live smoke test | Task 10 guide §7, Task 11 step 3 |
| §9 setup guide, `wrangler.jsonc`, schema applied local+remote | Tasks 10, 1, 2/10 |
| §11 open items | Resolved in the header section |

**Placeholder scan:** no TBDs; every code step has complete code; the one intentional placeholder is `database_id: "REPLACE_AFTER_WRANGLER_D1_CREATE"` in `wrangler.jsonc`, which is an operator-provisioned value documented in the guide (Task 10 §6).

**Type-consistency check:** `signValue`/`verifyValue`/`signSession`/`verifySession`/`SESSION_COOKIE_NAME`/`SESSION_TTL_SECONDS` (Task 4) match their uses in Tasks 5, 8, 9. `githubRequest`/`GitHubApiError`/`rateLimit` (Task 3) match uses in Tasks 5, 6, 9. `getInstallationToken(options)` (Task 6) matches the debug route (Task 9). `upsertUser(db, {githubId, githubUsername})`/`findUserById` (Task 7) match the callback (Task 8). `getEnv()`/`AppEnv` (Task 8) match all endpoint uses.

**Known risks acknowledged in-plan:** Astro 6 `output: "server"` option name (Task 1 step 13 fallback); vitest-pool-workers × Astro built worker + assets (Task 8 contingency, cross-referenced from Task 7 step 5).




