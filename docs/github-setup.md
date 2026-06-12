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
4. Delete both files once the secret is stored **in every environment you need** (the local `.dev.vars` in section 5, and — if deploying — the `wrangler secret put GITHUB_APP_PRIVATE_KEY` in section 5's deployed block, which needs `github-app.pkcs8.pem` to still exist).

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

Paste the printed line into `.dev.vars` and fill in the rest.

> **Keep the surrounding double quotes** on `GITHUB_APP_PRIVATE_KEY`. They are what makes
> the `.dev.vars` parser turn the `\n` escapes back into real newlines. Removing them (or
> using single quotes) leaves literal `\n` in the key, and the GitHub App smoke test in
> section 7 will fail with a PEM/PKCS#8 error.

Generate the session secret:

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

> **Note on auto-injected bindings.** The `@astrojs/cloudflare` adapter enables Astro's
> KV-backed sessions and Cloudflare Images by default, so the built worker declares
> `SESSION` (KV) and `IMAGES` bindings. This Phase-0 app uses neither, so they are unused.
> If `wrangler deploy` ever errors about a missing `SESSION` KV namespace, create one
> (`yarn wrangler kv namespace create SESSION`) and add it to `wrangler.jsonc`, or remove
> the unused binding — it does not affect OAuth login or the GitHub App flow.
