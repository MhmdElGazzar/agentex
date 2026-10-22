# API & DB Steps

Sometimes seeing something happen in the browser isn't proof enough — did the signup actually
create a user in the database? Did the right thing happen server-side? `api:` and `db:` steps
let a test scenario check that directly, seed test data your scenarios need, or verify state
without you writing any code.

## Walkthrough

Say your signup-form spec adds these two lines to its scenario list:

```markdown
## Scenarios
1. **Create a user via the UI** — fill the signup form and submit; expect a success state.
2. api: getUserByEmail — confirm the API returns the new user with status 200.
3. db: countUsersByEmail — confirm exactly 1 row exists for that email.
```

When Claude reaches scenario 2, it doesn't invent a request — it looks up `getUserByEmail` in
your project's `integration/` folder (definitions you or a teammate wrote ahead of time), runs
**exactly** that request, and reports a PASS/FAIL/BLOCKED JSON result, saved in the session's
`logs/` folder as evidence.
Scenario 3 works the same way against your database. If a step names something not in that
catalog, it's reported as **BLOCKED** rather than guessed at — this is deliberate: Claude never
composes its own SQL or HTTP request.

`$agentex:init-test` scaffolds a starter `integration/` folder with sample entries you replace with your
own service's requests/queries.

## Quick reference

**Safety rules:**
- Writes (POST/PUT/DELETE) run if they're cataloged — the catalog is the authorization.
- **DDL** (`DROP` / `TRUNCATE` / `ALTER`) is refused **even if cataloged** — enforced in code.
- Secrets stay in env — catalog files hold only env-var *names*, and `environments/<env>.json`
  secret fields use `{ "envSecret": "NAME" }` references (a plain value is allowed only for
  throwaway shared test credentials); real values live in `.env` or your shell.

**API steps** — `api:` (or "verify via API", "call the endpoint")
- Catalog: `integration/*_api.json` files, found recursively under `integration/` (flat, or
  nested under `integration/api_test_suites/<service>/` for a `swagger-import`ed service);
  each catalog `"name"` must be unique (a duplicate is BLOCKED)
- Runner: `skills/api-integration/scripts/run_api.js`
- Standalone runs: `$agentex:test-endpoints` runs every `*_suite.json` case without a browser spec; `$agentex:import-swagger` generates the catalog + suite from a Swagger/OpenAPI file (`--wizard` and `--edit`: see "API suites: wizard and editor" below)
- Catalog sample: `skills/api-integration/templates/sample_api.json`
- Config: the active environment's `api` block (`baseUrl`, `token`); legacy
  `API_BASE_URL`/`API_TOKEN` in `.env` as fallback. Which catalogs it targets: `"target":
  "environment"` → always; `"target": "catalog"` (every `swagger-import`ed one) → never, the
  catalog uses its own `baseUrl` and `auth`; no `target` → only a catalog whose `baseUrl` is
  absent/empty or exactly `"${API_BASE_URL}"` — any other `baseUrl` keeps its own `baseUrl` and
  `auth` and never receives the environment token
- Reference: `skills/api-integration/references/api-requests.md`

**DB steps** — `db:` (or "check the database", "verify the row")
- Catalog: `integration/*_db.json` files
- Runner: `skills/db-integration/scripts/run_db.js`
- Catalog sample: `skills/db-integration/templates/sample_db.json`
- Config: the active environment's `db` block (`server`, `port`, `name`, `user`,
  `password`); legacy `DB_*` in `.env` as fallback
- Reference: `skills/db-integration/references/sqlcmd.md`

## API suites: wizard and editor

Two local pages turn a Swagger into basic API checks you can see, fix and re-run. Both run on
your machine only (127.0.0.1, a per-run access token, nothing loaded from the internet). Both
are in Arabic by default; add `--lang=en` for English.

**`$agentex:import-swagger --wizard [spec]`: "New suite from Swagger"**
1. **Swagger:** the spec URL or file, a suite name, and an environment you pick (there is no
   default). Only the spec is fetched; nothing is written yet.
2. **Endpoints:** every operation with its auth need and the data it needs. DELETE and other
   destructive writes start unselected; other writes arrive skipped; public ones get no 401
   case.
3. **Test data:** Claude looks in the project first (test data, past runs, read-only DB
   queries). Then it signs in to the application's UI as a user you pick. The password comes
   from `.env` and is never shown. It reads real IDs, bodies and the session token from the
   application's own network calls. A captcha or OTP is handed to you. A value nobody finds can
   be typed or left as a placeholder.
   - Creating missing data through the UI needs your one consent on the exact list, and only on
     an environment marked `"nonProduction": true` (see [configuration](./configuration.md)).
4. **Cases:** a preview of four basic checks per endpoint: happy path (2xx + required fields),
   not found (404), no token (401), missing required field (400).
5. **Approve:** one approval writes the catalog and the suite (never over an existing file),
   then opens the editor. "Approve and run now" also runs the new suite.

**`$agentex:test-endpoints --edit`: the suite editor**
- Every suite under `integration/api_test_suites/`, with a source badge on each value (UI ·
  Project · Auto · Placeholder · Manual) and Needs review / Failing / Skipped filters.
- Edit a case in the drawer, then Save. If the file changed on disk after you opened it, Save
  refuses and keeps both your edits and the file.
- Run all or Run this case go through the same runner as `$agentex:test-endpoints` and leave the same
  evidence in `executions/`.
- A case whose value is still a placeholder is reported BLOCKED ("needs a real value") and is
  never sent.

**Where things land:** the catalog and suite are yours to commit. The collected values
(`.agentex/cache/api-data/`) and a captured token (`test/.auth/api-tokens/`) stay local and
gitignored. The token is used only when the catalog's token variable is not set in `.env`. To
refresh an expired token, ask Claude in chat.

New suite-case fields for hand-written suites too: `"auth": "none"` (send with no credential),
`"omit": ["field"]` (send without it) and `"expect": {"contains": {"message": "text"}}`. See
`skills/endpoint-testing/references/suite-format.md`.

**Reference:**
- Skills: `skills/api-integration/SKILL.md`, `skills/db-integration/SKILL.md`
- Configuration: see [configuration](./configuration.md)
