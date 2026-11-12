# skills/

The abilities AgenTeX gives Claude. A **skill** is a folder with a `SKILL.md` file: its
`description:` tells Claude when to use it, and its body says how. Most skills also carry
`scripts/` (bundled Node scripts that do the exact, checkable work), `references/` (detail
read only when needed) and `templates/` (sample files copied into your project).

You don't call a skill by name. A slash command (from [`commands/`](../README.md#repository-layout))
runs one, or Claude picks the right one from your plain-English request.

## What's here

### Running tests

| Skill | What it does | Started by | User doc |
|-------|--------------|------------|----------|
| [test-execution](./test-execution/SKILL.md) | The test-run orchestrator: plans scenarios, routes each spec step to its driver (browser, API, DB, KB, UI check), runs sequential or parallel, writes the report. Also holds the CI gate, `scripts/ci_gate.js`. | `/execute-test` | [test-execution.md](../docs/test-execution.md) · [ci-quality-gate.md](../docs/ci-quality-gate.md) |
| [browser-driver](./browser-driver/SKILL.md) | Drives a real browser through `playwright-cli` for plain-prose spec steps: isolated sessions, screenshots, console evidence, retry vs defect. Not used on its own. | test-execution, `qa-executor` | [test-execution.md](../docs/test-execution.md) |
| [define-flow](./define-flow/SKILL.md) | Builds a spec by doing it: proposes each step, runs it live, you confirm it before the next. | `/define-flow` | [define-flow.md](../docs/define-flow.md) |
| [optimize-login](./optimize-login/SKILL.md) | Logs in once, saves the browser session, and reloads it for later tests. | `"login": { "mode": "session" }` | [optimize-login.md](../docs/optimize-login.md) |
| [ui-check](./ui-check/SKILL.md) | Runs `ui-check:` steps: compares the live page with a Figma frame or a screenshot. | a `ui-check:` step | [ui-check.md](../docs/ui-check.md) |
| [extent-report](./extent-report/SKILL.md) | Builds the self-contained `extent-report.html` dashboard at the end of a run. | end of every run | [extent-report.md](../docs/extent-report.md) |
| [browser-testing](./browser-testing/) | No `SKILL.md`: only an old copy of the CI gate path that forwards to `test-execution/scripts/ci_gate.js`, kept so older pipelines keep working. It will be removed in a later release. | old CI pipelines | [ci-quality-gate.md](../docs/ci-quality-gate.md) |

### Mobile

| Skill | What it does | Started by | User doc |
|-------|--------------|------------|----------|
| [mobile-testing](./mobile-testing/SKILL.md) | Tests native Android / iOS apps through Appium, sequential or one session per device. | `/execute-mobile-test` | [mobile-testing.md](../docs/mobile-testing.md) |

### API, database and knowledge base

| Skill | What it does | Started by | User doc |
|-------|--------------|------------|----------|
| [api-integration](./api-integration/SKILL.md) | Runs `api:` steps: only the requests defined in your `integration/*_api.json` catalog. | an `api:` step | [api-db-steps.md](../docs/api-db-steps.md) |
| [db-integration](./db-integration/SKILL.md) | Runs `db:` steps: only the queries defined in `integration/*_db.json` (SQL Server). DDL is refused. | a `db:` step | [api-db-steps.md](../docs/api-db-steps.md) |
| [endpoint-testing](./endpoint-testing/SKILL.md) | Runs every cataloged API test case in one pass; `--edit` opens the local suite editor. | `/test-endpoints` | [api-db-steps.md](../docs/api-db-steps.md) |
| [swagger-import](./swagger-import/SKILL.md) | Generates an API catalog and test suite from Swagger 2.0 / OpenAPI 3.x JSON; `--wizard` is the guided version. | `/import-swagger` | [api-db-steps.md](../docs/api-db-steps.md) |
| [ask-kb](./ask-kb/SKILL.md) | Asks your project's knowledge base. Advisory only, never PASS/FAIL evidence. | `/ask-kb`, a `kb:` step | [ask-kb.md](../docs/ask-kb.md) |

### Trackers and Azure (Azure DevOps or Jira Cloud)

| Skill | What it does | Started by | User doc |
|-------|--------------|------------|----------|
| [task-estimation](./task-estimation/SKILL.md) | Estimates QA effort per story and creates the `[Testing]` tasks from `config/estimation.json`. | `/estimate-story`, `/estimate-sprint` | [azure-devops.md](../docs/azure-devops.md) · [jira.md](../docs/jira.md) |
| [test-design](./test-design/SKILL.md) | Turns a story's acceptance criteria into linked test cases. | `/design-test` | [azure-devops.md](../docs/azure-devops.md) · [jira.md](../docs/jira.md) |
| [bug-report-azure](./bug-report-azure/SKILL.md) | Files a run's defects as tracker Bugs with screenshots, despite the name on Jira too. | "file the defects as bugs" | [azure-devops.md](../docs/azure-devops.md) · [jira.md](../docs/jira.md) |
| [tracker-ops](./tracker-ops/SKILL.md) | One-off board operations: move, comment, link, update, search. | "move PROJ-12 to Done" | [azure-devops.md](../docs/azure-devops.md) · [jira.md](../docs/jira.md) |
| [azure-integration](./azure-integration/SKILL.md) | Reads Azure resources (App Service, Storage, Key Vault, AKS) through the `az` CLI during a test. | "check the latest deployment" | [azure-devops.md](../docs/azure-devops.md) |

Every tracker write goes through **one** approval screen that lists every write first. CI mode
makes no tracker writes at all.

## Read next

- [docs/README.md](../docs/README.md): the user doc for every feature.
- [docs/contributing/adding-a-skill.md](../docs/contributing/adding-a-skill.md) and
  [writing-a-good-skill.md](../docs/contributing/writing-a-good-skill.md): how to add or change one.
- [docs/contributing/architecture.md](../docs/contributing/architecture.md): which skill relies on which.

## Don't

- **Don't add a `README.md` inside a skill folder.** `SKILL.md` is that skill's documentation;
  a second file drifts out of sync and ships with every install.
- **Don't put user-facing files in `scripts/*/golden/`.** Those folders hold test fixtures and
  are left out of every published host build.
