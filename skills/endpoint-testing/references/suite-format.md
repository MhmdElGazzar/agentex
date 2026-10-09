# Tool: suite runs — executing `integration/api_test_suites/**/*_suite.json`

How to run a standalone API test pass over cataloged endpoints. Read before the first
`/test-endpoints` invocation (or any standalone-suite request) in a session.

## Relationship to the endpoint catalog

A `*_api.json` catalog (owned by the **api-integration** skill; searched recursively under
`integration/`) describes *how* to call an endpoint — base URL, auth, path, declared params.
It doesn't carry concrete test data or expected results, because normally a browser spec's
`api:` step supplies those inline.

A standalone run has no spec supplying that — so **suite files**
(`integration/api_test_suites/<service>/<service>_suite.json`, owned by this skill, co-located
with that service's catalog — this is where `swagger-import` writes both) hold concrete
**cases**: an entry reference plus the params and expected result for that case. One entry can
have multiple cases (happy path, not-found, validation error, …).

## Suite file schema

```json
{
  "name": "sample-api-suite",
  "cases": [
    {
      "name": "get-todo-happy-path",
      "entry": "sample-api.get-todo",
      "params": { "id": 1 },
      "expect": { "status": 200, "fields": ["title"] }
    },
    {
      "name": "get-todo-not-found",
      "entry": "sample-api.get-todo",
      "params": { "id": 999999 },
      "expect": { "status": 404, "equals": {} }
    }
  ]
}
```

- **`entry`** — `<catalog-file>.<request-name>`, must exist in some `*_api.json` catalog under
  `integration/` (same rule as `api:` steps: undefined entries are BLOCKED, never improvised).
- **`params`** — object of `{paramName: value}`, must satisfy the entry's declared `params`
  in the catalog (same validation `run_api.js` already does per-call).
- **`expect.status`** — expected HTTP status code.
- **`expect.fields`** — array of dot-paths that must exist in the JSON response.
- **`expect.equals`** — object of `{dot.path: expectedValue}`.
  All three are optional; omit what you don't need to assert.

Every case in every suite file runs every time — there's no scope/tag filtering. Suite files
are simply how you organize cases into files (e.g. one per service); which cases exist under
`integration/api_test_suites/` is the only control over what a run covers.

## The runner script

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/endpoint-testing/scripts/run_suite.js" \
  --catalog ./integration --suites ./integration/api_test_suites --run-dir "$RUN_DIR"
```

- Recursively finds every `*_suite.json` under `integration/api_test_suites/`, flattens their
  `cases`, and for each one shells out to **api-integration**'s `run_api.js` (never duplicates
  its catalog/auth/assertion logic — that script stays the single source of truth for one
  call).
- Writes one evidence log per case to `<run-dir>/logs/<case-name>.log`.
- Prints ONE final JSON summary:
  `{"result":"PASS|FAIL|BLOCKED","total":N,"passed":N,"failed":N,"blocked":N,"cases":[...]}`.
  Exit: `0` all PASS, `1` any FAIL, `2` zero FAIL but any BLOCKED.
- No suite files or no cases at all → **BLOCKED** with a clear reason. Never silently reports
  an empty run as PASS.

## Worked example

Full sequence for a standalone run: create the run folder, load env vars (`.env` for
non-secret values, shell `export` for tokens — never into `.env`), then run the suite.

```bash
TS=$(date +%Y-%m-%d_%H-%M-%S)
mkdir -p "executions/execu_${TS}/api-tests"

set -a; source .env; set +a       # loads e.g. PETSTORE_BASE_URL
export PETSTORE_TOKEN="..."       # shell-only, never written to .env

node skills/endpoint-testing/scripts/run_suite.js \
  --catalog ./integration --suites ./integration/api_test_suites \
  --run-dir "executions/execu_${TS}/api-tests"
```

Prints the final JSON summary line to stdout; per-case evidence lands in
`executions/execu_<TS>/api-tests/logs/<case-name>.log`. `env` vars must be present in the
*same* shell invocation that runs the script — they don't persist across separate shell
sessions, so `source .env` and any `export` need to happen right before this command, not in
an earlier one.

This is what `/test-endpoints` does for you automatically via the **`api-executor`** subagent
(which also writes a human-readable `result.md` next to the logs) — running it manually like
this is useful for a quick one-off check without going through the full command/agent flow.

## Rules

- Catalog-only, same as `api-integration`: a case naming an undefined `entry` is BLOCKED.
- Secrets never appear in the suite files or in the summary — auth values still resolve from
  env vars inside `run_api.js`, exactly as they do for `api:` steps.
- Write-method cases (POST/PUT/DELETE) run if cataloged, same authorization model as
  `api-integration` — be deliberate about which write operations you add cases for, since
  every case under `integration/api_test_suites/` runs on every invocation.
