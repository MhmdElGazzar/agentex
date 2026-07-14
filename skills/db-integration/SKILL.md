---
name: db-integration
description: >
  Execute user-defined database queries during test runs, from the project's integration/
  catalog (SQL Server via sqlcmd). Use whenever a test step needs a DB check: verify a row was
  created/updated by a UI action, check column values, or seed test data. Triggers on spec
  steps starting with "db:", or requests like "check the database", "verify the row",
  "query the table". The agent executes ONLY queries the user has defined in
  integration/*_db.json — it never composes its own SQL.
---

# DB Integration — cataloged database steps

Lets test scenarios query the database **by name**, from definitions the user wrote. Execution
is done by the bundled runner script (deterministic, enforces the safety rules in code):

```
node ${CLAUDE_PLUGIN_ROOT}/skills/db-integration/scripts/run_db.js \
  --entry <file-name>.<query-name> --param key=value [--param ...] \
  [--expect-rows N] [--expect-min-rows N] \
  --log <SESSION_DIR>/logs/<scenario>-<entry>.log
```

It loads the catalog, validates & escapes params, refuses DDL, resolves the connection from
env vars, runs sqlcmd, writes the evidence log, checks expectations, and prints one JSON line:
`{"result":"PASS|FAIL|BLOCKED", ...}` (exit 0/1/2). Read
**`${CLAUDE_PLUGIN_ROOT}/skills/db-integration/references/sqlcmd.md`** for the catalog format,
connection env vars, sqlcmd install/preflight, and the manual fallback.

## The catalog — the ONLY SQL you may execute

Definitions live in the **consumer project** at **`./integration/`** (`<database>_db.json`).
- If the folder/file is missing when a step needs it, scaffold from
  `${CLAUDE_PLUGIN_ROOT}/skills/db-integration/templates/sample_db.json` (never overwrite),
  then ask the user to define their entries.
- **Hard rule:** a step naming a query not defined in the catalog is **BLOCKED** — report
  which definition is missing. Never improvise SQL.

## Step syntax in test specs

```
db: <file-name>.<query-name>(param=value, ...) → <expectation>
```
Example: `db: sample-db.todo-by-title(title=qa-test-item) → expect 1 row`

## Safety rules (also enforced by the runner)

- Writes (INSERT/UPDATE/DELETE) run if cataloged — the catalog is the authorization.
- **DDL is banned unconditionally** — `DROP` / `TRUNCATE` / `ALTER` are refused even if
  cataloged (runner rejects them; report as a catalog error).
- Password only via the `SQLCMDPASSWORD` env var — never on a command line, never printed.
- Suspicious param values (quotes, `;`, `--`, comment markers, newlines) are rejected by the
  runner — surface the value to the user instead of executing.

## Evidence

Runner writes the result set to the `--log` path (under the session's `logs/`). Expectation
mismatch = **FAIL** defect with that log as evidence, reported in the standard defect format.

## Preflight

Requires `sqlcmd` — preflight and install per the reference (offer before installing in
sequential mode).
