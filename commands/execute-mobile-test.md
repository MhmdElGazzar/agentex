---
description: Execute tests against a native mobile app (Android/iOS), optionally from a named suite folder (e.g. suite2/). Sequential (human-in-the-loop) by default; say "parallel" for an autonomous run.
---

Use the **mobile-testing** skill to test the app described below.

Target / scope: $ARGUMENTS

**Suite folder (if named in the arguments):**
- The arguments may name a suite folder, e.g. `suite2/`, `test/mobile-suite2/`, or "run
  suite2". Resolve a bare name like `suite2/` to `./test/mobile-suite1/` (first suite) or
  `./test/mobile-<name>/` for anything else named. Run ONLY the spec files in that folder (one
  `mobile-qa-executor` / device session per file in parallel mode).
- If the named suite folder doesn't exist yet, create it and seed it with a starter spec
  copied from `${CLAUDE_PLUGIN_ROOT}/test/mobile-suite1/`, tell the user to adapt it, then
  continue.
- If no suite is named, use the specs the user points at, or default to
  `./test/mobile-suite1/`.

**Environment (if named in the arguments):**
- "on uat" / "env uat" selects `environments/uat.json` as the active environment;
  otherwise the project's `defaultEnvironment` applies. An environment with no file is an
  error — list `environments/` and stop. The active environment's `mobile` block supplies the
  app path/package and device capabilities — there is no legacy fallback for mobile targets,
  so ask the user if it's missing rather than guessing.

**Before running:**
- If the current project has no `test/mobile-suite1/` directory (or it has no spec files),
  scaffold a starting point first — copy the bundled samples from
  `${CLAUDE_PLUGIN_ROOT}/test/mobile-suite1/` into `./test/mobile-suite1/` and ensure
  `./executions/` exists, tell the user they're editable examples, then continue.
- If `test/mobile-suite1/` already has the user's own specs, skip the scaffold and use theirs.

- If no mode is stated, use **sequential** mode (stop at each checkpoint for approval).
- If the request says parallel / fast / regression / autonomous, use **parallel** mode and
  dispatch one `mobile-qa-executor` subagent per test file — but only up to the number of
  devices/emulators actually available; confirm that count first.
- Run `node ${CLAUDE_PLUGIN_ROOT}/skills/mobile-testing/scripts/preflight.js` before the first
  device action, and read `references/appium-server-cli.md` (or
  `references/appium-client-wrapper.md` if the project already uses the bundled wrapper)
  before driving the app.
