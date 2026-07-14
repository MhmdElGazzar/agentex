---
name: api-integration
description: >
  Execute user-defined API calls during test runs, from the project's integration/ catalog.
  Use whenever a test step needs an HTTP call: verify via API that a UI action persisted,
  check an endpoint's response, or seed test data through a service. Triggers on spec steps
  starting with "api:", or requests like "verify via API", "call the endpoint", "check the
  response". The agent executes ONLY requests the user has defined in integration/*_api.json —
  it never composes its own HTTP requests.
---

# API Integration — cataloged API steps

Lets test scenarios call APIs **by name**, from definitions the user wrote. Execution is done
by the bundled runner script (deterministic, enforces the safety rules in code):

```
node ${CLAUDE_PLUGIN_ROOT}/skills/api-integration/scripts/run_api.js \
  --entry <file-name>.<request-name> --param key=value [--param ...] \
  [--expect-status 200] [--expect-field <dot.path>] [--expect-equals <dot.path>=<value>] \
  --log <SESSION_DIR>/logs/<scenario>-<entry>.log
```

It loads the catalog, validates params, resolves env vars, performs the request, writes the
evidence log, checks expectations, and prints one JSON line:
`{"result":"PASS|FAIL|BLOCKED", ...}` (exit 0/1/2). Read
**`${CLAUDE_PLUGIN_ROOT}/skills/api-integration/references/api-requests.md`** for the catalog
format, curl fallback (if node/script fails), and assertion details.

## The catalog — the ONLY requests you may execute

Definitions live in the **consumer project** at **`./integration/`** (`<service>_api.json`).
- If the folder/file is missing when a step needs it, scaffold from
  `${CLAUDE_PLUGIN_ROOT}/skills/api-integration/templates/sample_api.json` (never overwrite),
  then ask the user to define their entries.
- **Hard rule:** a step naming a request not defined in the catalog is **BLOCKED** — report
  which definition is missing. Never improvise a request.

## Step syntax in test specs

```
api: <file-name>.<request-name>(param=value, ...) → <expectation>
```
Example: `api: sample-api.get-todo(id=1) → expect HTTP 200 and title present`

## Safety rules (also enforced by the runner)

- Writes (POST/PUT/DELETE) run if cataloged — the catalog is the authorization.
- Secrets stay in env — catalog files hold env-var *names* (`tokenEnv`); never print values.
- Missing param/env → BLOCKED (sequential: ask the user instead).

## Evidence

Runner writes status + headers + body to the `--log` path (under the session's `logs/`).
Expectation mismatch = **FAIL** defect with that log as evidence, reported in the standard
defect format.

## Preflight

The runner needs only Node (already required by the plugin). For the curl fallback, preflight
per the reference.
