---
description: Run a standalone API endpoint test pass — sanity, regression, or all cataloged cases — independent of any browser test spec.
---

Use the **endpoint-testing** skill to run a standalone API suite.

Scope: $ARGUMENTS

**Resolve the scope:**
- Arguments may be `sanity`, `regression`, or `all`. Default to **`regression`** if no
  argument is given.
- If the argument doesn't match one of the three, ask the user to clarify rather than
  guessing.

**Before running:**
- If `./integration/` (the endpoint catalog) doesn't exist, stop and point the user at
  `/init-test` — there's nothing to run without cataloged entries.
- If `./integration/suites/` doesn't exist or has no `*.json` files, scaffold
  `sample_suite.json` from `${CLAUDE_PLUGIN_ROOT}/skills/endpoint-testing/templates/`
  (never overwrite an existing file), tell the user it's an editable example referencing the
  catalog's sample entries, and continue using it for this run.
- Create `./executions/execu_<YYYY-MM-DD_HH-MM-SS>/api-runs/<scope>/` for this run's output
  (plain directory creation — this is a flat run, not a multi-session tree).

**Run:**
- Dispatch the bundled **`api-executor`** agent, injecting `SCOPE` (the resolved scope),
  `CATALOG_DIR` (`./integration`), `SUITE_DIR` (`./integration/suites`), and `RUN_DIR` (the
  folder just created).
- Present its returned summary and defect list to the user when it completes.
