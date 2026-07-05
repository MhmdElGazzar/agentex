---
description: Execute tests against a target, optionally from a named suite folder (e.g. suite3/). Sequential (human-in-the-loop) by default; say "parallel" for an autonomous run.
---

Use the **browser-testing** skill to test the target described below.

Target / scope: $ARGUMENTS

**Suite folder (if named in the arguments):**
- The arguments may name a suite folder, e.g. `suite3/`, `test/suite3/`, or "run suite3".
  Resolve a bare name like `suite3/` to `./test/suite3/`. Run ONLY the spec files in that
  folder (one `qa-executor` / session per file in parallel mode).
- If the named suite folder doesn't exist yet, create it and seed it with a starter spec
  copied from `${CLAUDE_PLUGIN_ROOT}/test/suite1/`, tell the user to adapt it, then continue.
- If no suite is named, use the specs the user points at, or default to `./test/suite1/`.

**Before running:**
- If the current project has no `test/` directory (or it has no spec files), scaffold a
  starting point first — run the same steps as `/init-test` (copy the bundled samples from
  `${CLAUDE_PLUGIN_ROOT}/test/suite1/` into `./test/suite1/` and ensure `./executions/`
  exists), tell the user they're editable examples, then continue.
- If `test/` already has the user's own specs, skip the scaffold and use theirs.

- If no mode is stated, use **sequential** mode (stop at each checkpoint for approval).
- If the request says parallel / fast / regression / autonomous, use **parallel** mode and
  dispatch one `qa-executor` subagent per test file.
- Read the skill's `references/playwright-cli.md` before the first browser action.
