# Procedure: parallel run (autonomous)
Run end to end without per-checkpoint approval, and present the final report when done.
- If the overall scope is ambiguous, ask once before DISPATCH. Otherwise proceed without pausing.
- MERGE-time resolution of NEEDS-USER items is the only mid-flow user interaction. It happens after every executor finishes and before the final report.

1. **SETUP**
   - Run `init_run.js --sessions <one label per test file>`. The JSON's `sessions` keys are the unique session names to inject as each executor's `SESSION`.
   - When a report names a spec, use each session's `label`, not the ASCII session name. A spec titled in a non-Latin script has no ASCII to keep, so its session name is `spec<n>-<digest>`.
   - Run `preflight.js --needs <the run's drivers>`. Keep its JSON (it becomes `run.tools`) and the `sessions` JSON (it becomes `run.sessions`) for MERGE.
   - Record the run-start timestamp (`run-record.md`).
2. **LOAD**
   - Read the planned test files, one bucket per file. By convention they live in `test/`, but use wherever the user keeps their specs.
   - Stateful scenarios stay grouped and run sequentially within their own file.
   - First run with no specs: copy `${CLAUDE_PLUGIN_ROOT}/test/suite1/` into `./test/suite1/` as an editable starting point, and tell the user to adapt it before a real regression.
3. **DISPATCH**
   - One **qa-executor** per test file. Inject `SESSION`, `SESSION_DIR` (`…/browser-sessions/<session>`), `WORKING_DIR` (the consumer project root, where every command runs), `TARGET_URL` (empty when the file has no browser steps), `ENVIRONMENT` (empty for legacy projects), `TEST_DATA`, `LOGIN_MODE`, `DRIVERS` (that file's drivers from `spec_drivers.js`), and `TEST_SPEC` (the file's full text).
   - `TEST_DATA` is the environment's `defaults` + `users` JSON, with secrets left as `envSecret` refs. The executor resolves them only at use time and never prints them.
   - `LOGIN_MODE` is injected even when it resolved to the default, so no executor has to guess.
   - **Waves, not one unbounded batch.** Never have more than 6 executors running at once (each browser executor is a real Chromium). Launch up to 6 together, then start the next file's executor each time one returns, until every file has run.
   - A spawn refused with `Concurrent subagent limit reached` is not a result. Nothing queues automatically: wait for a running executor to return, then dispatch that file again.
   - A file that never got dispatched is recorded as `notRun` in `run-summary.json` (the verdict treats it as incomplete, never as a pass).
4. **MERGE**, in this order:
   1. **NEEDS-USER first.** Surface every NEEDS-USER item to the user: the precise question plus both image paths (baseline and actual). Collect the answers and finalize those verdicts per the ui-check skill.
   2. **FLAKY.** Carry every FLAKY scenario into the report's **Unstable results** section (`report.md`), out of the pass/fail tally and out of `bugs/bug-list.md`.
   3. **Report.** Write `report.md` and build `bugs/`, including any ui-check FAILs finalized in step 1 (`report.md`).
   4. **Run record.** Record the run end and compose `run-summary.json` from the executor reports (`run-record.md`): `run.tools` from SETUP's preflight, `run.sessions` from `init_run.js`, per-scenario timings and evidence paths, ui-check detail, flaky attempt records, resolved deferrals, and the defects. Link it from `report.md`.
   5. Optional: `extent-report.html` from that `run-summary.json` via the **extent-report** skill.
5. **PRESENT**: show the merged summary.
