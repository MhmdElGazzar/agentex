# AgenTeX single-executor contract (v1)

This is the runtime boundary for one spec or one bounded natural-language test mission. It
does not launch workers. The existing Claude `qa-executor` remains unchanged; Codex uses
this contract for one local executor. Later adapters may pass the same assignment to an
isolated worker without changing the evidence or report formats.

## Input supplied by the orchestrator

| Field | Meaning |
|---|---|
| `runDir` | `init_run.js` output `runDir`, relative to the consumer project. |
| `session` | One key from `init_run.js` output `sessions`; never `default`. |
| `targetUrl` | Resolved portal/target URL. |
| `environment` | Resolved environment name, or `null` for a legacy project. |
| `spec` | Supplied spec path or a bounded natural-language mission and planned scenarios. |
| `testData` | Active environment's `defaults` and `users`; preserve `{envSecret}` references and resolve only at use time. |
| `loginMode` | `none`, `fresh`, `per-test`, or `session`, resolved once by test-execution. |
| `workingDir` | Absolute consumer project root; run all CLI commands there. |
| `executionDir` | Absolute path to `runDir`. |
| `sessionDir` | Absolute path to `sessions[session].dir`. |
| `runId`, `workerId` | Additive identifiers for a Codex parallel assignment; absent in sequential mode. |
| `browserWorkingDir` | Optional Codex parallel CLI working directory, equal to `sessionDir` for writable isolation. `workingDir` remains the consumer root for spec/config resolution. |
| `authStatePath` | Optional Codex parallel `loginMode=session` private temporary storageState copy. Only this copy may be refreshed; the shared source under `test/.auth` is read-only. The coordinator removes private copies after workers become terminal and never persists these paths or contents in run artifacts. |
| `evidenceExpectations` | Optional screenshot/console/request requirements for a parallel worker. |
| `artifacts` | Screenshots in `sessionDir/screenshots/`, logs in `sessionDir/logs/`, result in `sessionDir/executor-result.json`. |

The Copilot packaged host worker may add `coverage` to its per-session result:
`{specSha256, executedStepIds}`. Its coordinator-side validator checks this
against the saved source spec before accepting a PASS. Existing executor
results and the v1 schema remain valid for other runtimes. The Codex process
worker writes sanitized, fixed-vocabulary diagnostics to
`sessionDir/logs/worker-stdout.log` and `worker-stderr.log`; raw model and
tool transcripts are never stored there.

The orchestrator obtains session names and directories from `init_run.js`. It must not
compose its own session names or send resolved credential values in an assignment. The
agent receives this input in its context; do not persist `testData` to a run artifact.
For parallel Codex, one worker receives exactly one immutable assignment and
may write only its session directory. The coordinator, not the worker, owns
validation recovery, aggregation, and final files.

## Output

Write `sessionDir/executor-result.json` after attempting session cleanup, including on
failure. Its fields are:

```json
{
  "schemaVersion": 1,
  "runDir": "executions/execu_2026-01-01_12-00-00",
  "session": "smoke-120000-a1b2",
  "spec": "test/smoke.md",
  "status": "passed",
  "startedAt": "2026-01-01T12:00:00.000Z",
  "endedAt": "2026-01-01T12:00:05.000Z",
  "durationMs": 5000,
  "scenarios": [],
  "defects": [],
  "failures": [],
  "cleanup": { "attempted": true, "closed": true, "error": null }
}
```

`scenarios[]` uses the existing `run-summary.json` v2 `testCases[]` objects **without
changing their fields** (`name`, `status`, `steps`, `screenshots`, timing, etc.). `defects[]`
uses the existing v2 `defects[]` objects. All evidence paths in those objects are relative
to `runDir` and point inside this executor's `browser-sessions/<session>/` slice, except
the orchestrator's later copies under `bugs/`. `failures[]` contains `{kind, detail}`,
where `kind` is `product`, `infrastructure`, or `automation`; do not treat an
infrastructure/automation failure as a product defect. `status` is the rollup using the
same vocabulary as a test case: `passed`, `failed`, `blocked`, `warning`,
`viewMismatch`, or `flaky`. Individual scenarios may also be `na` or `notrun`,
matching the existing v2 schema. `cleanup` records the outcome of `-s=<session> close`.

The result is a per-executor transport record, not a new final report format. The
shared `scripts/project_executor_result.js` projects sequential scenarios and defects into the
existing `run-summary.json` v2, `report.md`, and `bugs/` files, and rejects repeat
projection rather than duplicating rows. Parallel workers never invoke that
projector; `finalize_parallel_run.js` validates all assigned session results
and writes the same formats once. The HTML renderer consumes that v2 summary.
Never put secret values or `{envSecret}` target names in
the result. A failed cleanup is visible and makes the overall result `blocked` unless a
product failure already occurred; never silently claim successful cleanup.
