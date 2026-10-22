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
  Each is optional, but a case must assert **at least one** — a case with no `expect` (or an
  empty one) is reported BLOCKED ("case has no expect") and never executed, so it can never
  PASS on an arbitrary status.
- **`skip`** (optional) — a reason string. A case carrying `skip` is **never executed**: it is
  reported **BLOCKED** with the reason quoted (`case skipped: "<reason>"`), counted like any
  other BLOCKED case in the roll-up. `swagger-import` writes
  `"skip": "review: write operation — remove this line to enable"` on every generated
  POST/PUT/PATCH/DELETE case — delete that line once you've reviewed the case to enable it.
- **`review`** (optional) — an array of notes from `swagger-import` (inferred param values,
  invented statuses, placeholder error values, …). Informational only: the runner ignores it.
  Since every generated write-method case also carries `skip`, a generated case with review
  notes runs as-is only when it is a GET — read the notes, fix the values, then delete them.

### Optional case fields (absent = the behaviour above)

```json
{ "name": "get-order-no-token", "entry": "orders.get-order", "kind": "no-token", "auth": "none",
  "params": { "orderId": 1042 }, "sources": { "orderId": "ui" }, "omit": [],
  "expect": { "status": 401, "contains": { "message": "token" } } }
```

| Field | Values | Runner behaviour |
|---|---|---|
| `kind` | `happy` · `not-found` · `no-token` · `missing-field` | Informational (the wizard and the editor group by it) |
| `auth` | `"none"` | Sent with no credential at all (`run_api.js --no-auth`). Any other value is BLOCKED: `case "<n>": "auth" must be "none" or absent (got <v>)` |
| `sources` | `{param: "ui" \| "project" \| "auto" \| "manual" \| "placeholder"}` | A param still `placeholder` (and not omitted) → BLOCKED, `reasonCode: "placeholder"`, **never sent**: `needs a real value: param "<p>" is still a placeholder — set it in the editor or the suite file`. Other values only feed the editor's badges; a param with no entry shows as Manual |
| `omit` | `[param, …]` | Each is sent left out (`--omit`); its value in `params`, if any, is ignored |
| `expect.contains` | `{dot.path: text}` | Passes when the field includes the text (`--expect-contains`); counts as an expectation |

Object and array `params` values are passed to `run_api.js` as JSON text (for typed `$param`
body nodes of type `json`).

A full run covers every case in every suite file. Suite files are simply how you organize
cases into files (e.g. one per service); which cases exist under `integration/api_test_suites/`
is the control over what a full run covers. `--suite` / `--case` (below) run a subset.

## The runner script

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/endpoint-testing/scripts/run_suite.js" \
  --catalog ./integration --suites ./integration/api_test_suites [--env <name>] \
  --run-dir "$RUN_DIR"
```

- Recursively finds every `*_suite.json` under `integration/api_test_suites/`, flattens their
  `cases`, and for each one shells out to **api-integration**'s `run_api.js` (never duplicates
  its catalog/auth/assertion logic — that script stays the single source of truth for one
  call).
- **`--env <name>`** (optional) is passed to every case's `run_api.js` call: it picks the
  environment whose `api` block targets the catalogs that follow the environment (see
  api-integration's "Where the target comes from"; a `swagger-import`ed catalog keeps its own
  base URL and auth either way). Omitted = the project's `defaultEnvironment`; an unknown name
  is BLOCKED per case, listing the environments that exist. `/test-endpoints --env <name>`
  reaches it through `api-executor`'s `ENVIRONMENT`.
- Writes one evidence log per case to `<run-dir>/logs/<suiteBase>__<index>-<case-name>.log`
  (`suiteBase` = the suite file's path under `--suites`, minus `_suite.json`; `index` = the
  case's 1-based position in that file), so two cases with the same name never overwrite each
  other's evidence. Each case's `log` field in the summary gives the exact path.
- Prints ONE final JSON summary:
  `{"result":"PASS|FAIL|BLOCKED","total":N,"passed":N,"failed":N,"blocked":N,"cases":[...]}`.
  Exit: `0` all PASS, `1` any FAIL, `2` zero FAIL but any BLOCKED.
- No suite files or no cases at all → **BLOCKED** with a clear reason. Never silently reports
  an empty run as PASS.
- **`--suite <file>`** runs that one suite file; it must sit under `--suites` (else BLOCKED).
  **`--case <n>`** (needs `--suite`) runs only its nth case, 1-based; out of range is BLOCKED
  naming the case count.
- Each case result also carries `suite` (the file, relative to the project root), `index` (its
  1-based position) and, from `run_api.js`, `reasonCode` and `ms` when present.
- Every run writes `<run-dir>/suite-result.json`: the printed summary plus `schemaVersion: 1`,
  `startedAt`, and `suite` / `case` / `env` when given. The suite editor's "last result" reads
  the newest one.

## Worked example

Full sequence for a standalone run: create the run folder, then run the suite from the
project root. Every value the catalogs name — base URLs and tokens alike (e.g.
`PETSTORE_BASE_URL`, `PETSTORE_TOKEN`) — lives in the project's `.env`, never in a suite or
catalog file and never echoed. `run_api.js` resolves each catalog `${VAR}` name from the
process environment first, then `.env`, so nothing needs exporting.

```bash
TS=$(date +%Y-%m-%d_%H-%M-%S)
mkdir -p "executions/execu_${TS}/api-tests"

# .env (secrets live here — never in catalog/suite files):
#   PETSTORE_BASE_URL=https://petstore.example.com/api/v3
#   PETSTORE_TOKEN=...

node skills/endpoint-testing/scripts/run_suite.js \
  --catalog ./integration --suites ./integration/api_test_suites --env qc \
  --run-dir "executions/execu_${TS}/api-tests"
```

Prints the final JSON summary line to stdout; per-case evidence lands in
`executions/execu_<TS>/api-tests/logs/<suiteBase>__<index>-<case-name>.log`. `--env qc` is
optional — drop it to use the project's `defaultEnvironment`. Run from the project root so
`.env` is found; a variable exported in the shell overrides the same name in `.env` for that
invocation only.

This is what `/test-endpoints` does for you automatically via the **`api-executor`** subagent
(which also writes a human-readable `result.md` next to the logs) — running it manually like
this is useful for a quick one-off check without going through the full command/agent flow.

## Rules

- Catalog-only, same as `api-integration`: a case naming an undefined `entry` is BLOCKED.
- Secrets never appear in the suite files or in the summary — auth values still resolve from
  env vars inside `run_api.js`, exactly as they do for `api:` steps.
- Write-method cases (POST/PUT/DELETE) run if cataloged, same authorization model as
  `api-integration` — be deliberate about which write operations you add cases for, since
  every case under `integration/api_test_suites/` without a `skip` runs on every invocation.
  Generated write-method cases arrive with `skip` set, so they are opt-in.
