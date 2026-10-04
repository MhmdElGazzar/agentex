# AgenTeX with OpenAI Codex

Codex uses installed AgenTeX skills as its user-facing entrypoints and the same shared QA
core as Claude and Copilot. Ask in natural language; no Claude slash command is required.
Azure DevOps is optional for browser testing.

## Install and verify

You need Codex, Node.js, an AgenTeX plugin offered by a configured Codex marketplace,
and `@playwright/cli` plus Chromium for browser runs. If your marketplace is not configured,
ask its maintainer for the marketplace source. Codex accepts a local or Git marketplace:

```text
codex plugin marketplace add <marketplace-source>
codex plugin add agentex@<marketplace-name>
codex plugin list --json
```

Use the name returned by your marketplace; the placeholders are not literal paths or commands.
Start a fresh Codex session after installation or refresh. Confirm `agentex` appears in the
plugin list and the AgenTeX skills are available. Do not edit Codex's plugin cache. In the
application project, install the browser driver if it is missing:

```text
npm install -D @playwright/cli
npx playwright-cli install-browser chromium
```

Codex tool/sandbox permissions are managed by Codex, not by Claude's
`settings.example.json`. A blocked preflight or missing browser dependency is not a product FAIL.

## Initialize and run

Open the *application project* in Codex, not the AgenTeX plugin source, and ask:

> Initialize AgenTeX in this project.

The `agentex-init` skill uses the shared scaffold and, when configuration needs input,
the setup wizard. It creates editable sample specs, `config/project.json`, an environment
sample, keys-only `.env`, `integration/`, `executions/`, and a version stamp where appropriate.
It preserves existing specs and an existing `AGENTS.md` byte-for-byte; if none exists, the
current shared scaffold creates a short AgenTeX guidance file. Fill in your target URL in
`environments/<env>.json` before a real run. Azure fields can remain unset.

Then edit or create `test/suite1/<name>.md` and ask, for example:

> Run the AgenTeX spec `test/suite1/<name>.md` on my configured environment.

`agentex-test` runs one bounded assignment sequentially by default. For multiple saved
specs, explicitly ask:

> Run the saved AgenTeX specs in `test/suite1/` in parallel against my configured target.

Codex parallel execution accepts saved `# Spec:` Markdown files with a scenario section,
defaults to concurrency 2, and caps it at 4. It does not silently run your entire suite.
Every assignment has its own named browser session and cleanup. See
[Browser Testing](./test-execution.md) for spec format and PASS / FAIL / BLOCKED meanings.

## Parallel runtime limit and troubleshooting

AgenTeX's Codex coordinator supports bounded parallel assignments with isolated sessions
and deterministic aggregation. A worker crash, timeout, or missing `executor-result.json`
is **BLOCKED** for that assignment, never a silent PASS. Worker diagnostics are retained
without raw model or tool transcripts. A requested parallel run is not silently changed
to sequential execution.

In the tested Codex agent host, nested `codex` child-process launch sometimes failed with
`EPERM` before a child PID was created, even when the absolute `codex.exe` path was used.
This can stop live parallel workers from starting or lead to worker timeouts. The same
Codex CLI ran successfully from a normal terminal. Current evidence points to a host
nested-process restriction or instability; the exact cause of the original blocked run
is not conclusively established. Codex live parallel execution is therefore **not fully
certified in the tested host**. This is a host/runtime limitation observed during consumer
validation, not a confirmed AgenTeX defect or a claim that every Codex host fails.
In consumer validation, the same two saved PASS specs completed at `concurrency=1`
(two PASS, zero FAIL, zero BLOCKED). A `concurrency=2` run recorded one product FAIL
and two BLOCKED workers after timeouts. These results do not establish concurrency as
the cause of `EPERM`: a raw single-child launch also failed in the tested host.

If workers are **BLOCKED**, time out, report `EPERM` or `MISSING_RESOURCE`, or have no
`executor-result.json`, open the affected run's
`browser-sessions/<session>/logs/worker-stdout.log` and
`browser-sessions/<session>/logs/worker-stderr.log`. These files contain sanitized
process metadata and allowlisted signals, including outcome, exit code, byte counts,
and signal names. They do not contain raw model or tool transcripts. Check the session's
result and the run summary before assigning a product verdict. A missing result or worker
launch failure is **BLOCKED**, not a product FAIL.

Sequential Codex execution remains supported. You may explicitly choose `concurrency=1`
for a diagnostic or as a workaround when a host cannot run parallel workers; this is not
a permanent fix for the host condition. AgenTeX will not silently downgrade a requested
parallel run.

## Other capabilities

| Ask Codex | Skill | Notes |
|---|---|---|
| “Define a reusable AgenTeX flow for this scenario.” | `agentex-define-flow` | Propose, approve, execute, verify each step; approve the final spec before saving. |
| “Ask the AgenTeX KB how this flow works.” | `agentex-ask-kb` | Needs a configured KB; answers and sources are advisory. |
| “Estimate QA for story 1234.” | `agentex-estimate-story` | Optional Azure; the estimate is advisory, tasks require separate approval. |
| “Design test coverage for story 1234.” | `agentex-design-test` | Optional Azure; linked Test Cases require separate approval. |
| “Prepare an Azure bug for this failed test.” | `agentex-bug-report-azure` | Optional Azure; review the exact plan before filing. |
| “Check whether AgenTeX needs an update.” | `agentex-update` | Read-only check; refresh and project migration are separate approved actions. |

These are examples, not mandatory phrases. Story workflows use numeric IDs; a work-item URL
is not accepted by the current shared readers. No Azure Bug is created by a test FAIL alone.

## Results, updates, and troubleshooting

Normal runs write under `executions/execu_<timestamp>/`: `report.md`, `run-summary.json`,
`extent-report.html`, session `executor-result.json`, screenshots/logs, and `bugs/bug-list.md`
when defects are recorded. A Define Flow session is authoring; only an optional subsequent
validation run creates normal run evidence.

`agentex-update` checks installed/source/project versions using the Codex plugin listing.
Refreshing the plugin uses a scoped, approved Codex plugin install and should be verified in a
new session. Migrating a consumer project uses the shared migrator, requires a clean Git tree
and explicit approval, preserves user specs/config, and writes the project version stamp only
when migration completes without manual items. Merely asking to check does neither write.

If AgenTeX is not discovered, check the marketplace/plugin listing and restart the session.
If execution is BLOCKED, check the configured target, Node/browser preflight, Codex permissions,
and the named session; do not classify infrastructure loss as a product defect. If the KB or
Azure workflow is unavailable, check that *optional* integration's configuration—core browser
testing does not require either. See [Configuration](./configuration.md),
[Approvals](./approval-model.md), and [Azure DevOps QA](./azure-devops.md).
