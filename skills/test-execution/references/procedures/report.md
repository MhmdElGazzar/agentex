# Procedure: report.md and bugs/

## report.md contains
- The active environment name.
- A tally line: pass / fail / blocked. FLAKY and NEEDS-USER are named in the line but never counted as pass or fail.
- The defect list, in the format below.
- An **Unstable results** section whenever any scenario is FLAKY.
- The link: `**Run summary (JSON):** [run-summary.json](./run-summary.json)`

## Defect format
- **Title**: concise, action-oriented
- **Steps to reproduce**: numbered, deterministic
- **Expected** vs **Actual**
- **Severity**: Critical / High / Medium / Low
- **Evidence**: screenshot filename or runner log path, console/network notes

## Unstable results (one entry per FLAKY scenario)
- The attempt-1 symptom, verbatim.
- Both attempts' evidence.
- What would settle it: re-run that spec. If it flakes again, the environment or the app is genuinely unstable.

A run that hides instability is worse than one that reports it: FLAKY is a finding, not a footnote.

## bugs/
- `bug-list.md`: proven defects only. FLAKY never goes here: nothing is proven yet.
- `screenshots/`: copy the evidence each executor flagged with `merge_run.js --run-dir <dir> <paths…>`.

## extent-report.html
FLAKY is the first-class `flaky` status with its own color and stat card. Never fold it into `passed` or `blocked`.
