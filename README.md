# AgenTeX

**Agentic QA for Claude Code — an agent plans, runs, and reports your tests so you don't click through them by hand.**

[![Version](https://img.shields.io/badge/version-0.8.1-blue.svg)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-8A2BE2.svg)](https://docs.anthropic.com/en/docs/claude-code)
[![Playwright](https://img.shields.io/badge/Playwright-CLI-2EAD33.svg?logo=playwright&logoColor=white)](https://www.npmjs.com/package/@playwright/cli)
[![Azure DevOps](https://img.shields.io/badge/Azure%20DevOps-integration-0078D7.svg?logo=azuredevops&logoColor=white)](https://azure.microsoft.com/en-us/products/devops)

AgenTeX (Agentic Test eXecution) takes manual test execution off your plate. Instead of clicking the
same scenarios by hand, an agent plans them, drives a **real browser** via
[`@playwright/cli`](https://www.npmjs.com/package/@playwright/cli), captures screenshot/log evidence,
and produces a consolidated defect report — either **sequentially** (human-in-the-loop) or in
**parallel** (autonomous, one session per spec file). It **never modifies your application code**.

## [Getting Started](./docs/getting-started.md)

New here? **[Getting Started](./docs/getting-started.md)** walks you through install → browser driver
→ `/init-test` → permissions → first run. The short version:

```
/plugin marketplace add MhmdElGazzar/elgazzar-plugins
/plugin install agentex@elgazzar-plugins
/init-test
/execute-test https://example.com
```

## Features — how each one works

| Feature | How it works | Docs |
|---------|--------------|------|
| **Browser testing** | An agent plans scenarios, drives a real `playwright-cli` browser, screenshots each one, and reports defects — sequential (approve each step) or parallel (one `qa-executor` subagent per spec file). | [browser-testing](./docs/browser-testing.md) |
| **API & DB steps** | `api:` / `db:` scenario steps run **only** the named, parameterized requests/queries in your `integration/` catalog — the agent never composes its own SQL or HTTP; DDL is refused. | [api-db-steps](./docs/api-db-steps.md) |
| **Ask the KB** | `kb:` steps (or `/ask-kb`) query your project's KB Ask API for advisory context — informs testing, **never** used as PASS/FAIL evidence. | [ask-kb](./docs/ask-kb.md) |
| **Azure DevOps planning** | `/estimate-story` estimates QA effort and creates 5 `[Testing]` tasks per story; `/design-test` turns story ACs into linked test cases — both via the `az` CLI, with confirmation. | [azure-devops](./docs/azure-devops.md) |
| **Azure DevOps bug filing** | After a run, `bug-report-azure` files found defects as ADO **Bugs** via the `az` CLI — recommends severity/priority, links each to its parent User Story, validates & attaches screenshots, optionally fails the related test case; all behind one confirmation. | [azure-devops](./docs/azure-devops.md) |
| **HTML report** | At the end of a run, generates a standalone, self-contained `extent-report.html` dashboard (donut chart, status cards, expandable per-test-case steps). | [extent-report](./docs/extent-report.md) |
| **Configuration** | A keys-only `.env` drives targets and integrations; catalog files hold only env-var *names*, so secrets stay in the environment. | [configuration](./docs/configuration.md) |

See [docs/](./docs/) for the full reference on any feature.

## Usage at a glance

```
# Sequential (human-in-the-loop) — natural language:
Test https://example.com — the signup form: happy path plus empty and bad-email cases.

# Parallel (autonomous) — one subagent per spec file:
Run a parallel regression against https://example.com from the specs in test/suite1/.

# Slash commands:
/execute-test https://example.com
/estimate-story 12345 12346
/design-test 12345
/ask-kb acme-store: how does the checkout flow work?
```

Every run writes to a timestamped `executions/execu_<timestamp>/` folder — `report.md`,
`extent-report.html`, per-session logs/screenshots, and a merged bug list.

## Contributing

Contributions are welcome. Each capability is a self-contained skill under `skills/<name>/`
(a `SKILL.md` orchestrator plus `references/`, `scripts/`, `templates/`), surfaced by a thin command
in `commands/`. Open issues and PRs on the
[GitHub repository](https://github.com/MhmdElGazzar/elgazzar-plugins). Keep the plugin generic — no
employer- or project-specific data; use the neutral placeholders in [`.env.example`](./.env.example).
Run the bundled script tests (e.g. `node skills/ask-kb/scripts/ask_kb.test.js`) before submitting.

## Contributors

- **Mohamed Elgazzar** — creator & maintainer
- **Marwah Zain**
- [**@mabdel130**](https://github.com/mabdel130) — `extent-report` skill (PR #1)
- **YoussefKhalilTester**
- **Hager-Helmy**

## License

MIT — see [LICENSE](./LICENSE).
