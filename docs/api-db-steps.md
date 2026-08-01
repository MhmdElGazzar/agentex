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

`/init-test` scaffolds a starter `integration/` folder with sample entries you replace with your
own service's requests/queries.

## Quick reference

**Safety rules:**
- Writes (POST/PUT/DELETE) run if they're cataloged — the catalog is the authorization.
- **DDL** (`DROP` / `TRUNCATE` / `ALTER`) is refused **even if cataloged** — enforced in code.
- Secrets stay in env — catalog files hold only env-var *names*; values live in `.env` or your
  shell.

**API steps** — `api:` (or "verify via API", "call the endpoint")
- Catalog: `integration/*_api.json` files
- Runner: `skills/api-integration/scripts/run_api.js`
- Catalog sample: `skills/api-integration/templates/sample_api.json`
- Env: `API_BASE_URL`, `API_TOKEN`
- Reference: `skills/api-integration/references/api-requests.md`

**DB steps** — `db:` (or "check the database", "verify the row")
- Catalog: `integration/*_db.json` files
- Runner: `skills/db-integration/scripts/run_db.js`
- Catalog sample: `skills/db-integration/templates/sample_db.json`
- Env: `DB_SERVER`, `DB_PORT` (default `1433`), `DB_NAME`, `DB_USER`; password via
  `SQLCMDPASSWORD` (never on the command line)
- Reference: `skills/db-integration/references/sqlcmd.md`

**Reference:**
- Skills: `skills/api-integration/SKILL.md`, `skills/db-integration/SKILL.md`
- Configuration: see [configuration](./configuration.md)
