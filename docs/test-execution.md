# Test Execution

This is shared AgenTeX behavior. Claude uses `/execute-test`; Codex and GitHub Copilot
Agent use their installed `agentex-test` skills through natural-language requests. Azure
DevOps is not required for these runs.

This is the core of AgenTeX: instead of clicking through a web app by hand to test it, you
describe what to test and Claude runs it for you — driving a real browser, calling your APIs,
and checking your database — taking evidence, checking for errors, and reporting back what
passed and what didn't. It never touches your application's code — only test artifacts get
written.

The **test-execution** skill runs the test; each step goes to the driver that owns it:

| Step in a spec | Driver |
|---|---|
| Plain prose ("click Search") | **browser-driver** (a real `playwright-cli` browser) |
| `api: …` | **api-integration** (see [API & DB steps](./api-db-steps.md)) |
| `db: …` | **db-integration** |
| `kb: …` | **ask-kb** (advisory only) |
| `ui-check: …` | **ui-check** (needs the browser) |

## Walkthrough: your first run (sequential)

You type something like:

> Test https://example.com — the signup form: happy path plus empty and bad-email cases.

Here's what happens, step by step:

1. **Plan** — Claude restates what it understood and proposes a numbered list of scenarios
   (happy path, edge cases, negative cases). It stops here — nothing runs yet until you approve.
2. **Drive** — once you approve, a real browser opens and Claude runs each scenario one at a
   time, taking a screenshot whether it passes or fails, and watching for console errors or
   failed network calls (these count as defects even if the page looks fine). Success states are
   verified by computed visibility (whether an element is actually visible), not just DOM
   presence — so a test only passes if the page truly looks correct, not just has the right
   HTML structure.
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
login → action → assert) together in a single file rather than splitting it across files. If
login itself is the slow part, see [Optimize Login](./optimize-login.md) to pay that cost once
instead of every run.

## Writing your own specs

Across runtimes, parallel execution is explicitly scoped and bounded. Each spec owns a
unique named session, results are aggregated deterministically, and cleanup closes only
owned sessions. Copilot's assembled package contains the shared parallel coordinator;
it does not need the AgenTeX source checkout for this mode.

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

### API / DB-only specs (no browser)

A spec that tests only APIs or data declares its drivers in the header. It then needs no
browser, no `Target:`, and no `portalUrl` in the environment, locally and in CI:

```markdown
# Spec: Catalog API smoke

Drivers: api

## Scenarios
1. api: shop-api.product-by-sku(sku=PRD-1) → expect HTTP 200 and name present
2. api: shop-api.stock-by-sku(sku=PRD-1) → expect HTTP 200 and quantity present
```

Without a `Drivers:` line a spec is a browser spec plus whatever `api:` / `db:` / `kb:` /
`ui-check:` steps it uses — so every existing spec keeps working unchanged.

Start from the samples in [`test/suite1/`](../test/suite1/) (see [`test/README.md`](../test/README.md) for how specs are organized) — `/init-test` copies them into
your project automatically. To add more coverage, drop another `.md` file next to it (e.g.
`login.md`, `checkout.md`); in parallel mode each becomes its own session.

## Quick reference

Results are **PASS** when expectations are observed, **FAIL** when the product contradicts
them, and **BLOCKED** when an infrastructure or execution problem prevents a reliable
product verdict. BLOCKED is not automatically a product defect; FAIL remains a local result
unless an optional Azure Bug workflow is separately approved.

In a parallel run, a worker crash, timeout, or missing `executor-result.json` makes that
assignment **BLOCKED**; the coordinator does not infer PASS or silently switch the
requested run to sequential execution. For `EPERM`, `MISSING_RESOURCE`, worker timeout,
or missing-result signals, inspect
`browser-sessions/<session>/logs/worker-stdout.log` and
`browser-sessions/<session>/logs/worker-stderr.log` in the run directory. These logs keep
sanitized process metadata and signal names, not raw model or tool transcripts. Codex
hosts may restrict nested worker launch; see [Codex parallel runtime troubleshooting](./codex.md#parallel-runtime-limit-and-troubleshooting).

Normal run outputs include `report.md`, machine-readable `run-summary.json`,
`extent-report.html`, per-session `executor-result.json`, screenshots/logs and browser
snapshots, plus `bugs/bug-list.md` and relevant defect evidence where applicable.

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Sequential** (default) | A natural-language request or `/execute-test <url>` | Human-in-the-loop. Claude pauses for your approval at each checkpoint. Best for exploratory / first-run testing. |
| **Parallel** (autonomous) | "Run a parallel regression … from the specs in `test/suite1/`" | Spawns one `qa-executor` subagent per spec file, each in its own isolated browser session, then merges their defect lists into one report. Best for regression suites. |

**Output layout:**
```
executions/execu_<YYYY-MM-DD_HH-MM-SS>/
├── report.md
├── extent-report.html                 # interactive dashboard (see extent-report skill)
├── browser-sessions/<session>/{logs,screenshots}/
└── bugs/{bug-list.md,screenshots/}
```
`<session>` names are generated unique per run (never playwright-cli's shared `default`
session), so two runs — even two Claude Code windows on the same machine — never share a
browser, and each run closes only the browsers it opened.

**Setup** (only for specs with browser steps):
```bash
npm install -D @playwright/cli
npx playwright-cli install-browser chromium
```
Copy the `permissions` block from [`settings.example.json`](../settings.example.json) into your
project's `.claude/settings.json` to pre-approve the safe `playwright-cli` commands.

**Reference:**
- Skill: `skills/test-execution/SKILL.md` (orchestrator) · `skills/browser-driver/SKILL.md` (browser driver)
- Subagent: `agents/qa-executor.md`
- Driver notes: `skills/browser-driver/references/tools/playwright-cli.md`
- Spec format: `skills/test-execution/references/concepts/spec-format.md`
- HTML dashboard: see [extent-report](./extent-report.md)
