---
name: test-endpoints
description: "Run the standalone API test pass (\"api-tests\") over every cataloged case, independent of any browser test spec."
disable-model-invocation: true
---

> **AgenTeX on OpenAI Codex.** `<agentex-root>` stands for this plugin's install folder: `../..` from the folder this file is in. Resolve it to an absolute path before you run or read anything that uses it. When a step says to dispatch a bundled agent (`qa-executor`, `api-executor`, `mobile-qa-executor`), spawn a native subagent and give it the body of `<agentex-root>/references/agents/<name>.md` as its instructions, plus the values this file says to inject. Steps that reach the network (`curl`, `az`, `sqlcmd`, `playwright-cli` on a remote site, the tracker scripts) need network access: if the sandbox blocks one, ask the user to approve it; never skip the step or report it as passed.

Use the **endpoint-testing** skill to run the standalone API tests.

Arguments (unused — this command takes none): (the argument text the user typed after the command's name)

**Before running:**
- If `./integration/` (the endpoint catalog) doesn't exist, stop and point the user at
  `$agentex:init-test` — there's nothing to run without cataloged entries.
- If `./integration/api_test_suites/` doesn't exist or has no `*_suite.json` files (searched
  recursively), scaffold `sample_suite.json` from
  `<agentex-root>/skills/endpoint-testing/templates/` (never overwrite an existing
  file), tell the user it's an editable example referencing the catalog's sample entries, and
  continue using it for this run.
- Create `./executions/execu_<YYYY-MM-DD_HH-MM-SS>/api-tests/` for this run's output (plain
  directory creation — this is a flat run, not a multi-session tree).

**Run:**
- Dispatch the bundled **`api-executor`** agent, injecting `CATALOG_DIR` (`./integration`),
  `SUITE_DIR` (`./integration/api_test_suites`), and `RUN_DIR` (the folder just created).
  Every case in every suite file runs — there's no scope to resolve.
- Present its returned summary and defect list to the user when it completes.
