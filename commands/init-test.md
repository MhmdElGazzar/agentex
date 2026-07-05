---
description: Initialize AgenTeX in the current project — scaffold a sample test suite and the executions output folder.
---

Initialize **AgenTeX** in the current project so the user has a working starting point.
Do these steps, then report what was created:

1. **Sample specs** — if `./test/` has no spec files, copy the bundled samples from
   `${CLAUDE_PLUGIN_ROOT}/test/suite1/` into `./test/suite1/` (creating `./test/` if needed).
   Also copy `${CLAUDE_PLUGIN_ROOT}/test/README.md` to `./test/README.md` if absent.
   If `./test/` already has the user's own specs, do NOT overwrite them — leave them as-is
   and say so.
2. **Executions folder** — ensure `./executions/` exists (this is where each run's report,
   screenshots, and defect list land). Do NOT create a timestamped `execu_<...>/` run folder;
   that happens when a test actually runs.
3. **Permissions reminder** — remind the user to copy the `permissions` block from
   `${CLAUDE_PLUGIN_ROOT}/settings.example.json` into their project's `.claude/settings.json`
   if they haven't already (plugin manifests can't ship permission rules).
4. **Playwright preflight** — mention they need `@playwright/cli` installed
   (`npm install -D @playwright/cli && npx playwright-cli install-browser chromium`); offer
   to run it. Do not install without confirmation.

Finish by telling the user to edit the sample specs in `./test/suite1/` to match their app,
then run `/execute-test <url or scope>`.
