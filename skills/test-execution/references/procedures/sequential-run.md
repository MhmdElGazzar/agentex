# Procedure: sequential run (human-in-the-loop)
Stop at every ⏸. Continue only after an explicit "go" / "approved".

1. **UNDERSTAND**: restate what we are testing and the acceptance criteria in your own words. ⏸ Wait for the user to confirm scope.
2. **PLAN**: list the scenarios (happy path, edge cases, negative cases) as a numbered plan. Do not run any step yet. ⏸ Wait for the user to approve the plan.
3. **EXECUTE**
   - Before the first step, run `init_run.js` (no `--sessions`). It creates `executions/execu_<timestamp>/` and this run's one session name.
   - Browser runs: prefix every `playwright-cli` command with `-s=<that name>`. Never run a bare, default-session command.
   - Record the run start, and each scenario's start and end, per `run-record.md`. Pause the clock across every user interaction.
   - Run scenarios one at a time. After each one, report PASS/FAIL with evidence (screenshot for browser steps, runner log for `api:`/`db:`) and observed vs. expected.
   - Handle a failure with the *Retry or not?* table in SKILL.md. ⏸ Pause after each scenario.
4. **REPORT**
   - Save evidence under `browser-sessions/<session>/` in the run folder.
   - Write `report.md` and `bugs/` per `report.md`.
   - Browser runs: close your session with `-s=<session> close`. Never `close-all` / `kill-all`.
   - Record the run end. Write `run-summary.json` yourself per `run-record.md`, and link it from `report.md`.
   - Optional: generate `extent-report.html` next to `report.md` from that `run-summary.json` via the **extent-report** skill.
