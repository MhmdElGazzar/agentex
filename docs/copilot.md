# AgenTeX with GitHub Copilot Agent

The supported host is **VS Code GitHub Copilot Agent / Agent Host**. You need VS Code with
GitHub Copilot available and signed in, Agent mode enabled, Node.js, and `@playwright/cli`
plus Chromium for browser tests. AgenTeX uses eight user-facing skills; it is useful without
Azure DevOps.

## Register the local package

Obtain an AgenTeX Copilot package, then register its **package root** in VS Code's
`chat.pluginLocations` setting using a portable path such as `<agentex-package>`. If building
from this source distribution, the supported builder accepts a *new* output directory below
the repository's `executions/` directory:

```text
node copilot/scripts/build_package.js --out executions/agentex-copilot-package
node copilot/scripts/validate_package.js --package executions/agentex-copilot-package
```

Run these from `<agentex-root>` only when creating a package; do not overwrite an existing
output. Point `chat.pluginLocations` at that assembled package root, not at `copilot/`,
`core/`, an individual `SKILL.md`, or an internal VS Code cache. In Copilot Agent mode,
verify that AgenTeX is available and that its eight entry skills below are discoverable.
Reload the host if registration has changed. The assembled package contains its shared core;
parallel execution and update checks do **not** require a source-checkout fallback.

## Initialize and run

Open the *application project* and ask:

> Initialize AgenTeX in this project.

`agentex-init` first shows a read-only plan of the target project and created/skipped paths;
approve the named local writes before it initializes. The shared scaffold creates editable
spec examples, project/environment configuration, keys-only `.env`, integration samples,
`executions/`, and a version stamp where appropriate. Existing specs and `AGENTS.md` are
preserved. Set the target in `environments/<env>.json` and install the browser driver if needed:

```text
npm install -D @playwright/cli
npx playwright-cli install-browser chromium
```

Edit or create a Markdown spec, then ask “Run this AgenTeX test” while naming the exact spec
and target/environment. This is sequential and interactive by default. For multiple *saved*
specs, ask “Run these AgenTeX tests in parallel,” identifying the bounded files or suite and
target. The package uses the canonical shared coordinator with a Copilot-owned worker, unique
sessions, deterministic aggregation, and owned-session cleanup. Default concurrency is 2,
maximum 4; it never invokes a Codex worker for a Copilot run.

## Eight user-facing capabilities

| Skill | Example natural request | Boundary |
|---|---|---|
| `agentex-init` | “Initialize AgenTeX in this project.” | Approve the planned local writes. |
| `agentex-ask-kb` | “Ask the AgenTeX KB how this flow is expected to work.” | Requires KB configuration; advisory answer and sources. |
| `agentex-test` | “Run `test/suite1/<name>.md` with AgenTeX.” | Scope and target resolved before browser work. |
| `agentex-define-flow` | “Define a reusable AgenTeX flow for this scenario.” | Approve each step and the final save. |
| `agentex-estimate-story` | “Estimate QA for story 1234.” | Azure read/advice; task creation needs approval. |
| `agentex-design-test` | “Design test coverage for story 1234.” | Azure read/advice; Test Case creation needs approval. |
| `agentex-bug-report-azure` | “Prepare an Azure bug for this failure.” | Filing needs approval of an exact plan. |
| `agentex-update` | “Check whether AgenTeX needs an update.” | Check is read-only; refresh/migration are separate. |

These phrases are examples, not exact syntax. Users do not target `SKILL.md` manually. The
package's internal `core/skills/agentex-test/scripts/parallel.js` is a shared resource, not
a ninth user-facing skill.

## Results, updates, and troubleshooting

Run reports appear under `executions/execu_<timestamp>/` in the consumer project:
`report.md`, `run-summary.json`, `extent-report.html`, per-session `executor-result.json`,
screenshots/logs, and defect evidence where applicable. PASS means the expected behavior was
observed; FAIL is a product mismatch; BLOCKED means a reliable verdict was prevented by
infrastructure or execution trouble. A FAIL does not automatically file an Azure Bug.

`agentex-update` checks the registered package/core and project stamp without changing them.
A package refresh means building a new local package and re-registering its path; consumer
migration is a separate approved shared-migrator action requiring a clean Git tree. Neither
is implied by a check. Do not edit VS Code plugin caches or use Claude/Codex plugin commands
inside Copilot. The Copilot update adapter does not depend on a Claude update-command file.

If Agent mode or AgenTeX is unavailable, confirm Copilot sign-in, Agent mode, the
`chat.pluginLocations` package-root entry, package existence, and a host reload. A stale
registration may still point to an older package. For a BLOCKED run, check browser preflight,
target configuration, and session ownership; for parallel runs, verify that saved specs and
the packaged coordinator are present. Missing KB/Azure configuration affects only those
optional capabilities. See [Configuration](./configuration.md),
[Browser Testing](./test-execution.md), and [Approvals](./approval-model.md).
