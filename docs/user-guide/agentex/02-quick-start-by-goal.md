# 2. Quick start by goal: "I want to…"

← [1. What is AgenTeX?](./01-what-is-agentex.md) · [Contents](./README.md) · Next: [3. Installation →](./03-installation.md)

Find your goal, run the command, then follow the link for the full step-by-step chapter.

| I want to… | Run or write | What happens | Chapter |
|------------|--------------|--------------|---------|
| **Test a website in a browser** | `/execute-test https://your-app.com` | Claude plans scenarios, you approve, it drives Chromium. | [6](./06-browser-testing.md) |
| **Test an Android / iOS app** | `/execute-mobile-test suite1` | Add a `mobile` block to your environment file, start Appium, run. | [9](./09-mobile-testing.md) |
| **Test APIs (no browser)** | `/test-endpoints` | Runs every case in your API suites and reports pass / fail per case. | [10](./10-api-testing.md) |
| **Generate API tests from Swagger** | `/import-swagger --wizard ./openapi.json` | A guided page that finds real test data and previews 4 checks per endpoint. | [10.5](./10-api-testing.md#105-generate-tests-from-swagger--openapi) |
| **Check the database after a UI action** | `db: sample-db.todo-by-title(title=qa-test-item)` | Add a `db:` line to a spec; only cataloged queries run. | [11](./11-database-checks.md) |
| **Write a spec without writing it** | `/define-flow https://your-app.com on uat` | Claude proposes each step, runs it live, you confirm. | [7](./07-define-flow.md) |
| **Work with Jira** | `/estimate-sprint` · `/design-test PROJ-12` | Sub-tasks with time tracking, test artifacts, bug filing. | [14](./14-jira-cloud.md) |
| **Work with Azure DevOps** | `/estimate-story 12345` · `/design-test 12345` | `[Testing]` tasks, Test Cases linked "Tested By", Bugs. | [15](./15-azure-devops.md) |
| **Compare the page with Figma** | `ui-check: figma 123:456 — mode: exact` | A spec step that compares the live page with a design. | [12](./12-ui-check.md) |
| **Stop logging in on every test** | `"login": { "mode": "session" }` | Log in once, save the session, reuse it (about 8 s instead of about 197 s). | [8](./08-optimize-login.md) |
| **Run tests in CI/CD** | `node <plugin-root>/skills/test-execution/scripts/ci_gate.js --suite test/suite1/ --env uat` | A headless gate with exit codes 0 / 1 / 2. | [17](./17-ci-quality-gate.md) |
| **File the bugs a run found** | "File the defects from the last run as bugs" | Validated fields, annotated screenshots, one approval. | [14.5](./14-jira-cloud.md#145-file-bugs-after-a-run) · [15.5](./15-azure-devops.md#155-file-bugs-after-a-run) |
| **Check Azure resources mid-test** | "Check if the latest deployment succeeded" | Read-only `az` CLI: App Service logs, Storage, Key Vault, AKS. | [15.6](./15-azure-devops.md#156-reach-azure-resources-mid-run) |
| **Ask the project knowledge base** | `/ask-kb how does checkout work?` | Advisory context, never pass/fail evidence. | [13](./13-knowledge-base.md) |

`<plugin-root>` is the folder where AgenTeX is installed; [3.8](./03-installation.md#38-running-bundled-scripts-yourself-the-plugin-path) shows how to find it.
