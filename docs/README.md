# AgenTeX Documentation

Detailed docs for each capability. Start with the [project README](../README.md) for install and a
quick tour.

| Doc | What it covers |
|-----|----------------|
| [Using Claude Code](./using-claude-code.md) | New to Claude Code itself? Start here — typing requests, slash commands, approving actions. |
| [Getting Started](./getting-started.md) | Install → browser driver → `/init-test` → permissions → first run. |
| [Browser Testing](./browser-testing.md) | The core flow — sequential vs. parallel modes, writing specs, output layout. |
| [Define Flow](./define-flow.md) | `/define-flow` — build a spec by doing it: each step executed live and asserted before the next is defined; also walks existing specs to clarify them. |
| [API & DB Steps](./api-db-steps.md) | Catalog-only `api:` / `db:` steps inside test scenarios. |
| [Ask the Knowledge Base](./ask-kb.md) | `kb:` steps and the `/ask-kb` command (advisory only). |
| [Optimize Login](./optimize-login.md) | Pay a web app's login cost once per session instead of once per test. |
| [Azure DevOps QA](./azure-devops.md) | `/estimate-story`, `/design-test`, `bug-report-azure` bug filing, and Azure resource access. |
| [Interactive HTML Report](./extent-report.md) | The standalone `extent-report.html` dashboard. |
| [CI Quality Gate](./ci-quality-gate.md) | Invoke runs from your CI/CD pipeline: the `ci_gate.js` entry point, exit-code semantics (0/1/2), the public verdict JSON contract, pipeline templates, advisory vs blocking modes. |
| [Configuration](./configuration.md) | Environment variables, permissions, and secret handling. |
