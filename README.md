# AgenTeX — agentic test execution for Claude Code

**AgenTeX** (Agentic Test eXecution) takes the hassle of **manual test execution** off your
plate. Instead of clicking through the same scenarios by hand, an agent plans them, runs them,
captures screenshot/log evidence, and produces a consolidated defect report — either
**sequentially** (human-in-the-loop, approving each step) or in **parallel** (autonomous, one
session per test file).

The agent **never modifies your application code** — it only writes test artifacts.

### What works today

| Capability | Status |
|-----------|--------|
| **Browser test execution** — drives a real browser via [`@playwright/cli`](https://www.npmjs.com/package/@playwright/cli) | ✅ Available |
| **Azure resource access** — reach Azure resources mid-run via the `az` CLI | ✅ Available (helper skill) |
| **Azure DevOps QA planning** — estimate sprint stories & create `[Testing]` tasks | ✅ Available (helper skill) |
| **Azure DevOps test design** — analyze story ACs & create linked test cases | ✅ Available (helper skill) |
| **API & DB steps in tests** — cataloged API calls & SQL checks mid-run (`integration/`) | ✅ Available |
| **KB questions in tests** — ask your project's knowledge base mid-run (`kb:`), advisory only | ✅ Available |
| **Standalone API & database test suites** | 🚧 Planned |

Most of this README covers the **browser-testing** flow — the core of AgenTeX today. For the
Azure DevOps estimation flow, see [QA task estimation](#qa-task-estimation-on-azure-devops).

## Quick start

```
/plugin marketplace add MhmdElGazzar/elgazzar-plugins
/plugin install agentex@elgazzar-plugins
```

Then, in the project you want to test: `/init-test` to scaffold sample specs, and
`/execute-test https://example.com` to run. See [One-time setup](#one-time-setup-in-the-project-you-want-to-test) for the Playwright + permissions steps.

## QA task estimation on Azure DevOps

`/estimate-story` analyzes your sprint's User Stories, proposes an hours estimate per story
(based on scenarios, fields, validations, integrations…), and — after you confirm each one —
creates 5 `[Testing]` tasks on it (Requirement Review, Test Creation, Test Execution,
Bug Review & Retest, Automation), iteration-inherited and assigned.

One-time setup:

1. Azure CLI + DevOps extension: install `az` (see `skills/azure-integration/references/azure-cli.md`),
   then `az extension add --name azure-devops`.
2. Fill the `AZURE_*` keys in `.env` (`/init-test` scaffolds it keys-only): organization URL,
   project, team, default assignee.
3. Auth: `az login`, or for non-interactive use export a PAT in your shell:
   `export AZURE_DEVOPS_EXT_PAT=<your-pat>` (never committed, never printed by the agent).

Then run `/estimate-story` for the current sprint, or `/estimate-story 12345 12346` for
specific stories. The agent processes **one story at a time** and never creates tasks without
your confirmation.

## Jira & Confluence (Atlassian ACLI)

Three skills cover Atlassian Cloud, and the agent picks between them by what your request
touches: **`jira-acli`** for Jira-only work, **`confluence-acli`** for Confluence-only, and
**`jira-confluence-integration`** only when a workflow genuinely spans both.

One-time setup:

1. Install Atlassian's official CLI — a single binary, direct download, no package manager.
   See <https://developer.atlassian.com/cloud/acli/guides/install-acli/>; verify with
   `acli --help`. This is Atlassian's own `acli`, not the community `jira-cli` or Appfire's CLI.
2. Fill `JIRA_SITE`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` in `.env` (create the token at
   <https://id.atlassian.com/manage-profile/security/api-tokens>). The agent pipes the token
   over stdin and never puts it on a command line.
3. Log in **per product** — Jira and Confluence authenticate separately even on the same site
   and with the same token:
   ```
   acli jira auth login --site "$JIRA_SITE" --email "$JIRA_EMAIL" --token   # token via stdin
   acli confluence auth login --site "$JIRA_SITE" --email "$JIRA_EMAIL" --token
   ```
   Confirm with `acli jira auth status` and `acli confluence auth status`. Jira access does not
   prove Confluence access; Confluence also needs a Confluence licence on the site.

**Know what ACLI cannot do** before planning around it — these are gaps in the tool, verified
live, and each skill states them up front: no attachment **upload**, no story-points or
custom-field writes, no Confluence page **create/update** (read-only) and no CQL command, and
no Jira remote-link support (so a Jira↔Confluence backlink can't be created ACLI-only). The
skills report these plainly rather than substituting another tool.

## What's inside

| Component | File | Purpose |
|-----------|------|---------|
| Skill | `skills/browser-testing/SKILL.md` | The orchestrator workflow — modes, output layout, defect format, rules |
| Skill | `skills/azure-integration/SKILL.md` | Reach Azure resources during a run via the `az` CLI |
| Skill | `skills/task-estimation/SKILL.md` | Estimate QA effort and create `[Testing]` tasks on Azure DevOps stories |
| Skill | `skills/test-design/SKILL.md` | Analyze story ACs into test conditions; create & link test cases in ADO |
| Skill | `skills/api-integration/SKILL.md` | Execute cataloged API calls in test steps (`api:`) via a runner script |
| Skill | `skills/db-integration/SKILL.md` | Execute cataloged DB queries in test steps (`db:`) via a runner script |
| Skill | `skills/ask-kb/SKILL.md` | Ask the project's KB Ask API in test steps (`kb:`) for advisory answers (never evidence) |
| Skill | `skills/extent-report/SKILL.md` | Interactive HTML dashboard (`extent-report.html`) for a finished run |
| Skill | `skills/jira-acli/SKILL.md` | Operate Jira Cloud via Atlassian's official `acli jira` — search, create, edit, transition, link, bulk workflows |
| Skill | `skills/confluence-acli/SKILL.md` | Operate Confluence Cloud via `acli confluence`, with an official-REST fallback for gaps ACLI doesn't cover |
| Skill | `skills/jira-confluence-integration/SKILL.md` | Orchestrate cross-product workflows (audit relationships, publish reports, link specs to work items) between the two ACLI skills |
| Agent | `agents/qa-executor.md` | Subagent that runs one test spec in its own isolated browser session |
| Reference | `skills/browser-testing/references/playwright-cli.md` | The browser driver — setup & gotchas |
| Reference | `skills/azure-integration/references/azure-cli.md` | `az` CLI — install/auth/common commands |
| Reference | `skills/azure-integration/references/azure-devops-cli.md` | `az boards` / `az devops` basics — shared by the ADO skills |
| Reference | `skills/test-design/references/test-case-mechanics.md` | Test Case creation — Steps XML, linking direction, gotchas |
| Template | `skills/test-design/templates/test-template.md` | Project conventions template — scaffolded to `.agentex/` in your project |
| Reference | `skills/api-integration/references/api-requests.md` | Runner usage + curl fallback for cataloged API requests |
| Reference | `skills/db-integration/references/sqlcmd.md` | Runner usage + sqlcmd (SQL Server) for cataloged queries |
| Reference | `skills/ask-kb/references/kb-ask-api.md` | KB Ask API contract, result handling & curl fallback |
| Reference | `skills/jira-acli/references/official-acli.md` | `acli jira` — install/auth, discovery, JQL, mutations, bulk safeguards, troubleshooting |
| Reference | `skills/confluence-acli/references/official-confluence.md` | `acli confluence` — dated command/limitation snapshot, page-tree discovery, REST endpoint map, CQL |
| Reference | `skills/jira-confluence-integration/references/identity-and-auth.md` | Multi-site identity & credential boundaries across Jira + Confluence |
| Reference | `skills/jira-confluence-integration/references/linking-patterns.md` | Stable Jira↔Confluence relationship and backlink patterns |
| Reference | `skills/jira-confluence-integration/references/workflow-recipes.md` | Release reports, spec-to-work-items, status pages, postmortems |
| Scripts | `skills/*/scripts/*.js` | Deterministic runners & helpers: `run_api`, `run_db`, `ask_kb`, `preflight`, `init_run`, `merge_run` |
| Script | `skills/confluence-acli/scripts/confluence_rest.ps1` | Guarded REST fallback for Confluence operations `acli confluence` doesn't expose |
| Templates | `skills/{api,db}-integration/templates/sample_{api,db}.json` | Catalog samples — scaffolded to `integration/` in your project |
| Script | `skills/extent-report/scripts/make_html_report.js` | Standalone HTML dashboard generator (run via `node`) |
| Command | `commands/init-test.md` | `/init-test` — scaffold sample specs + `executions/` in your project |
| Command | `commands/execute-test.md` | `/execute-test <url or scope>` — run the tests |
| Command | `commands/ask-kb.md` | `/ask-kb <question>` — ask the project's Knowledge Base a question (advisory only) |
| Command | `commands/estimate-story.md` | `/estimate-story [ids]` — estimate & create QA tasks on ADO stories |
| Command | `commands/design-test.md` | `/design-test <ids>` — design & create linked test cases on ADO stories |
| Permissions | `settings.example.json` | Recommended permission rules to copy into your project |
| Example specs | `test/suite1/` | Ready-to-adapt sample test specs — one file per browser session |
| Output | `executions/` | Where each run's report, screenshots & defect list land (auto-created) |
| Config | `.env.example` | Optional operational values (target URL, Azure DevOps) |

## Install

AgenTeX installs through the **`elgazzar-plugins`** marketplace — that's the one path to use.
From Claude Code:

```
/plugin marketplace add MhmdElGazzar/elgazzar-plugins
/plugin install agentex@elgazzar-plugins
```

> **Developing or testing a local clone?** Point the marketplace at your local copy of the
> `elgazzar-plugins` repo instead of GitHub, then install the same way:
> ```
> /plugin marketplace add /path/to/elgazzar-plugins
> /plugin install agentex@elgazzar-plugins
> ```
> (`/plugin marketplace add` needs a repo that contains `.claude-plugin/marketplace.json`,
> which is the `elgazzar-plugins` repo — not this plugin repo.)

## One-time setup in the project you want to test

1. **Playwright CLI** (the agent will offer to do this, or run it yourself):
   ```
   npm install -D @playwright/cli
   npx playwright-cli install-browser chromium
   ```
2. **Permissions** — plugin manifests can't ship permission rules, so copy the `permissions`
   block from [`settings.example.json`](./settings.example.json) into your project's
   `.claude/settings.json` (merge with anything already there). This pre-approves the safe
   `playwright-cli` commands and denies secret reads / destructive actions.

## Usage

- **Sequential (default, human-in-the-loop):**
  > Test https://example.com — the signup form: happy path plus empty and bad-email cases.

  The agent restates scope, proposes a numbered plan, and pauses for your approval at each
  checkpoint, capturing a screenshot per scenario.

- **Parallel (autonomous):** put one test spec per file in a `test/` directory
  (see the ready-made examples in [`test/suite1/`](./test/suite1/)), then:
  > Run a parallel regression against https://example.com from the specs in `test/suite1/`.

  It spawns one `qa-executor` subagent per file (each in its own `-s=<session>`) and merges the
  results.

- Or use the commands: `/init-test` once to scaffold sample specs, then
  `/execute-test https://example.com` to run.

### Writing your own specs

Start from the examples in [`test/suite1/`](./test/suite1/) — see
[`test/README.md`](./test/README.md) for how specs are organized (one file per browser
session, group files into suite folders, keep stateful flows in one file). Each spec is
plain language: a target, acceptance criteria, and numbered happy/edge/negative scenarios.

**One spec file = one browser session.** In parallel mode the orchestrator dispatches one
`qa-executor` subagent per file in the suite, each in its own isolated session, then merges
their defect lists into a single report. Here's a real spec — [`test/suite1/signup-form.md`](./test/suite1/signup-form.md):

```markdown
# Spec: Signup form validation

Target: https://example.com/signup   <!-- edit to your app's signup page -->
Type: form validation — NO real account is created (validation-only)

## Acceptance criteria
- Valid input reaches a visible success/confirmation state.
- Invalid input is rejected with a specific, visible error message; the form must not submit.
- No console errors or failed network calls during any scenario.

## Scenarios
1. **Happy path** — fill Name, a disposable email (`qa.tester@example.com`), and a valid
   password, then submit. Expect a visible success confirmation (verify computed visibility,
   not just DOM presence). Do NOT complete real account creation.
2. **Empty required fields** — submit with every field blank. Expect an inline "required"
   error on each field; the form must not submit.
3. **Bad email format** — enter `not-an-email` and submit. Expect a specific email-format error.
4. **Weak password** — enter a 3-character password and submit. Expect a length/strength error.

## Notes
- Screenshot every scenario (pass and fail).
- Treat any console error or failed request as a defect even if the UI looks fine.
```

To add more coverage, drop another `.md` file next to it (e.g. `login.md`, `checkout.md`) —
each becomes its own parallel session.

### Output

Every run writes everything under one timestamped folder in your project:

```
executions/execu_<YYYY-MM-DD_HH-MM-SS>/
├── report.md
├── browser-sessions/<session>/{logs,screenshots}/
└── bugs/{bug-list.md,screenshots/}
```

## License

MIT — see [LICENSE](./LICENSE).
