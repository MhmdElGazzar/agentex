# Procedure: run record (timestamps and run-summary.json)

## Timestamps
- Record an ISO timestamp at run start (next to the `init_run.js` call), and one line before and one after each scenario: `node -e "console.log(new Date().toISOString())"` or the shell's `date`.
- Run and per-scenario timing is required. Per-step timing is optional, when known.

## Duration is execution time, not wall-clock
- Sequential: whenever you hand control to the user (a checkpoint, a question, a NEEDS-USER resolution), note the time at the hand-off and again when you resume, and subtract the waited time. User wait never counts toward a scenario's `durationMs` or the run's.
- `run.startedAt` / `run.endedAt` are the real wall-clock timestamps. `run.durationMs` is active execution (setup included) with every user-wait interval subtracted, NOT `endedAt − startedAt`. In a sequential run, `endedAt − startedAt` exceeding `durationMs` is expected, not an error.
- Parallel and CI runs have no user wait, so the recorded timestamps already measure execution time.

## run-summary.json
- Path: `executions/execu_<ts>/run-summary.json`. Shape: the extent-report skill's `references/run-summary-schema.md` (`schemaVersion: 2`).
- The orchestrator writes it in every mode (mode parity). It is a mandatory retained artifact: no step deletes it.
- Contents: run start/end/duration, mode, environment, target, login mode, `run.tools` (the preflight JSON), `run.sessions` (from `init_run.js`), per-scenario durations, evidence paths relative to the run folder, and the defects. Parallel runs add ui-check detail, flaky attempt records, and resolved deferrals.
- Counts vocabulary: `passed / failed / blocked / warnings / viewMismatch / flaky / naDescoped / notRun`.
- Link it from `report.md`: `**Run summary (JSON):** [run-summary.json](./run-summary.json)`
