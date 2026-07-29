---
name: endpoint-testing
description: >
  Run a standalone API test pass over the project's cataloged endpoints ("api-tests"),
  independent of any browser test spec. Use for /test-endpoints, or requests like "run the
  API tests", "test all endpoints". Distinct from api-integration's `api:` step (a single
  cataloged call made mid-browser-test) — this skill runs the whole set of cases in one pass
  and returns a consolidated report. Execution is catalog+suite-only: only cases defined in
  integration/api_test_suites/**/*_suite.json, referencing entries defined in the sibling
  *_api.json catalog, ever run.
---

# Endpoint Testing — standalone API test runs

Runs the full set of API test **cases** (params + expected result per case, possibly several
cases per cataloged endpoint) as its own pass, not tied to a browser spec. Read
**`${CLAUDE_PLUGIN_ROOT}/skills/endpoint-testing/references/suite-format.md`** before the
first run in a session — it covers the suite file schema and the runner's contract in full.

## Relationship to api-integration

- **`api-integration`** — one cataloged call, made inline from a browser spec's `api:` step.
  Unaffected by this skill; its catalog (`*_api.json`, found recursively under `integration/`)
  and runner (`run_api.js`) are reused here, not duplicated.
- **`endpoint-testing`** (this skill) — the whole set of cases
  (`integration/api_test_suites/**/*_suite.json`), run standalone via the **`api-executor`**
  subagent, producing one report. No browser involved.

## The suites — the ONLY cases you may run

Definitions live in the **consumer project** under **`./integration/api_test_suites/`**, one
subfolder per service (e.g. `integration/api_test_suites/petstore/petstore_suite.json`) —
this is also where `swagger-import` writes its generated suite, co-located with that
service's catalog.
- If missing when a standalone run is requested, scaffold from
  `${CLAUDE_PLUGIN_ROOT}/skills/endpoint-testing/templates/sample_suite.json` (never
  overwrite), then ask the user to define real cases before treating results as meaningful.
- Each case's `entry` must resolve in a sibling (or elsewhere under `integration/`)
  `*_api.json` catalog — if the catalog itself is missing, point the user at `/init-test`
  first.
- **Hard rule:** a case naming an undefined entry is BLOCKED — report which definition is
  missing, never improvise a request.

## Running the api-tests

Dispatch the bundled **`api-executor`** agent (do not run the loop inline yourself — it keeps
per-case logs/output out of the orchestrator's context and returns one consolidated report,
same reasoning as dispatching `qa-executor` for browser sessions). It makes one call to
`run_suite.js` covering every case, then formats the result.

```
node "${CLAUDE_PLUGIN_ROOT}/skills/endpoint-testing/scripts/run_suite.js" \
  --catalog ./integration --suites ./integration/api_test_suites --run-dir <RUN_DIR>
```

Every case in every suite file runs every time — there's no scope/tag selection.

## Safety rules (also enforced by the runner)

- Catalog+suite-only, same as `api-integration`: never compose a request that isn't defined.
- Secrets stay in env — suite files hold only params/expectations, never token values.
- Write-method cases (POST/PUT/DELETE) run if cataloged — be deliberate about which write
  operations you add cases for, since every case under `integration/api_test_suites/` runs
  every time.

## Evidence

One log per case under `<RUN_DIR>/logs/<case-name>.log`, plus a final `result.md` written by
`api-executor` summarizing PASS/FAIL/BLOCKED counts and any failures in the project's
standard defect format.
