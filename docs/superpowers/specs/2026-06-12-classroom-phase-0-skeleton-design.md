# Classroom Clone — Phase 0 (Skeleton) Design

**Status:** Approved design, ready for implementation planning
**Date:** 2026-06-12
**Scope:** Phase 0 only, of the larger [classroom-clone build plan](../../plan/classroom-clone-build-plan.md). Later phases (assignments, acceptance, deadline engine, queues, grader builder, frontend) each get their own design → plan → implementation cycle.

---

## 1. Purpose & Exit Gate

Phase 0 builds the foundation the rest of the system stands on, and proves out the two riskiest pieces of infrastructure early:

1. **GitHub App token minting on Workers** — signing an RS256 JWT with WebCrypto and exchanging it for a short-lived installation token.
2. **GitHub OAuth user login** — resolving and persisting the authenticated user's GitHub identity.

**Phase 0 is done when:**
- A real GitHub OAuth login resolves the logged-in user's GitHub username and stores their identity in D1 (`users` table).
- The GitHub App path mints an installation token and makes one successful authenticated GitHub API call (live smoke test, performed after the operator follows the setup guide).
- Unit tests (pure logic) and integration tests (Worker boundary) are green.

Everything else in the build plan is explicitly **out of scope for Phase 0**: no classrooms, assignments, slugs, acceptance, deadlines, queues, cron, or grader builder. Those tables exist in the schema but are not exercised yet.

---

## 2. Settled Decisions

These were decided during brainstorming. Do not reintroduce alternatives without flagging.

| Decision | Choice | Rationale |
| --- | --- | --- |
| Scope | Phase 0 skeleton only | Smallest safe slice; de-risks token minting + OAuth before building on top. |
| Web framework | **Astro 6 + `@astrojs/cloudflare` v13+**, single Worker | Real frontend work comes later (Phase 6); Astro's SSR pages + endpoints beat hand-rolled HTML. Devcontainer already ships Playwright. |
| App structure | **Framework-agnostic core in `src/lib/*`; Astro endpoints are thin adapters** | The future cron/queue handlers must reuse the same core, and the core stays unit-testable without booting Astro. |
| Worker entry | **Stock Astro Cloudflare adapter now; defer custom `src/worker.ts`** | Phase 0 has no non-HTTP handlers. The custom entry that wraps Astro's SSR handler and adds `scheduled`/`queue`/DO exports arrives in Phase 3 when the cron sweep first needs it. The framework-agnostic core makes that swap trivial (YAGNI). |
| Sessions | **Stateless signed cookie** (HMAC-SHA256 via WebCrypto, `SESSION_SECRET`) | Nothing to provision; no storage round-trip; irrelevant to the cron/queue handlers. Trade-off accepted: no server-side revocation before expiry. |
| GitHub client | **Lean typed `fetch` wrapper** + our own WebCrypto RS256 token minting | Token minting is custom regardless (Octokit's auth plugins assume Node crypto). Smallest bundle; explicit rate-limit-header handling that later phases lean on. |
| GitHub setup | **Setup guide is a Phase 0 deliverable**; live verification after | Operator has no GitHub App/org yet. The guide unblocks the live smoke test. |
| Testing | **Split: plain Vitest for pure logic + `@cloudflare/vitest-pool-workers` for the Worker boundary** | Fast unit tests for signing/OAuth/session logic; real-`workerd` + test D1 for endpoints, cookies, and queries. |

---

## 3. Design Gap Resolved: the `users` table

The original plan has no place to store an authenticated account. Its only person-like table is `students`, which is **classroom-scoped** (`classroom_id NOT NULL`) — and in Phase 0 no classroom exists. Phase 0's exit gate requires storing the authenticated identity somewhere.

**Resolution:** add a `users` table for authenticated GitHub identities, keyed by the **stable GitHub numeric id** (usernames can change). Roster `students` get *linked* to a `user` in a later phase (not Phase 0).

```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY,                 -- uuid
  github_id       INTEGER NOT NULL UNIQUE,          -- stable identity (usernames change)
  github_username TEXT NOT NULL,                    -- latest known login
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at   TEXT
);
```

The **full** `schema.sql` (all tables from the build plan §4 **plus** `users`) is created and applied in Phase 0 so D1 is ready for later phases. Phase 0 only reads/writes `users`.

---

## 4. Architecture

A single Cloudflare Worker built with Astro. All domain and infrastructure logic lives in framework-agnostic TypeScript modules under `src/lib/`. Astro pages and endpoints are thin adapters that parse the request, call into `src/lib/`, and shape the response.

```
src/
├─ pages/
│  ├─ index.astro              # landing: shows logged-in username (proves the exit gate)
│  └─ auth/
│     ├─ login.ts              # endpoint: build authorize URL + signed state, redirect to GitHub
│     └─ callback.ts           # endpoint: verify state, exchange code, upsert user, set cookie
├─ lib/
│  ├─ config.ts                # typed env access via `cloudflare:workers`
│  ├─ auth/
│  │  ├─ session.ts            # sign/verify stateless cookie (HMAC-SHA256, WebCrypto)
│  │  └─ oauth.ts              # build authorize URL, exchange code, fetch GitHub user
│  ├─ github/
│  │  ├─ app.ts                # RS256 JWT (WebCrypto) + installation-token mint + in-memory cache
│  │  └─ client.ts             # lean fetch wrapper + rate-limit-header handling
│  └─ db/
│     ├─ schema.sql            # full build-plan schema + `users` table
│     └─ users.ts              # typed D1 upsert/find
├─ env.d.ts                    # binding + secret typings
astro.config.mjs               # @astrojs/cloudflare adapter
wrangler.jsonc                 # D1 binding (DB), compatibility_date, nodejs_compat, cron/queue NOT yet
```

**Two platform gotchas baked in:**
- Access bindings/secrets by importing `env` from `cloudflare:workers` directly — wrangler `vars` do not reliably forward into Astro.
- Enable `nodejs_compat` for the WebCrypto/token-minting path.

---

## 5. Components & Contracts

Each module has one purpose, a small interface, and explicit dependencies.

### `src/lib/config.ts`
- **Does:** centralizes typed access to env (secrets + `DB` binding) via `cloudflare:workers`.
- **Depends on:** the Cloudflare runtime.
- **Secrets consumed:** `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`.

### `src/lib/auth/session.ts`
- **Does:** `sign(payload) → cookieValue` and `verify(cookieValue) → payload | null` using HMAC-SHA256 over a compact encoded payload with `SESSION_SECRET`. Session payload: `{ userId, githubUsername, iat, exp }`.
- **Used by:** `auth/callback.ts` (set), `index.astro` and future authed pages (read).
- **Note:** also exposes helpers to read/clear the cookie. Invalid/tampered/expired cookie → `null` (treated as logged-out, never a 500).

### `src/lib/auth/oauth.ts`
- **Does:** `buildAuthorizeUrl(state)`, `exchangeCode(code) → userAccessToken`, `fetchAuthenticatedUser(token) → { githubId, login }`.
- **State/CSRF:** `state` is itself an HMAC-signed, short-TTL value (reuses `session.ts` signing primitive) so the callback can verify it without server-side storage.
- **Depends on:** `github/client.ts` for the API calls, `config.ts` for client id/secret.

### `src/lib/github/app.ts`
- **Does:** `mintInstallationToken() → { token, expiresAt }`. Builds an RS256 JWT (`iss` = app id, short `exp`) signed with `GITHUB_APP_PRIVATE_KEY` via WebCrypto (`RSASSA-PKCS1-v1_5` + SHA-256), exchanges it at `POST /app/installations/{id}/access_tokens`, and caches the result in **module scope** until ~1 minute before expiry.
- **Depends on:** `github/client.ts`, `config.ts`.

### `src/lib/github/client.ts`
- **Does:** thin `fetch` wrapper: base URL, auth header injection, JSON handling, and **rate-limit-header awareness** (`retry-after`, `x-ratelimit-remaining`, `x-ratelimit-reset`) surfaced on responses/errors. This is the seam later phases extend for retry/backoff.
- **Depends on:** nothing app-specific (pure HTTP).

### `src/lib/db/users.ts`
- **Does:** `upsertUser({ githubId, githubUsername }) → user` (insert or update `github_username` + `last_login_at` on conflict by `github_id`), `findUserById(id)`.
- **Depends on:** the `DB` D1 binding.

### Astro endpoints/pages
- `pages/auth/login.ts` — generates signed `state`, redirects to `buildAuthorizeUrl(state)`.
- `pages/auth/callback.ts` — verifies `state`, `exchangeCode`, `fetchAuthenticatedUser`, `upsertUser`, signs a session cookie, redirects to `/`.
- `pages/index.astro` — reads the session cookie; shows the logged-in username or a login link.

---

## 6. Data Flow

**OAuth login (user identity):**
1. User hits `/auth/login`.
2. Endpoint builds a signed `state` and redirects to GitHub's authorize URL.
3. GitHub redirects back to `/auth/callback?code=…&state=…`.
4. Callback verifies `state` (reject mismatch/expiry → CSRF guard), exchanges `code` for a user access token, calls `GET /user`.
5. `upsertUser` writes/updates the `users` row by `github_id`.
6. Callback signs a session cookie `{ userId, githubUsername }` and redirects to `/`.
7. `/` reads the cookie and renders the username → **exit gate satisfied.**

**GitHub App token minting (org actions, verified independently):**
1. `mintInstallationToken()` builds and RS256-signs the App JWT via WebCrypto.
2. Exchanges it for an installation token; caches in module scope until just before expiry.
3. `client.ts` uses the token for **one** authenticated smoke call (e.g. `GET /installation/repositories` or the app/installation endpoint) to prove the path end-to-end.

---

## 7. Error Handling

- **OAuth:** invalid/expired/mismatched `state` → 400 logged-out redirect, not 500. GitHub error params (`error`, `error_description`) surfaced. Token-exchange non-200 → fail closed.
- **Token minting:** typed errors for (a) JWT signing failure, (b) non-200 installation-token response. Never leak the private key or token in errors/logs.
- **`client.ts`:** on `403`/`429`, read `retry-after` / `x-ratelimit-reset` and expose them on the thrown error so later phases can back off. (Phase 0 does not implement retry loops — it just surfaces the data.)
- **Session:** any invalid cookie → `null` (logged-out), never an exception that 500s a page.

---

## 8. Testing

**Plain Vitest (fast, mocked `fetch`), under e.g. `test/unit/`:**
- RS256 JWT: correct header/claims shape; signature verifies against the public key; honors `exp`.
- OAuth: authorize-URL construction; `state` sign/verify incl. tamper + expiry rejection; `exchangeCode` request shape and error handling (mocked).
- Session: `sign`/`verify` round-trip; tamper rejection; expiry.
- Installation-token cache: returns cached token before expiry; re-mints after.

**`@cloudflare/vitest-pool-workers` (real `workerd` + test D1), under e.g. `test/integration/`:**
- `users` upsert/find against a migrated test D1 (insert then conflict-update by `github_id`).
- `/auth/callback` happy path with GitHub responses mocked at the `fetch` boundary: ends with a Set-Cookie and a redirect; the user row exists.
- `/` renders the username when a valid session cookie is present; renders login link otherwise.

**Live smoke test (manual, after setup guide):** real OAuth login completes; `mintInstallationToken()` + one authenticated call succeeds.

---

## 9. Deliverables Beyond Code

- **GitHub setup guide** (`docs/`): step-by-step creation of (a) the GitHub App — required permissions (Administration: write, Contents: write, Members/Collaborators: write, Metadata: read — only Metadata is exercised in Phase 0, the rest are set up for later phases), private-key download, installation on a test org, capturing App id + installation id; and (b) the OAuth app — client id/secret, callback URL. Ends with the `wrangler secret put` commands for all secrets in §5.
- **`wrangler.jsonc`** with the D1 binding (`DB`), `compatibility_date`, `nodejs_compat`. No cron or queue config yet.
- **`schema.sql`** applied to local + remote D1.

---

## 10. Out of Scope (deferred to later phases)

- Custom `src/worker.ts` entry-point wrapping Astro's SSR handler with `scheduled`/`queue`/Durable Object exports (Phase 3+).
- Classrooms, assignments, slug validation, repo-name helpers (Phase 1).
- Acceptance flow, collaborator management, re-sync (Phase 2).
- Deadline classification, cron sweep (Phase 3).
- Queue pipeline, dead-letter queue, permission downgrade (Phase 4).
- Grader builder via Git Data API (Phase 5).
- Teacher/student frontend views beyond the trivial login landing (Phase 6).
- KV-backed installation-token cache (optimization; module-scope cache is sufficient for the MVP).

---

## 11. Open Items for Implementation Planning

- Confirm current `@astrojs/cloudflare` v13+ custom-entry mechanics are **not** needed in Phase 0 (they are not — stock adapter), and note exactly where Phase 3 will introduce `src/worker.ts`.
- Confirm the exact GitHub App endpoint used for the smoke call (`GET /installation/repositories` vs `GET /app`), choosing one reachable with only Metadata: read.
- Decide the session cookie TTL and attributes (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`).
- Decide local-vs-remote D1 migration workflow with Wrangler for tests and dev.
