---
name: extent-report
description: Produce a standalone, self-contained extent-report.html — a dark-themed interactive dashboard (donut chart, per-status stat cards, expandable test-case cards with step-by-step detail) that visually matches extentreports.com's Spark reporter. Use at the end of any playwright-cli test execution (one test case or a full parallel/sequential batch) once final scenario results are known, alongside report.md.
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
| Failed | Scenario ran and did NOT meet acceptance criteria | `#D6293E` (red) |
| Blocked | Scenario could not be completed (missing prerequisite, environment issue) | `#F2A93B` (orange) |
| N/A - De-scoped | Scenario intentionally excluded from this run's scope | `#8B5CF6` (purple) |
| Not Run | Planned but never attempted this run | `#B0B0B0` (gray) |

Test Coverage = (Passed + Failed + Blocked) ÷ Total # of TC — scenarios actually exercised over
the total planned. Total # of TC is the count of individual test scenarios/steps executed across
all specs in the run, not the count of spec files.

Note: executor reports only emit PASS/FAIL per scenario. Blocked, N/A-De-scoped, and Not Run
come from the orchestrator's own plan — scenarios that couldn't be attempted (environment/
prerequisite), were intentionally excluded from scope, or were planned but never reached.

## Tool
The generator script lives in this skill's `scripts/` folder:
- **`${CLAUDE_PLUGIN_ROOT}/skills/extent-report/scripts/make_html_report.js`** — reads a JSON
  summary of the run and writes the standalone HTML dashboard. Run via
  `node ${CLAUDE_PLUGIN_ROOT}/skills/extent-report/scripts/make_html_report.js <input.json> <output.html>`.

## Steps
1. Tally results from every session's defect report: count of Passed, Failed, Blocked,
   N/A-De-scoped, Not-Run scenarios, and the Total # of TC (their sum).
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
`na`/`notrun` for steps; `passed`/`failed`/`blocked`/`naDescoped`/`notRun` keys for the top-level
summary.

```json
{
  "title": "<descriptive run name>",
  "date": "<date>",
  "summary": {"total":14,"passed":10,"failed":2,"blocked":2,"naDescoped":0,"notRun":0},
  "testCases": [
    {
      "name": "suite1-product-search",
      "spec": "test/suite1/product-search.md",
      "status": "failed",
      "steps": [
        {"desc":"Search common term 'shirt'","status":"passed","note":"13 product cards returned"},
        {"desc":"Search nonsense term 'zzzxqq'","status":"failed","note":"0 cards, no 'no results' text. See Defect #1."}
      ]
    }
  ]
}
```

A test case's top-level `status` is the rollup (worst status among its steps: failed > blocked >
na > notrun > passed).

## Output placement
`extent-report.html` lives at the run folder root next to `report.md` (see the browser-testing
skill's execution output layout), fully self-contained (inline CSS/JS, no external requests), and
opens directly in a browser. Never place it inside `browser-sessions/` or `bugs/` — those
subfolders hold session evidence, not run-level artifacts.

## Rules
- Never hand-edit the generated HTML — regenerate it from the JSON summary instead.
- Never write real user data into `testCases`/`steps` notes — use the same disposable values the
  test run itself used.
