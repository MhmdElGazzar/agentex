# AgenTeX

**Agentic Test eXecution for Claude Code, OpenAI Codex, and GitHub Copilot Agent mode.**

[![Version](https://img.shields.io/badge/version-0.22.0-blue.svg)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Playwright](https://img.shields.io/badge/Playwright-CLI-2EAD33.svg?logo=playwright&logoColor=white)](https://www.npmjs.com/package/@playwright/cli)

AgenTeX turns natural-language Markdown test specifications into real browser execution, evidence,
PASS / FAIL / BLOCKED results, and reports. A shared AgenTeX Core supplies the QA rules and
artifacts; thin runtime-specific entrypoints make it available in each supported host. It does
not generate a conventional Playwright test suite or modify your application's code.

Azure DevOps is **optional**. You can initialize a project, define flows, run one test or a
bounded parallel regression, and review screenshots and reports without Azure credentials.
KB questions work when a KB is configured. Story estimation, Azure Test Case creation, QA task
creation, and Azure Bug filing are separate, optional Azure-backed workflows.

## Quick Start

1. Choose your host: [Claude Code](./docs/getting-started.md),
   [Codex](./docs/codex.md), or [GitHub Copilot in VS Code Agent mode](./docs/copilot.md).
   Follow that guide to install/register AgenTeX and make its capabilities available.
2. In the application project, initialize AgenTeX. Add the browser dependency when prompted:
   `npm install -D @playwright/cli` and `npx playwright-cli install-browser chromium`.
3. Edit a sample Markdown spec under `test/suite1/`, or define a new flow with the agent.
   Select the target URL/environment and the exact spec or bounded scenario to run.
4. Ask your host to run that spec. Review `executions/execu_<timestamp>/report.md`,
   `run-summary.json`, `extent-report.html`, and the session evidence.

For example, ask: “Run `test/suite1/signup.md` against my configured QA environment.”
Use “run these saved specs in parallel” only when you want a bounded multi-spec run.
An Agent-mode host may ask you to approve the plan or browser actions before proceeding.

| Feature | How it works | Docs |
|---------|--------------|------|
| **Test execution** | An agent plans scenarios and runs each step through its driver — a real `playwright-cli` browser, your APIs, or your database (API/DB-only specs need no browser) — capturing evidence and reporting defects, sequential (approve each step) or parallel (one `qa-executor` subagent per spec file). | [test-execution](./docs/test-execution.md) |
| **Define flow** | `/define-flow` builds a spec by doing it: an agent-led session proposes each step, executes it live the moment you agree, and you assert the real outcome before the next step — the saved spec follows the normal conventions and runs unmodified via `/execute-test`. Point it at an existing spec to walk it through and clarify it. | [define-flow](./docs/define-flow.md) |
| **API & DB steps** | `api:` / `db:` scenario steps run **only** the named, parameterized requests/queries in your `integration/` catalog — the agent never composes its own SQL or HTTP; DDL is refused. | [api-db-steps](./docs/api-db-steps.md) |
| **Ask the KB** | `kb:` steps (or `/ask-kb`) query your project's KB Ask API for advisory context — informs testing, **never** used as PASS/FAIL evidence. | [ask-kb](./docs/ask-kb.md) |
| **UI check steps** | `ui-check:` scenario steps compare the live page against a design baseline — a Figma frame (identifier only; file + token configured once) or a screenshot — in `exact` or `reference` mode; verdicts, warnings, and view-mismatch errors land in the reports with both images as evidence. | [ui-check](./docs/ui-check.md) |
| **Optimize login** | Pay a web app's login once per session: drive it live, verify by landmark (never by URL), save the browser session, and reload it into a fresh browser to continue. | [optimize-login](./docs/optimize-login.md) |
| **Azure DevOps planning** | `/estimate-story` estimates QA effort and creates 5 `[Testing]` tasks per story; `/design-test` turns story ACs into linked test cases — both through bundled scripts over the ADO REST API (no `az` needed), validated fail-closed first, with **one** consolidated approval per flow. | [azure-devops](./docs/azure-devops.md) |
| **Azure DevOps bug filing** | After a run, `bug-report-azure` files found defects as ADO **Bugs** through bundled scripts over the ADO REST API (no `az` needed) — recommends severity/priority, validates every field against your project's real picklists, links each bug to its parent User Story, validates & attaches screenshots, optionally fails the related test case; all writes behind **one** approval, with an exact per-write ledger if anything fails partway. | [azure-devops](./docs/azure-devops.md) |
| **HTML report** | At the end of a run, generates a standalone, self-contained `extent-report.html` dashboard (donut chart, status cards, expandable per-test-case steps). | [extent-report](./docs/extent-report.md) |
| **Configuration** | Three homes, one each: `config/project.json` (project settings), `environments/<env>.json` (targets, users, integrations), and a secrets-only `.env` — legacy keys-only `.env` projects still work untouched. After a plugin update, `/update-agentex` migrates a project to the new conventions, carrying your values. | [configuration](./docs/configuration.md) |

## Supported runtimes

| Capability | Claude Code | Codex | GitHub Copilot Agent |
|---|---|---|---|
| Initialize AgenTeX | Yes | Yes | Yes |
| Execute a saved test | Yes | Yes | Yes |
| Sequential execution | Yes | Yes | Yes |
| Bounded parallel execution | Yes | Coordinator supported; [live worker host caveat](./docs/codex.md#parallel-runtime-limit-and-troubleshooting) | Yes |
| Define Flow | Yes | Yes | Yes |
| Ask KB (configured) | Yes | Yes | Yes |
| Estimate Story (Azure) | Yes | Yes | Yes |
| Design Test (Azure) | Yes | Yes | Yes |
| Bug Report Azure (approved) | Yes | Yes | Yes |
| Update AgenTeX | Yes | Yes | Yes |

Claude retains its slash commands; Codex and Copilot normally route natural-language requests
to installed skills. The three hosts share the core QA behavior but have different installation,
permission, and update mechanisms. See the runtime guides above for exact usage.

## How a run works

`Markdown spec → driver execution → screenshots/logs → PASS / FAIL / BLOCKED → report`

A sequential run keeps you in the loop. An explicitly requested parallel run assigns each
saved spec its own named browser session, runs at a bounded concurrency, combines results
deterministically, and closes only its owned sessions. **FAIL** means observed behavior did not
meet the test expectation; **BLOCKED** means an infrastructure or execution obstacle prevented
a trustworthy product verdict. A failure does not automatically create an Azure Bug.

See [Test Execution](./docs/test-execution.md) for spec examples and evidence layout,
[Define Flow](./docs/define-flow.md) for guided spec authoring, and
[Approvals](./docs/approval-model.md) for action boundaries. The [documentation index](./docs/README.md)
covers configuration, optional integrations, and troubleshooting.

## Contributing

New to the codebase? [Contributing](./docs/contributing/README.md) explains the architecture
and how to add a skill. Open issues and PRs on the
[GitHub repository](https://github.com/MhmdElGazzar/agentex).

## Contributors

- **Mohamed Elgazzar** — creator & maintainer
- **Marwah Zain**
- [**@mabdel130**](https://github.com/mabdel130) — `extent-report` skill (PR #1)
- **YoussefKhalilTester**
- **Hager-Helmy**

## License

MIT — see [LICENSE](./LICENSE).
