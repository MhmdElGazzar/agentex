---
name: integrations
description: >
  Execute user-defined API calls and database queries during test runs, from the project's
  integrations/ catalog. Use whenever a test step needs to reach beyond the browser: verify via
  API that a UI action persisted, check a database row, or seed test data before a scenario.
  Triggers on spec steps starting with "api:" or "db:", or requests like "verify via API",
  "check the database", "call the endpoint", "seed data". The agent executes ONLY what the user
  has defined in integrations/*.json — it never composes its own SQL or HTTP requests.
---

# Integrations — cataloged API & DB steps

Lets test scenarios call APIs and query databases **by name**, from definitions the user wrote.
This file is the **workflow** (catalog rules, safety, evidence). Tool mechanics live in the
references — **read the relevant one before the first use in a session**:

- **`${CLAUDE_PLUGIN_ROOT}/skills/integrations/references/api-requests.md`** — executing an
  `*_api.json` request with curl: preflight/install, auth from env, assertions, logging.
- **`${CLAUDE_PLUGIN_ROOT}/skills/integrations/references/sqlcmd.md`** — executing a
  `*_db.json` query with sqlcmd (SQL Server): preflight/install, connection via env,
  substitution/escaping, logging.

## The catalog — the ONLY things you may execute

All executable definitions live in the **consumer project** at **`./integrations/`**:

```
integrations/
├── <service>_api.json     # named, parameterized HTTP requests for one service
└── <database>_db.json     # named, parameterized queries for one database
```

- If `./integrations/` doesn't exist when a step needs it, scaffold it: copy the samples from
  `${CLAUDE_PLUGIN_ROOT}/skills/integrations/templates/` (never overwrite existing files),
  then ask the user to define their entries before proceeding.
- **Hard rule: execute only cataloged entries.** A step naming a request/query that is not
  defined in `integrations/*.json` is **BLOCKED** — report exactly which definition is missing
  and how to add it. Never improvise a query or request "close to" what was asked.
- Parameters: substitute only into declared `params` placeholders; a missing parameter value →
  ask (sequential) or BLOCKED (parallel). Never substitute into anything except placeholders.

## Step syntax in test specs

```
api: <file-name>.<request-name>(param=value, ...) → <expectation>
db:  <file-name>.<query-name>(param=value, ...) → <expectation>
```

Examples:
- `api: sample-api.get-todo(id=1) → expect HTTP 200 and title present`
- `db: sample-db.todo-by-title(title=qa-test-item) → expect 1 row`

## Safety rules

- **Writes are allowed if cataloged** — the catalog is the authorization. If the user defined a
  POST/INSERT/UPDATE/DELETE entry, execute it when a spec step calls it (including parallel mode).
- **DDL is banned unconditionally** — refuse to execute any entry whose query contains `DROP`,
  `TRUNCATE`, or `ALTER`, even though it is cataloged. Report it as a catalog error.
- **Secrets stay in env** — catalog files hold env-var *names* (`tokenEnv`, `serverEnv`…); read
  the values from the environment at execution time and **never print, log, or echo them**
  (redact tokens/passwords from any logged command line).
- Suspicious parameter values (quotes, semicolons, comment markers, newlines) → do not execute;
  surface the value to the user and ask.

## Evidence (same model as screenshots)

- Save every response/result to the session's log folder:
  `SESSION_DIR/logs/<scenario>-<entry-name>.log` (HTTP: status + headers + body; DB: the
  result set as returned).
- An expectation mismatch is a **FAIL** with the log file as evidence, reported in the same
  defect format as browser findings.

## Preflight (make sure the tools are installed)

Before the first `api:` step in a session run the curl preflight, and before the first `db:`
step the sqlcmd preflight (both in the references). If a tool is missing, install it per the
reference (offer first — don't install without confirmation in sequential mode).
