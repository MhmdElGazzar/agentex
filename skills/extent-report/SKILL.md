---
name: extent-report
description: Produce a standalone, self-contained extent-report.html — a dark-themed interactive dashboard (donut chart, per-status stat cards, expandable test-case cards with step-by-step detail). Use at the end of any playwright-cli test execution (one test case or a full parallel/sequential batch) once final scenario results are known, alongside report.md.
---

# Extent Report — Testing Execution Status Dashboard

## Role
You turn a finished test run's results into an interactive HTML dashboard that sits next to
`report.md` in the execution folder. You do not re-run tests or judge pass/fail yourself — you
tally the results the run already produced.

## Statuses tracked
| Status | Meaning | Color |
|---|---|---|
| Passed | Scenario ran and met acceptance criteria | `#2E9E4F` (green) |
| Warning | Scenario passed with a caveat — a `ui-check:` reference-mode layout drift or an unconfident design-variant pick | `#EAC54F` (yellow) |
| Failed | Scenario ran and did NOT meet acceptance criteria | `#D6293E` (red) |
| Blocked | Scenario could not be completed (missing prerequisite, environment issue) | `#F2A93B` (orange) |
| View Mismatch | A `ui-check:` step whose baseline form factor differs from the run's target — no PASS/FAIL was issued | `#4D9DE0` (blue) |
| N/A - De-scoped | Scenario intentionally excluded from this run's scope | `#8B5CF6` (purple) |
| Not Run | Planned but never attempted this run | `#B0B0B0` (gray) |

Test Coverage = (Passed + Warning + Failed + Blocked + View Mismatch) ÷ Total # of TC —
scenarios actually exercised over the total planned. Total # of TC is the count of individual
test scenarios/steps executed across all specs in the run, not the count of spec files.

Note: executor reports only emit PASS/FAIL per scenario. Blocked, N/A-De-scoped, and Not Run
come from the orchestrator's own plan — scenarios that couldn't be attempted (environment/
prerequisite), were intentionally excluded from scope, or were planned but never reached.
Warning and View Mismatch come from `ui-check:` step verdicts (see the ui-check skill) —
they are first-class statuses, never disguised as `passed`/`blocked`. Flaky comes from the
browser-testing **Flake doctrine**: a scenario that failed on infrastructure and passed only
on its one retry. It is an unstable result, not a pass — never fold it into `passed`.

## Tool
The generator script lives in this skill's `scripts/` folder:
- **`${CLAUDE_PLUGIN_ROOT}/skills/extent-report/scripts/make_html_report.js`** — reads a JSON
  summary of the run and writes the standalone HTML dashboard. Run via
  `node ${CLAUDE_PLUGIN_ROOT}/skills/extent-report/scripts/make_html_report.js <input.json> <output.html>`.

## Steps
1. Tally results from every session's defect report: count of Passed, Failed, Blocked,
   N/A-De-scoped, Not-Run scenarios (plus Warning / View Mismatch / Flaky where the run
   produced them), and the Total # of TC (their sum).
2. Pick a descriptive report title — not just "Testing Execution Status" alone. Name the
   run/suite and the date, e.g. "Suite2 Regression — 2026-07-08" or "Login Sample — 2026-07-08".
3. Build — or receive from the browser-testing orchestrator, which writes it as a mandatory
   run artifact in both modes — the **persistent** run summary
   `executions/<run>/run-summary.json` (`schemaVersion: 2`; shape summary below, full field
   contract in `${CLAUDE_PLUGIN_ROOT}/skills/extent-report/references/run-summary-schema.md`),
   then generate the report from it:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/skills/extent-report/scripts/make_html_report.js \
     "executions/<run>/run-summary.json" \
     "executions/<run>/extent-report.html"
   ```
   Evidence paths in the JSON are relative to the run folder root (where the JSON lives) —
   the script base64-embeds them into the HTML at render time.
4. `run-summary.json` is a **retained artifact** — never delete it. It is the run's
   machine-readable record and the input the HTML can be regenerated from at any time.
5. Link both artifacts from `report.md` — add after the per-testcase narrative:
   `**Interactive report:** [extent-report.html](./extent-report.html)` and
   `**Run summary (JSON):** [run-summary.json](./run-summary.json)`.

### Input JSON shape
Full contract — every field, required-by-capture vs optional, the versioning policy, and a
complete example — lives in
`${CLAUDE_PLUGIN_ROOT}/skills/extent-report/references/run-summary-schema.md`. Read it before
composing the JSON. In short:

- Top level: `schemaVersion: 2`, `title`, `date`, `run` (execution context: start/end
  wall-clock timestamps, execution-time duration (human-wait excluded), mode, environment,
  target URL, login mode, session→spec map, preflight `tools` JSON),
  `summary` (status counts), `testCases`, optional `defects`.
- Status vocabulary (unchanged): `passed`/`failed`/`blocked`/`na`/`notrun` plus the ui-check
  statuses `warning`/`viewMismatch` and the execution status `flaky` for steps and test cases;
  `passed`/`failed`/`blocked`/`naDescoped`/`notRun` plus optional `warnings`/`viewMismatch`/
  `flaky` counts for the top-level summary (count key `warnings`, status key `warning` — the
  quirk is documented in the reference).
- Test cases carry `durationMs` (required for executed scenarios; execution time, like every
  duration in this schema), optional
  `startedAt`/`endedAt`/`session`, evidence `screenshots`, `flaky` attempt records, `blockedBy`
  causality, resolved `deferred` records; steps optionally carry `durationMs`, `evidence`,
  `integration` outcome summaries, and `uiCheck` detail. Every enriched field is optional to
  the renderer — it degrades gracefully, and a missing evidence file renders as a labeled
  placeholder, never a failure.
- A legacy-shape JSON (no `schemaVersion`) still renders exactly as it always did.

A test case's top-level `status` is the rollup (worst status among its steps: failed > blocked >
flaky > viewMismatch > warning > na > notrun > passed). A test case with one flaky step is a
flaky test case, however many of its other steps passed.

## Output placement
`run-summary.json` and `extent-report.html` both live at the run folder root next to
`report.md` (see the browser-testing skill's execution output layout). The HTML is fully
self-contained (inline CSS/JS, evidence base64-embedded, no external requests, no `file://`
references) and opens directly in a browser — moved to another machine alone, it still shows
every image. Never place either inside `browser-sessions/` or `bugs/` — those subfolders hold
session evidence, not run-level artifacts.

## Rules
- Never hand-edit the generated HTML — regenerate it from `run-summary.json` instead.
- Never write real user data into `testCases`/`steps` notes — use the same disposable values the
  test run itself used.
- Secrets: `run-summary.json` and the HTML carry user **handles** only (e.g. `expired_user`) —
  never credential values, and never `envSecret` target names, anywhere in the JSON or the
  HTML (not in `run`, notes, or `deferred` questions). `loginMode` is the mode word only.
