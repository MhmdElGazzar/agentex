---
description: Run the standalone API test pass ("api-tests") over every cataloged case, independent of any browser test spec.
---

Use the **endpoint-testing** skill to run the standalone API tests.

Arguments: $ARGUMENTS

**Parse the arguments:** optional environment — `--env <name>`, `env: <name>` or "on <name>"
selects `environments/<name>.json` (same as `/execute-test`); omitted = the project's
`defaultEnvironment`. Anything else is ignored.

**Before running:**
- If `./integration/` (the endpoint catalog) doesn't exist, stop and point the user at
  `/init-test` — there's nothing to run without cataloged entries.
- If `./integration/api_test_suites/` doesn't exist or has no `*_suite.json` files (searched
  recursively), scaffold `sample_suite.json` from
  `${CLAUDE_PLUGIN_ROOT}/skills/endpoint-testing/templates/` (never overwrite an existing
  file), tell the user it's an editable example referencing the catalog's sample entries, and
  continue using it for this run.
- Create `./executions/execu_<YYYY-MM-DD_HH-MM-SS>/api-tests/` for this run's output (plain
  directory creation — this is a flat run, not a multi-session tree).

**Run:**
- Dispatch the bundled **`api-executor`** agent, injecting `CATALOG_DIR` (`./integration`),
  `SUITE_DIR` (`./integration/api_test_suites`), `RUN_DIR` (the folder just created), and
  `ENV_NAME` (the parsed environment, or empty). Every case in every suite file runs —
  there's no scope to resolve — except cases carrying `skip` or no `expect`, which the runner
  reports BLOCKED without executing.
- Present its returned summary and defect list to the user when it completes.
