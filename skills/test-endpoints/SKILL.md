---
name: test-endpoints
description: "Run the standalone API test pass (\"api-tests\") over every cataloged case, independent of any browser test spec. --edit opens the local suite editor."
disable-model-invocation: true
---

> **AgenTeX on Devin.** `<agentex-root>` stands for this plugin's install folder: `../..` from the folder this file is in. Resolve it to an absolute path before you run or read anything that uses it. When a step says to dispatch a bundled agent (`qa-executor`, `api-executor`, `mobile-qa-executor`), start it as a subagent; ask the user anything you need before dispatching, because subagents cannot ask.

Use the **endpoint-testing** skill to run the standalone API tests.

Arguments: (the argument text the user typed after the command's name)

**Editor form — `--edit [--lang=ar|en]`:** open the local suite editor instead of running.
Follow `<agentex-root>/skills/endpoint-testing/references/suite-editor.md`. The editor
needs no agent; its Run goes through `run_suite.js` directly. Every other form below is
unchanged.

**Parse the arguments:** optional environment — `--env <name>`, `env: <name>` or "on <name>"
selects `environments/<name>.json` (same as `/agentex:execute-test`) for the whole run; omitted = the
project's `defaultEnvironment`. Its `api` block targets the catalogs that follow the
environment — `"target": "environment"`, or no `target` and a `baseUrl` that is absent or
exactly `${API_BASE_URL}`; a catalog with `"target": "catalog"` (every `swagger-import`ed one)
or no `target` and any other `baseUrl` keeps its own base URL and auth either way.
Anything else is ignored.

**Before running:**
- If `./integration/` (the endpoint catalog) doesn't exist, stop and point the user at
  `/agentex:init-test` — there's nothing to run without cataloged entries.
- If `./integration/api_test_suites/` doesn't exist or has no `*_suite.json` files (searched
  recursively), scaffold `sample_suite.json` from
  `<agentex-root>/skills/endpoint-testing/templates/` (never overwrite an existing
  file), tell the user it's an editable example referencing the catalog's sample entries, and
  continue using it for this run.
- Create `./executions/execu_<YYYY-MM-DD_HH-MM-SS>/api-tests/` for this run's output (plain
  directory creation — this is a flat run, not a multi-session tree).

**Run:**
- Dispatch the bundled **`api-executor`** agent, injecting `CATALOG_DIR` (`./integration`),
  `SUITE_DIR` (`./integration/api_test_suites`), `RUN_DIR` (the folder just created), and
  `ENVIRONMENT` (the parsed environment; `""` when not given). Every case in every suite file
  runs — there's no scope to resolve — except cases carrying `skip` or no `expect`, which the
  runner reports BLOCKED without executing.
- The agent passes a non-empty `ENVIRONMENT` to `run_suite.js` as `--env`, which reaches every
  case's `run_api.js` call. An unknown name comes back BLOCKED per case, listing the
  environments that exist — report it, never retry with another environment.
- Present its returned summary and defect list to the user when it completes.
