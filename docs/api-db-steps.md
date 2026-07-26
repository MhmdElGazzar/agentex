# API & DB Steps

Test scenarios can include `api:` and `db:` steps to verify that a UI action actually persisted —
check an endpoint's response, confirm a row was written, or seed test data.

## How it works

Execution is **catalog-only**. The agent runs *exclusively* the named, parameterized requests and
queries you define in your project's root `integration/` folder. It **never composes its own SQL or
HTTP**. Deterministic Node runner scripts do the mechanical work (param validation, env resolution,
evidence logging, assertions) and print a `PASS` / `FAIL` / `BLOCKED` JSON result that lands in the
session's `logs/` as evidence.

- **Writes** run if they are cataloged.
- **DDL** (`DROP` / `TRUNCATE` / `ALTER`) is refused **even if cataloged** — enforced in code.
- **Secrets stay in env** — catalog files hold only env-var *names*; values live in `.env` or your shell.

## API steps

A scenario step beginning with `api:` (or a request like "verify via API", "call the endpoint")
runs a request from `integration/*_api.json`.

- Runner: `skills/api-integration/scripts/run_api.js` (executes one request via Node `fetch`).
- Catalog sample: `skills/api-integration/templates/sample_api.json` (scaffolded to `integration/` by `/init-test`).
- Env: `API_BASE_URL`, `API_TOKEN`.
- Reference: `skills/api-integration/references/api-requests.md` (runner usage + curl fallback).

## DB steps

A scenario step beginning with `db:` (or "check the database", "verify the row") runs a query from
`integration/*_db.json` against SQL Server via `sqlcmd`.

- Runner: `skills/db-integration/scripts/run_db.js` (catalog-only, DDL ban + param sanitization in code, row-count assertions).
- Catalog sample: `skills/db-integration/templates/sample_db.json`.
- Env: `DB_SERVER`, `DB_PORT` (default `1433`), `DB_NAME`, `DB_USER`. The password is read natively
  by `sqlcmd` from `SQLCMDPASSWORD` — **never** passed on the command line.
- Reference: `skills/db-integration/references/sqlcmd.md`.

## Example

Inside a spec's scenario list:

```markdown
## Scenarios
1. **Create a user via the UI** — fill the signup form and submit; expect a success state.
2. api: getUserByEmail — confirm the API returns the new user with status 200.
3. db: countUsersByEmail — confirm exactly 1 row exists for that email.
```

`getUserByEmail` and `countUsersByEmail` must exist in your `integration/*_api.json` /
`integration/*_db.json` catalog — the agent will not invent them.

## Reference

- Skills: `skills/api-integration/SKILL.md`, `skills/db-integration/SKILL.md`
- Configuration: see [configuration](./configuration.md)
