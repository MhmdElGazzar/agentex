---
description: Run the Website QA Agent against a target. Sequential (human-in-the-loop) by default; say "parallel" for an autonomous run.
---

Use the **website-qa** skill to QA-test the target described below.

Target / scope: $ARGUMENTS

- If no mode is stated, use **sequential** mode (stop at each checkpoint for approval).
- If the request says parallel / fast / regression / autonomous, use **parallel** mode and
  dispatch one `qa-executor` subagent per test file.
- Read the skill's `references/playwright-cli.md` before the first browser action.
