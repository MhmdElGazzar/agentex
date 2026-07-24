---
description: Explore a website from multiple testing perspectives, triage findings by risk/priority/severity, design test cases for the critical/high ones, and execute them. Sequential (human-in-the-loop) by default; say "parallel"/"autonomous" for a hands-off run.
---

Use the **exploratory-testing** skill against the target below.

Target: $ARGUMENTS

**Suite folder this produces:**
- Derive `ProjectName` from the target's domain unless the user names one, and write the
  designed test cases into `test/explore_<ProjectName>/` (create it if it doesn't exist).
- This is a normal suite folder — one spec file per finding/flow — so it can also be re-run
  later with `/execute-test explore_<ProjectName>`.

**Before running:**
- If the current project has no `test/` directory yet, scaffold a starting point first — same
  steps as `/init-test` (copy the bundled samples from `${CLAUDE_PLUGIN_ROOT}/test/suite1/` into
  `./test/suite1/` and ensure `./executions/` exists), tell the user they're editable examples,
  then continue with the exploration.

- If no mode is stated, use **sequential** mode (stop at the SCOPE, EXPLORE, TRIAGE, and DESIGN
  checkpoints for approval before EXECUTE runs).
- If the request says parallel / fast / autonomous, run end to end and present the final report.
- Read the skill's charter and risk-priority-severity references before EXPLORE, and
  `skills/browser-testing/references/playwright-cli.md` before the first browser action.
