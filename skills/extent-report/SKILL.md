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
3. Build a temporary JSON file describing the run (shape below), then generate the report:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/skills/extent-report/scripts/make_html_report.js \
     "<run>.json" \
     "executions/<run>/extent-report.html"
   ```
4. Delete the temporary JSON input file afterward — it is not a retained artifact.
5. Link the HTML report from `report.md` — add a line after the per-testcase narrative:
   `**Interactive report:** [extent-report.html](./extent-report.html)`.

### Input JSON shape
One object per test case, one object per step. Status vocabulary: `passed`/`failed`/`blocked`/
`na`/`notrun` plus the ui-check statuses `warning`/`viewMismatch` and the execution status
`flaky` for steps and test cases; `passed`/`failed`/`blocked`/`naDescoped`/`notRun` plus
`warnings`/`viewMismatch`/`flaky` counts for the top-level summary (those last three keys are
optional — omit them for a run without `ui-check:` steps or flakes and the report renders
exactly as before).

```json
{
  "title": "<descriptive run name>",
  "date": "<date>",
  "summary": {"total":14,"passed":9,"failed":2,"blocked":2,"warnings":1,"viewMismatch":0,"flaky":1,"naDescoped":0,"notRun":0},
  "testCases": [
    {
      "name": "suite1-product-search",
      "spec": "test/suite1/product-search.md",
      "status": "failed",
      "steps": [
        {"desc":"Search common term 'shirt'","status":"passed","note":"13 product cards returned"},
        {"desc":"Search nonsense term 'zzzxqq'","status":"failed","note":"0 cards, no 'no results' text. See Defect #1."},
        {"desc":"ui-check: figma 12:34 — mode: reference","status":"warning","note":"enumerated details OK; sidebar drifted below the fold"}
      ]
    }
  ]
}
```

A test case's top-level `status` is the rollup (worst status among its steps: failed > blocked >
flaky > viewMismatch > warning > na > notrun > passed). A test case with one flaky step is a
flaky test case, however many of its other steps passed.

## Output placement
`extent-report.html` lives at the run folder root next to `report.md` (see the browser-testing
skill's execution output layout), fully self-contained (inline CSS/JS, no external requests), and
opens directly in a browser. Never place it inside `browser-sessions/` or `bugs/` — those
subfolders hold session evidence, not run-level artifacts.

## Rules
- Never hand-edit the generated HTML — regenerate it from the JSON summary instead.
- Never write real user data into `testCases`/`steps` notes — use the same disposable values the
  test run itself used.
