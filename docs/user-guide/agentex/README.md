# AgenTeX User Guide

Agentic test execution for browser, mobile, API, database, Jira and Azure DevOps, step by step
with real examples.

[All user guides](../README.md) · [PDF version](./agentex-user-guide.pdf) ·
Only testing mobile apps? See the [Mobile Testing User Guide](../mobile/README.md).

The whole framework, one markdown file per chapter: install, configuration, specs, browser,
mobile, API, database, UI check, knowledge base, Jira, Azure DevOps, reports, CI, git and
troubleshooting.

## Contents

| # | Chapter | Covers | Reference page |
|---|---------|--------|----------------|
| 1 | [What is AgenTeX?](./01-what-is-agentex.md) | Features, safety guarantees and what enforces them, run modes, all commands, how it fits together | [README](../../../README.md) |
| 2 | [Quick start by goal](./02-quick-start-by-goal.md) | "I want to…" → the command → the chapter | [docs/README](../../README.md) |
| 3 | [Installation and first setup](./03-installation.md) | Prerequisites, plugin, browser driver, `/init-test`, permissions, first 15 minutes, the plugin path | [getting-started](../../getting-started.md) · [using-claude-code](../../using-claude-code.md) |
| 4 | [Configuration](./04-configuration.md) | `envSecret`, `config/project.json`, `environments/<env>.json`, `.env` | [configuration](../../configuration.md) |
| 5 | [Writing test specs](./05-writing-test-specs.md) | Anatomy of a spec, step types, stateful chains, suites, result statuses | [test-execution](../../test-execution.md) |
| 6 | [Browser testing](./06-browser-testing.md) | Sequential and parallel runs, suite folders, output, tips | [test-execution](../../test-execution.md) |
| 7 | [Define flow](./07-define-flow.md) | Build a spec by doing it; clarify an existing spec | [define-flow](../../define-flow.md) |
| 8 | [Optimize login](./08-optimize-login.md) | Session mode, captcha / OTP, checking a saved session | [optimize-login](../../optimize-login.md) |
| 9 | [Mobile testing](./09-mobile-testing.md) | Appium install, the `mobile` block, mobile specs, running, device access | [mobile-testing](../../mobile-testing.md) |
| 10 | [API testing](./10-api-testing.md) | The catalog, `api:` steps, `/test-endpoints`, the suite editor, Swagger import | [api-db-steps](../../api-db-steps.md) |
| 11 | [Database checks](./11-database-checks.md) | Query catalog, sqlcmd, `db:` steps, safety rules | [api-db-steps](../../api-db-steps.md) |
| 12 | [UI check](./12-ui-check.md) | Figma or screenshot baselines, exact / reference modes, viewports | [ui-check](../../ui-check.md) |
| 13 | [Ask the knowledge base](./13-knowledge-base.md) | `kb:` steps and `/ask-kb` | [ask-kb](../../ask-kb.md) |
| 14 | [Jira Cloud](./14-jira-cloud.md) | Setup, estimation, test design, bug filing, limitations, troubleshooting | [jira](../../jira.md) |
| 15 | [Azure DevOps](./15-azure-devops.md) | Setup, estimation, test design, the ledger, bug filing, Azure resources | [azure-devops](../../azure-devops.md) |
| 16 | [Reports and evidence](./16-reports-and-evidence.md) | Run files, the defect format, the dashboard | [extent-report](../../extent-report.md) |
| 17 | [CI quality gate](./17-ci-quality-gate.md) | Exit codes, `ci_gate.js`, runner prerequisites, GitHub Actions, CI rules | [ci-quality-gate](../../ci-quality-gate.md) |
| 18 | [Git and security](./18-git-and-security.md) | What to commit, environment safety, the secret scan | [putting-your-project-in-git](../../putting-your-project-in-git.md) |
| 19 | [Keeping your project up to date](./19-keeping-up-to-date.md) | `/update-agentex` | [configuration](../../configuration.md) |
| 20 | [Troubleshooting and FAQ](./20-troubleshooting-and-faq.md) | Common problems, what is supported, FAQ | — |
| — | [Glossary](./glossary.md) | Every AgenTeX term in one table | — |
| — | [Cheat sheet](./cheat-sheet.md) | Every command on one page | — |

**Guide or reference page?** A guide chapter is the walkthrough: what to do, in order. The
reference page in the last column has every option and detail for that feature. When you
change how a feature works, update both.

To update this guide or re-export its PDF, see
[Updating a guide](../README.md#updating-a-guide).
