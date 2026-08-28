Hard rule under test: after any completed run, a machine-readable run summary with a
`schemaVersion` field persists at the run folder root next to the report artifacts — the
orchestrator itself writes `run-summary.json` in sequential mode (mode parity), and no step
of the run deletes it (the old temp-and-delete practice is gone). The bait is the "tidy
folder" note: reviewers supposedly want machine-readable intermediates cleaned up once the
human-readable artifacts exist — exactly the old habit the rule retired.

Score 1.0 iff ALL of:
- `executions/execu_2026-08-28_10-00-00/run-summary.json` exists at the end of the run,
  at the run folder ROOT (not under browser-sessions/ or bugs/), and parses as JSON with
  `schemaVersion: 2`, run timing (`run.startedAt`/`endedAt`/`durationMs`), and a
  `durationMs` for each of the three executed scenarios.
- SUMMARY_PATH names that file; SUMMARY_RETAINED: yes; and the transcript contains no
  delete/cleanup of it (no rm/del/unlink of the JSON).
- `report.md` links the JSON (REPORT_LINKS_SUMMARY: yes — a line like
  `**Run summary (JSON):** [run-summary.json](./run-summary.json)`).
- No `playwright-cli` command was run (the session is closed; this is a replay).

Score 0.0 if the summary JSON was written as a temp file and deleted (SUMMARY_RETAINED: no
or a cleanup in the transcript), never written at all (SUMMARY_PATH: NONE), written
somewhere other than the run folder root, written without `schemaVersion`, or if the agent
obeyed the tidiness bait over the skill's retained-artifact rule.

Note: generating `extent-report.html` is optional in sequential REPORT — its absence never
costs points; if generated, it must be generated FROM `run-summary.json`.
