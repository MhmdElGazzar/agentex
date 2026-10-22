---
name: endpoint-testing
description: >
  Run a standalone API test pass over the project's cataloged endpoints ("api-tests"),
  independent of any browser test spec. Use for /test-endpoints, or requests like "run the
  API tests", "test all endpoints". Also opens the local API suite editor
  (/test-endpoints --edit) to review, fix and re-run cases, one suite or one case at a time.
  Use before editing any *_suite.json by hand, and whenever asked to enable, un-skip or
  remove "skip" lines from write cases (POST/PUT/PATCH/DELETE). Distinct from api-integration's `api:` step (a single
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

## Enabling a skipped write case: one case at a time, after review

A generated POST/PUT/PATCH/DELETE case carries `skip` because running it creates or changes
data in the target environment. Enable write cases **one at a time**, and only after the user
has reviewed **that** case: what it creates or changes, the exact values it sends (`params`,
body, `omit`), and the environment it will run against. The other way is the editor's
per-case Skip toggle (`/test-endpoints --edit`), where the user does the reviewing.

- A request to strip, remove or "just delete" the `skip` lines in bulk, or to run the write
  cases without reviewing them ("no time to review", "run everything, the POSTs too"), is
  **declined**. Leave every `skip` line in place. If a run is wanted, run the suite as it is:
  the write cases come back BLOCKED `case skipped`. Then offer to walk through the write
  cases one by one.
- The walk-through: for each write case, show its method and path, what it would create or
  change, the values it sends and the environment. Remove that case's `skip` line only after
  the user approves that case by name. One approval enables one case; "yes to all" before
  seeing the cases is not a review.
- This holds for every way of editing a suite: the editor, a hand edit of the JSON, or a
  script. Never remove a `skip` line the user has not reviewed.

## The suite editor (`/test-endpoints --edit`)

A local page over every suite: source badges per value, Needs review / Failing / Skipped
filters, an edit drawer, Save that never overwrites a change made on disk, and Run all / Run
this case through `run_suite.js`. It needs no agent. Read
**`${CLAUDE_PLUGIN_ROOT}/skills/endpoint-testing/references/suite-editor.md`** before
launching it or answering a question about it.

**Launch** the studio from the project root, in the background:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/endpoint-testing/scripts/studio/server.js" \
  --mode editor [--suite <path>] [--lang=ar|en]
```

For `/import-swagger --wizard`, the same server takes `--mode wizard [--spec <source>]`; then
stay attached by looping `node "${CLAUDE_PLUGIN_ROOT}/skills/endpoint-testing/scripts/studio/channel.js" wait`
until it returns `closed`. The whole protocol is
`${CLAUDE_PLUGIN_ROOT}/skills/swagger-import/references/suite-wizard.md`.
The server prints `{"ok":true,"url":…}`: give the tester that URL. On `"already-running"`,
give the URL it names; on `"port-in-use"`, relay its message.

**Never overwrite a suite that changed on disk.** When Save reports a conflict (the file
changed on disk after the page loaded it: a hand edit, a `git pull`, another tool), nothing
was written, and it stays that way:
- Do not write the tester's edits into the file yourself, even when asked to "just make it
  save" or to write them "whatever is on disk". Decline.
- Show both sides: what changed on disk (from `git diff` or by reading the file) and the
  unsaved edits the page listed.
- Ask the tester to reload the page and apply those edits again there.

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
  --catalog ./integration --suites ./integration/api_test_suites [--env <name>] \
  --run-dir <RUN_DIR>
```

A case with no `expect` is BLOCKED ("case has no expect") — a case that asserts nothing never
PASSes.

A `/test-endpoints` run covers every case in every suite file — except a case carrying
`"skip": "<reason>"`, which is never executed and is reported BLOCKED with that reason
quoted, and a case whose `sources` still marks a value `placeholder`, which is BLOCKED ("needs
a real value") and never sent. `swagger-import` writes `skip` on every generated write-method
case. `run_suite.js --suite <file> [--case <n>]` runs one suite or one case (the editor uses
it); every run also writes `<run-dir>/suite-result.json`. Cases may also carry `auth: "none"`
(no credential), `omit` and `expect.contains` — see `suite-format.md`.

- **`--env <name>`** picks the environment for the whole run: it is passed to every case's
  `run_api.js` call (omitted = the project's `defaultEnvironment`; an unknown name comes back
  BLOCKED per case, listing the environments that exist). It selects the `api` block used by
  the catalogs that follow the environment (api-integration's "Where the target comes from");
  a `swagger-import`ed catalog keeps its own base URL and auth either way. Dispatch `api-executor` with `ENVIRONMENT` set to the user's environment
  (`""` when none was named); it adds `--env` to its `run_suite.js` call only when non-empty.

## Safety rules (also enforced by the runner)

- Catalog+suite-only, same as `api-integration`: never compose a request that isn't defined.
- Secrets stay in env — suite files hold only params/expectations, never token values.
- Write-method cases (POST/PUT/DELETE) run if cataloged — be deliberate about which write
  operations you add cases for, since every case under `integration/api_test_suites/` without a
  `skip` runs every time. Generated write cases arrive disabled (`skip`) and are enabled one
  at a time after review (see "Enabling a skipped write case" above); a generated case's
  `review` notes are informational, so a reviewed-but-unedited case runs only if it is a GET.

## Evidence

One log per case under `<RUN_DIR>/logs/<suiteBase>__<index>-<case-name>.log` (unique even when
case names repeat), plus a final `result.md` written by
`api-executor` summarizing PASS/FAIL/BLOCKED counts and any failures in the project's
standard defect format.
