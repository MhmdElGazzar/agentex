# User Manual Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `docs/` into a walkthrough-style manual usable by someone with no prior
technical background, while preserving every fact the existing reference tables/bullets
contain, plus add the two missing pages (`using-claude-code.md`, `optimize-login.md`).

**Architecture:** Each touched page gets: (1) a plain-language intro, (2) one or more
walkthroughs (a real example prompt, what Claude does/asks, what the reader sees), (3) a
**Quick reference** section carrying over the old tables/bullets losslessly. `configuration.md`
gets a short walkthrough but stays mostly table-driven since it's inherently a lookup page.

**Tech Stack:** Markdown only — no code changes.

## Global Constraints

- No page may lose information the current version has — every fact/row/bullet from the
  current file must appear somewhere in the new version (narrative or quick-reference).
- No walkthrough may claim a capability the code doesn't have — verify each example prompt/
  command against the actual `SKILL.md`/`commands/*.md`/script before writing it (spec:
  Content accuracy). This plan's examples were already checked against
  `skills/optimize-login/SKILL.md`, `commands/init-test.md`, `commands/execute-test.md`, and
  the other existing docs pages while drafting — do not add new claims beyond what's below.
- This is documentation only — no changes to `skills/`, `commands/`, or `agents/`.
- Every internal link between pages must resolve to a real file/anchor.
- Commit each task directly to `main` (established workflow on this repo) — no feature branch.
- **Fence note:** every file this plan writes contains nested triple-backtick code fences of
  its own. Every "Write the file" step below wraps its content in a **4-backtick** fence for
  exactly this reason — write only what's between the 4-backtick markers, not the markers
  themselves.

---

### Task 1: `docs/using-claude-code.md` (new)

**Files:**
- Create: `docs/using-claude-code.md`

**Interfaces:**
- Produces: link target `./using-claude-code.md` (referenced by Tasks 2, 10).

- [ ] **Step 1: Write the file**

````markdown
# Using Claude Code — the Basics

If you've never used an AI coding assistant like Claude Code before, start here — every other
page in this manual assumes you've read this one.

## What Claude Code is

Claude Code is a program you talk to in plain English. You type what you want, it does the
work — driving a browser, running commands, reporting back — and tells you what happened.
AgenTeX is a set of extra abilities ("skills") installed into Claude Code specifically for QA
testing.

## Typing a request

You just type what you want in plain language, the same way you'd ask a colleague:

> Test https://example.com — the signup form: happy path plus empty and bad-email cases.

Claude reads this, figures out which of its abilities apply (here: AgenTeX's browser-testing
skill), and gets to work.

## Slash commands

A **slash command** is a shortcut for a specific request — type `/` followed by a name and
some arguments, and Claude runs that exact ability with no guessing:

```
/execute-test https://example.com
```

Slash commands are optional — you can always just describe what you want in plain language
instead (like the signup form example above). AgenTeX's commands are listed in
[Getting Started](./getting-started.md).

## Approving actions

Claude Code often **pauses and asks before doing something** — especially before running a
command it hasn't run before, or before an AgenTeX skill takes an action like filing a bug.
You'll see a prompt asking you to approve, and nothing happens until you respond. This is a
safety feature, not a bug — you're always in control of what actually runs.

AgenTeX itself adds its own checkpoints on top of this: for example, a sequential test run
stops after planning scenarios and again after each one, so you can review before it continues.

## What you'll see during a run

When AgenTeX runs a test, you'll typically see:
- Claude explaining what it's about to do, in plain language, before doing it
- A real browser window opening and being driven through your scenario (if you're watching)
- A summary at the end: what passed, what failed, and where the evidence (screenshots, logs)
  was saved

Next: [Getting Started](./getting-started.md) — install AgenTeX and run your first test.
````

- [ ] **Step 2: Verify no placeholders**

Run: `grep -n "TBD\|TODO" docs/using-claude-code.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/using-claude-code.md
git commit -m "docs: add Using Claude Code basics page"
```

---

### Task 2: `docs/getting-started.md` (restructure)

**Files:**
- Modify: `docs/getting-started.md` (full replace)

**Interfaces:**
- Consumes: `./using-claude-code.md` (Task 1).
- Produces: link target `./getting-started.md` (unchanged path, already referenced elsewhere).

- [ ] **Step 1: Write the file** (full replace of existing content)

````markdown
# Getting Started

New to Claude Code itself? Read [Using Claude Code](./using-claude-code.md) first — this page
assumes you already know how to type a request and approve an action.

## 1. Install the plugin

AgenTeX installs through the **`elgazzar-plugins`** marketplace. From Claude Code:

```
/plugin marketplace add MhmdElGazzar/elgazzar-plugins
/plugin install agentex@elgazzar-plugins
```

> **Developing against a local clone?** Point the marketplace at your local copy of the
> `elgazzar-plugins` repo (the one containing `.claude-plugin/marketplace.json`) instead of GitHub:
> `/plugin marketplace add /path/to/elgazzar-plugins`, then install the same way.

## 2. Install the browser driver

In the project you want to test (the agent will offer to do this for you):

```bash
npm install -D @playwright/cli
npx playwright-cli install-browser chromium
```

## 3. Scaffold the project

```
/init-test
```

This creates a starting point in your project: sample test files in `test/suite1/` (editable
examples — adapt them to your app), an empty `executions/` folder where run results will land,
and a `.env` file with setting names ready for you to fill in.

## 4. Set permissions

Plugin manifests can't ship permission rules, so copy the `permissions` block from
[`settings.example.json`](../settings.example.json) into your project's `.claude/settings.json`
(merge with anything already there). This pre-approves the safe `playwright-cli` commands —
so Claude doesn't have to ask before every single one during a run — and denies secret reads /
destructive actions.

## 5. Run your first test

```
/execute-test https://example.com
```

Or just describe what you want, in plain language:

> Test https://example.com — the signup form: happy path plus empty and bad-email cases.

Here's what happens: Claude restates what it's about to test and proposes a numbered list of
scenarios — this is a checkpoint, nothing runs yet until you approve. Once you do, it opens a
real browser and works through each scenario one at a time, pausing after each one so you can
see the result before it continues. When it's done, everything lands in a new timestamped
folder:

```
executions/execu_<timestamp>/
├── report.md              # the final summary — what passed, what failed
├── extent-report.html     # an interactive dashboard version, open it in any browser
└── ...                    # screenshots and logs backing up every result
```

## Next steps

- [Browser Testing](./browser-testing.md) — sequential vs. parallel modes, writing your own specs.
- [Configuration](./configuration.md) — environment variables and secret handling.
- [docs/](./README.md) — the full feature reference.
````

- [ ] **Step 2: Verify no placeholders and no lost content**

Run:
```bash
grep -n "TBD\|TODO" docs/getting-started.md
grep -n "plugin marketplace add\|install-browser chromium\|init-test\|settings.example.json\|execute-test" docs/getting-started.md
```
Expected: first command has no output; second prints 5 matching lines (confirming every
original step's key command survived the rewrite).

- [ ] **Step 3: Commit**

```bash
git add docs/getting-started.md
git commit -m "docs: restructure getting-started.md as a walkthrough"
```

---

### Task 3: `docs/browser-testing.md` (restructure)

**Files:**
- Modify: `docs/browser-testing.md` (full replace)

- [ ] **Step 1: Write the file** (full replace of existing content)

````markdown
# Browser Testing

This is the core of AgenTeX: instead of clicking through a web app by hand to test it, you
describe what to test and an agent drives a real browser through it for you — taking
screenshots, checking for errors, and reporting back what passed and what didn't. It never
touches your application's code — only test artifacts get written.

## Walkthrough: your first run (sequential)

You type something like:

> Test https://example.com — the signup form: happy path plus empty and bad-email cases.

Here's what happens, step by step:

1. **Plan** — Claude restates what it understood and proposes a numbered list of scenarios
   (happy path, edge cases, negative cases). It stops here — nothing runs yet until you approve.
2. **Drive** — once you approve, a real browser opens and Claude runs each scenario one at a
   time, taking a screenshot whether it passes or fails, and watching for console errors or
   failed network calls (these count as defects even if the page looks fine).
3. **Checkpoint** — after each scenario, Claude reports pass/fail with evidence and pauses
   before moving to the next one, so you can stop or redirect at any point.
4. **Report** — at the end, everything is written to a new `executions/execu_<timestamp>/`
   folder: a summary (`report.md`), an interactive dashboard (`extent-report.html`), and the
   screenshots/logs backing up every result.

## Walkthrough: a full regression (parallel)

For a bigger run — many spec files, no need to babysit each one — ask for it explicitly:

> Run a parallel regression against https://example.com from the specs in test/suite1/.

This time Claude doesn't stop for approval at each step. It spins up one independent browser
session **per spec file** (so unrelated scenarios run at the same time instead of one after
another), then merges every session's results into one final report when they're all done.

**One spec file = one browser session** — so keep a flow that depends on earlier steps (like
login → action → assert) together in a single file rather than splitting it across files.

## Writing your own specs

A spec is just a markdown file: a target, what "correct" looks like, and a numbered list of
scenarios, written in plain language:

```markdown
# Spec: Signup form validation

Target: https://example.com/signup
Type: form validation — NO real account is created (validation-only)

## Acceptance criteria
- Valid input reaches a visible success/confirmation state.
- Invalid input is rejected with a specific, visible error; the form must not submit.
- No console errors or failed network calls during any scenario.

## Scenarios
1. **Happy path** — fill Name, a disposable email, and a valid password, then submit.
2. **Empty required fields** — submit blank. Expect an inline "required" error on each field.
3. **Bad email format** — enter `not-an-email` and submit. Expect an email-format error.

## Notes
- Screenshot every scenario (pass and fail).
- Treat any console error or failed request as a defect even if the UI looks fine.
```

Start from the samples in [`test/suite1/`](../test/suite1/) — `/init-test` copies them into
your project automatically. To add more coverage, drop another `.md` file next to it (e.g.
`login.md`, `checkout.md`); in parallel mode each becomes its own session.

## Quick reference

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Sequential** (default) | A natural-language request or `/execute-test <url>` | Human-in-the-loop. The agent pauses for your approval at each checkpoint. Best for exploratory / first-run testing. |
| **Parallel** (autonomous) | "Run a parallel regression … from the specs in `test/suite1/`" | Spawns one `qa-executor` subagent per spec file, each in its own isolated browser session, then merges their defect lists into one report. Best for regression suites. |

**Output layout:**
```
executions/execu_<YYYY-MM-DD_HH-MM-SS>/
├── report.md
├── extent-report.html                 # interactive dashboard (see extent-report skill)
├── browser-sessions/<session>/{logs,screenshots}/
└── bugs/{bug-list.md,screenshots/}
```

**Setup:**
```bash
npm install -D @playwright/cli
npx playwright-cli install-browser chromium
```
Copy the `permissions` block from [`settings.example.json`](../settings.example.json) into your
project's `.claude/settings.json` to pre-approve the safe `playwright-cli` commands.

**Reference:**
- Skill: `skills/browser-testing/SKILL.md`
- Subagent: `agents/qa-executor.md`
- Driver notes: `skills/browser-testing/references/playwright-cli.md`
- HTML dashboard: see [extent-report](./extent-report.md)
````

- [ ] **Step 2: Verify no placeholders and no lost content**

Run:
```bash
grep -n "TBD\|TODO" docs/browser-testing.md
grep -n "qa-executor\|Sequential\|Parallel\|playwright-cli.md\|bugs/{bug-list.md" docs/browser-testing.md
```
Expected: first command has no output; second prints multiple matches confirming the modes
table, subagent reference, and output layout all survived.

- [ ] **Step 3: Commit**

```bash
git add docs/browser-testing.md
git commit -m "docs: restructure browser-testing.md as a walkthrough"
```

---

### Task 4: `docs/api-db-steps.md` (restructure)

**Files:**
- Modify: `docs/api-db-steps.md` (full replace)

- [ ] **Step 1: Write the file** (full replace of existing content)

````markdown
# API & DB Steps

Sometimes seeing something happen in the browser isn't proof enough — did the signup actually
create a user in the database? Did the right thing happen server-side? `api:` and `db:` steps
let a test scenario check that directly, without you writing any code.

## Walkthrough

Say your signup-form spec adds these two lines to its scenario list:

```markdown
## Scenarios
1. **Create a user via the UI** — fill the signup form and submit; expect a success state.
2. api: getUserByEmail — confirm the API returns the new user with status 200.
3. db: countUsersByEmail — confirm exactly 1 row exists for that email.
```

When Claude reaches scenario 2, it doesn't invent a request — it looks up `getUserByEmail` in
your project's `integration/` folder (definitions you or a teammate wrote ahead of time), runs
**exactly** that request, and reports PASS/FAIL/BLOCKED with the response saved as evidence.
Scenario 3 works the same way against your database. If a step names something not in that
catalog, it's reported as **BLOCKED** rather than guessed at — this is deliberate: Claude never
composes its own SQL or HTTP request.

`/init-test` scaffolds a starter `integration/` folder with sample entries you replace with your
own service's requests/queries.

## Quick reference

**Safety rules:**
- Writes (POST/PUT/DELETE) run if they're cataloged — the catalog is the authorization.
- **DDL** (`DROP` / `TRUNCATE` / `ALTER`) is refused **even if cataloged** — enforced in code.
- Secrets stay in env — catalog files hold only env-var *names*; values live in `.env` or your
  shell.

**API steps** — `api:` (or "verify via API", "call the endpoint")
- Runner: `skills/api-integration/scripts/run_api.js`
- Catalog sample: `skills/api-integration/templates/sample_api.json`
- Env: `API_BASE_URL`, `API_TOKEN`
- Reference: `skills/api-integration/references/api-requests.md`

**DB steps** — `db:` (or "check the database", "verify the row")
- Runner: `skills/db-integration/scripts/run_db.js`
- Catalog sample: `skills/db-integration/templates/sample_db.json`
- Env: `DB_SERVER`, `DB_PORT` (default `1433`), `DB_NAME`, `DB_USER`; password via
  `SQLCMDPASSWORD` (never on the command line)
- Reference: `skills/db-integration/references/sqlcmd.md`

**Reference:**
- Skills: `skills/api-integration/SKILL.md`, `skills/db-integration/SKILL.md`
- Configuration: see [configuration](./configuration.md)
````

- [ ] **Step 2: Verify no placeholders and no lost content**

Run:
```bash
grep -n "TBD\|TODO" docs/api-db-steps.md
grep -n "run_api.js\|run_db.js\|DDL\|SQLCMDPASSWORD\|API_BASE_URL" docs/api-db-steps.md
```
Expected: first command has no output; second prints multiple matches.

- [ ] **Step 3: Commit**

```bash
git add docs/api-db-steps.md
git commit -m "docs: restructure api-db-steps.md as a walkthrough"
```

---

### Task 5: `docs/ask-kb.md` (restructure)

**Files:**
- Modify: `docs/ask-kb.md` (full replace)

- [ ] **Step 1: Write the file** (full replace of existing content)

````markdown
# Ask the Knowledge Base

If your project has a knowledge base, you can ask it questions in plain language mid-test — or
any time, standalone — instead of digging through docs yourself. The answer is **advisory
only**: it helps you understand a flow, but it never counts as pass/fail proof.

## Walkthrough

Standalone, any time:

```
/ask-kb how does the checkout flow work?
```

Claude sends your question to the project's KB Ask API and shows you the answer along with its
sources. If the KB doesn't cover it, you're told plainly rather than given a guessed answer.

During a test run, add a `kb:` line to a scenario:

```markdown
## Scenarios
1. kb: how is a returning customer's discount applied at checkout?
2. **Verify** — apply the flow described above and confirm the discounted total in the UI.
```

Claude asks the KB first (informing how it approaches scenario 2), then goes and verifies the
actual behavior in the browser — the KB answer is context, not the check itself.

To target a specific project's KB: `/ask-kb acme-store: what fields are required at checkout?`
or `kb:acme-store: <question>` inside a spec.

## Quick reference

| Variable | Purpose |
|----------|---------|
| `KB_ASK_BASE_URL` | KB Ask API host (host only, e.g. `http://localhost:3000`). |
| `KB_PROJECT` | Default project id (e.g. `acme-store`); a `kb:<project>:` step overrides it. |
| `KB_ASK_API_KEY` | Shared secret sent as `x-api-key` (required when the server has it set). |

**Behind the scenes:**
- Sends `x-api-key` from `KB_ASK_API_KEY` when set (never logged).
- A `401` is reported as `BLOCKED` (not retried); `429` responses honor `Retry-After`
  automatically.
- The response's `cached` flag is surfaced; the API's default model is `sonnet`.

**Reference:**
- Skill: `skills/ask-kb/SKILL.md`
- Command: `commands/ask-kb.md`
- API contract & curl fallback: `skills/ask-kb/references/kb-ask-api.md`
````

- [ ] **Step 2: Verify no placeholders and no lost content**

Run:
```bash
grep -n "TBD\|TODO" docs/ask-kb.md
grep -n "KB_ASK_BASE_URL\|KB_ASK_API_KEY\|x-api-key\|Retry-After\|cached\|sonnet" docs/ask-kb.md
```
Expected: first command has no output; second prints multiple matches (confirming the env
table and the retry/cache/model details all survived).

- [ ] **Step 3: Commit**

```bash
git add docs/ask-kb.md
git commit -m "docs: restructure ask-kb.md as a walkthrough"
```

---

### Task 6: `docs/azure-devops.md` (restructure)

**Files:**
- Modify: `docs/azure-devops.md` (full replace)

- [ ] **Step 1: Write the file** (full replace of existing content)

````markdown
# Azure DevOps QA

If your team tracks work in Azure DevOps, AgenTeX can estimate QA effort, generate test cases
from a story's acceptance criteria, file bugs it finds during a run, and reach Azure resources
mid-test — all through the `az` CLI, with your confirmation before anything is written.

## One-time setup

1. Install `az` (see `skills/azure-integration/references/azure-cli.md`), then add the DevOps
   extension:
   ```bash
   az extension add --name azure-devops
   ```
2. Fill the `AZURE_*` keys in `.env` — `AZURE_URL` (org URL), `AZURE_PROJECT`, `AZURE_TEAM`,
   `AZURE_ASSIGNEE`.
3. Authenticate: `az login`, or for non-interactive use export a PAT in your shell:
   ```bash
   export AZURE_DEVOPS_EXT_PAT=<your-pat>
   ```
   Claude never prints or passes the PAT anywhere.

## Walkthrough: estimating a sprint

```
/estimate-story
```

Claude looks at your sprint's User Stories one at a time, proposes an hours estimate for each
(based on scenario count, fields, validations, integrations involved) — and **only after you
confirm that story** — creates 5 `[Testing]` tasks on it: Requirement Review, Test Creation,
Test Execution, Bug Review & Retest, Automation. Nothing is created without your say-so, and it
never processes more than one story at a time without checking in. Target specific stories with
`/estimate-story 12345 12346`.

## Walkthrough: designing test cases

```
/design-test 12345
```

Claude reads the story's acceptance criteria, breaks them into test conditions, and creates
titled test cases in ADO with structured steps — then links them **Tested By** the story, and
finishes with a coverage check (did every acceptance criterion end up covered?). Your project's
own conventions (persona, journey steps, setup steps) live in `.agentex/test-template.md`,
scaffolded automatically the first time this runs.

## Walkthrough: filing a bug after a run

Once a test/regression run has turned up defects, ask Claude to file them. For each one it:
- suggests a **severity + priority** based on what was observed (you pick the final values),
- links it to the parent **User Story** (the only relation it ever adds, and only after
  validating the story exists),
- attaches and validates the screenshot evidence,
- optionally marks the related test case **Failed**,

then shows you everything as **one** consolidated confirmation before writing anything. Every
write is first shown as the exact `az` command it would run (a dry run) — nothing executes
until you approve it.

## Reaching Azure resources mid-run

Beyond DevOps, Claude can also read Azure resources directly during a run — check a deployment,
tail App Service logs, read a Storage blob or Key Vault secret, get AKS credentials — through
the same `az` CLI, e.g. "check if the latest deployment succeeded" or "tail the app's logs."

## Quick reference

| Capability | Skill | Reference |
|---|---|---|
| Estimate QA effort (`/estimate-story`) | `skills/task-estimation/SKILL.md` | — |
| Design test cases (`/design-test`) | `skills/test-design/SKILL.md` | `skills/test-design/references/test-case-mechanics.md` |
| File bugs (`bug-report-azure`) | `skills/bug-report-azure/SKILL.md` | `skills/bug-report-azure/references/azure-devops.md` |
| Azure resources | `skills/azure-integration/SKILL.md` | `skills/azure-integration/references/azure-cli.md`, `azure-devops-cli.md` |

Configuration: see [configuration](./configuration.md)
````

- [ ] **Step 2: Verify no placeholders and no lost content**

Run:
```bash
grep -n "TBD\|TODO" docs/azure-devops.md
grep -n "task-estimation/SKILL.md\|test-design/SKILL.md\|bug-report-azure/SKILL.md\|azure-integration/SKILL.md\|test-template.md" docs/azure-devops.md
```
Expected: first command has no output; second prints multiple matches confirming every skill/
reference path from the original survived.

- [ ] **Step 3: Commit**

```bash
git add docs/azure-devops.md
git commit -m "docs: restructure azure-devops.md as a walkthrough"
```

---

### Task 7: `docs/extent-report.md` (restructure)

**Files:**
- Modify: `docs/extent-report.md` (full replace)

- [ ] **Step 1: Write the file** (full replace of existing content)

````markdown
# Interactive HTML Report

At the end of a run, you get more than a plain-text summary — AgenTeX also produces a
standalone **`extent-report.html`**: a dark-themed dashboard you can open in any browser, no
server or internet connection needed.

## Walkthrough

Once your test run finishes, open `executions/execu_<timestamp>/extent-report.html` in any
browser. You'll see:
- A donut chart showing the pass/fail/blocked split at a glance
- Stat cards per status
- Expandable cards per test case — click one to see its step-by-step detail

Everything (CSS/JS) is inlined into that one file, so you can email it or attach it to a ticket
as-is — nobody else needs any special software to view it.

## Quick reference

Generated automatically at the end of any run (one test case or a full batch) by the
deterministic script:

```bash
node skills/extent-report/scripts/make_html_report.js
```

**Reference:**
- Skill: `skills/extent-report/SKILL.md`
- Contributed by [@mabdel130](https://github.com/mabdel130) (PR #1).
````

- [ ] **Step 2: Verify no placeholders and no lost content**

Run:
```bash
grep -n "TBD\|TODO" docs/extent-report.md
grep -n "make_html_report.js\|mabdel130\|donut" docs/extent-report.md
```
Expected: first command has no output; second prints 3 matches.

- [ ] **Step 3: Commit**

```bash
git add docs/extent-report.md
git commit -m "docs: restructure extent-report.md as a walkthrough"
```

---

### Task 8: `docs/configuration.md` (restructure)

**Files:**
- Modify: `docs/configuration.md` (full replace)

- [ ] **Step 1: Write the file** (full replace of existing content)

````markdown
# Configuration

AgenTeX reads its settings from a `.env` file in your project — nothing is hardcoded, and you
only need to fill in what the features you actually use require.

## Walkthrough: setting up your first project

```bash
cp .env.example .env
```

Open `.env` and fill in only the section(s) you need right now — e.g. if you're just doing
browser testing with no API/DB/Azure steps yet, you can leave everything but `QA_TARGET_URL`
empty and add the rest later when you turn on those features. `.env` is gitignored
automatically by `/init-test` — never commit it.

## Quick reference

### Target under test

| Variable | Purpose |
|----------|---------|
| `QA_TARGET_URL` | Default target under test. |

### Integrations (`integration/` catalog)

| Variable | Purpose |
|----------|---------|
| `API_BASE_URL` | Base URL for cataloged `api:` requests. |
| `API_TOKEN` | Auth token for cataloged API requests. |
| `DB_SERVER` | SQL Server host for cataloged `db:` queries. |
| `DB_PORT` | DB port — leave empty for the default `1433`. |
| `DB_NAME` | Database name. |
| `DB_USER` | Database user. |
| `SQLCMDPASSWORD` | DB password — read natively by `sqlcmd` from the env; **never** passed on the command line. Export in your shell. |

### Azure DevOps

| Variable | Purpose |
|----------|---------|
| `AZURE_URL` | Org URL, e.g. `https://dev.azure.com/your-org`. |
| `AZURE_PROJECT` | Project name. |
| `AZURE_TEAM` | Team name. |
| `AZURE_ASSIGNEE` | Default assignee for created tasks. |
| `AZURE_DEVOPS_EXT_PAT` | PAT for non-interactive auth — export in your shell; the agent never prints or passes it. |

### KB Ask API

| Variable | Purpose |
|----------|---------|
| `KB_ASK_BASE_URL` | KB Ask API host (host only). |
| `KB_PROJECT` | Default project id; a `kb:<project>:` step overrides it. |
| `KB_ASK_API_KEY` | Shared secret sent as `x-api-key` (required when the server has it set). |

## Permissions

Plugin manifests can't ship permission rules. Copy the `permissions` block from
[`settings.example.json`](../settings.example.json) into your project's `.claude/settings.json`
(merge with anything already there). This pre-approves the safe `playwright-cli` (and `az` /
`curl` / `sqlcmd`) commands and denies secret reads / destructive actions.

## Secret-handling rules

- Catalog files (`integration/*.json`) hold only env-var **names**, never values.
- Claude may read config keys but must never print or pass secrets.
- DB and PAT secrets are read from the environment (`SQLCMDPASSWORD`, `AZURE_DEVOPS_EXT_PAT`),
  never placed on a command line.
````

- [ ] **Step 2: Verify no placeholders and no lost content**

Run:
```bash
grep -n "TBD\|TODO" docs/configuration.md
grep -n "QA_TARGET_URL\|SQLCMDPASSWORD\|AZURE_DEVOPS_EXT_PAT\|KB_ASK_API_KEY\|settings.example.json" docs/configuration.md
```
Expected: first command has no output; second prints multiple matches confirming every
variable/table survived.

- [ ] **Step 3: Commit**

```bash
git add docs/configuration.md
git commit -m "docs: restructure configuration.md as a walkthrough"
```

---

### Task 9: `docs/optimize-login.md` (new)

**Files:**
- Create: `docs/optimize-login.md`

**Interfaces:**
- Produces: link target `./optimize-login.md` (referenced by Task 10).

- [ ] **Step 1: Write the file**

````markdown
# Optimize Login

Login is usually the slowest, least interesting part of testing a web app — and if every
scenario logs in from scratch, that cost repeats every single time. This feature pays it once:
Claude drives the real login the first time, saves that logged-in session, and reuses it for
every later run — turning minutes of repeated login into seconds.

## Walkthrough

The first time a run needs to be logged in, Claude:
1. Opens the actual login page and figures out what it needs (a simple form is quick; a page
   with a captcha or one-time code takes more care).
2. Logs in for real, then double-checks it actually worked by looking for something only a
   logged-in page shows (never just the URL, which can be misleading — a login page can carry
   `?returnUrl=/dashboard` and still mean you're logged out).
3. Saves that logged-in session to a file.

On every later run, instead of repeating all of that, Claude reloads the saved session into a
fresh browser and double-checks it's still valid — this is the ~8-second version instead of the
~197-second one, measured on a real project. If the saved session has since expired, Claude
just logs in again from scratch and saves a fresh one — no action needed from you.

**If a captcha or a one-time code shows up:** Claude can't and won't try to bypass it. It runs
with a visible browser window and waits for you to complete that one step by hand — then saves
the session afterward, same as usual, so you only do it once.

## Quick reference

- Saved sessions live in `test/.auth/` by convention — **gitignored, never commit them.** A
  saved session file is effectively a password: whoever has it is logged in as that user.
- Only use this for applications you're authorized to test — it's for not repeating your own
  login, not for getting into anyone else's account.
- Applications that store their login in IndexedDB (rather than cookies/localStorage) can't be
  resumed this way — you'll see the post-load check fail plainly rather than a confusing error
  later.
- Skill: `skills/optimize-login/SKILL.md`
- Check a saved session without running a full test:
  ```
  node ${CLAUDE_PLUGIN_ROOT}/skills/optimize-login/scripts/session.js resume \
    --state test/.auth/<app>-state.json \
    --url   https://app.example.com/dashboard \
    --absent "role=button[name='Login']"
  ```
````

- [ ] **Step 2: Verify no placeholders**

Run: `grep -n "TBD\|TODO" docs/optimize-login.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/optimize-login.md
git commit -m "docs: add optimize-login user-facing doc"
```

---

### Task 10: `docs/README.md` index + root `README.md` fix + full verification

**Files:**
- Modify: `docs/README.md` (full replace)
- Modify: `README.md` (the "Optimize login" feature-table row)

**Interfaces:**
- Consumes: link targets from Tasks 1–9 (`using-claude-code.md`, `getting-started.md`,
  `browser-testing.md`, `api-db-steps.md`, `ask-kb.md`, `optimize-login.md`,
  `azure-devops.md`, `extent-report.md`, `configuration.md`).

- [ ] **Step 1: Write `docs/README.md`**

```markdown
# AgenTeX Documentation

Detailed docs for each capability. Start with the [project README](../README.md) for install and a
quick tour.

| Doc | What it covers |
|-----|----------------|
| [Using Claude Code](./using-claude-code.md) | New to Claude Code itself? Start here — typing requests, slash commands, approving actions. |
| [Getting Started](./getting-started.md) | Install → browser driver → `/init-test` → permissions → first run. |
| [Browser Testing](./browser-testing.md) | The core flow — sequential vs. parallel modes, writing specs, output layout. |
| [API & DB Steps](./api-db-steps.md) | Catalog-only `api:` / `db:` steps inside test scenarios. |
| [Ask the Knowledge Base](./ask-kb.md) | `kb:` steps and the `/ask-kb` command (advisory only). |
| [Optimize Login](./optimize-login.md) | Pay a web app's login cost once per session instead of once per test. |
| [Azure DevOps QA](./azure-devops.md) | `/estimate-story`, `/design-test`, `bug-report-azure` bug filing, and Azure resource access. |
| [Interactive HTML Report](./extent-report.md) | The standalone `extent-report.html` dashboard. |
| [Configuration](./configuration.md) | Environment variables, permissions, and secret handling. |
```

- [ ] **Step 2: Read the current root `README.md` feature table**

Read `README.md` and find the "Optimize login" row in the feature table (currently links to
`[\`skills/optimize-login/SKILL.md\`](./skills/optimize-login/SKILL.md)`).

- [ ] **Step 3: Update the row's link**

Change that row's link cell from:
```
[`skills/optimize-login/SKILL.md`](./skills/optimize-login/SKILL.md)
```
to:
```
[optimize-login](./docs/optimize-login.md)
```
(matching the style of every other row in that table, which link to `docs/*.md`, not
`skills/*/SKILL.md`). Leave the rest of the row (feature name, description) unchanged.

- [ ] **Step 4: Verify every internal link AND anchor resolves across all touched docs**

```bash
node -e "
const fs = require('fs');
const path = require('path');
const files = [
  'README.md',
  'docs/README.md',
  'docs/using-claude-code.md',
  'docs/getting-started.md',
  'docs/browser-testing.md',
  'docs/api-db-steps.md',
  'docs/ask-kb.md',
  'docs/optimize-login.md',
  'docs/azure-devops.md',
  'docs/extent-report.md',
  'docs/configuration.md',
];
let ok = true;
for (const f of files) {
  const dir = path.dirname(f);
  const content = fs.readFileSync(f, 'utf8');
  const links = [...content.matchAll(/\]\((\.\/[^)]+|\.\.\/[^)]+)/g)].map(m => m[1]);
  for (const l of links) {
    const [target, anchor] = l.split('#');
    const p = path.join(dir, target);
    if (!fs.existsSync(p)) { console.error('BROKEN LINK in ' + f + ': ' + l + ' -> ' + p); ok = false; continue; }
    if (anchor) {
      const targetContent = fs.readFileSync(p, 'utf8');
      const anchors = [...targetContent.matchAll(/^#{1,6}\s+(.+)\$/gm)].map(m => m[1].toLowerCase().replace(/[^\w\s-]/g,'').trim().replace(/\s+/g,'-'));
      if (!anchors.includes(anchor)) { console.error('BROKEN ANCHOR in ' + f + ': ' + l); ok = false; }
    }
  }
}
console.log(ok ? 'all links and anchors resolve' : 'broken links/anchors found');
"
```
Expected: `all links and anchors resolve`.

- [ ] **Step 5: Commit**

```bash
git add docs/README.md README.md
git commit -m "docs: add index entries for new pages, fix optimize-login README link"
```

---

## Post-plan check

After all 10 tasks: re-run the Task 10 Step 4 link-check script once more (it covers every file
this plan touched) to reconfirm nothing regressed across the whole set.
