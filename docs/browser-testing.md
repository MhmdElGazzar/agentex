# Browser Testing

This is the core of AgenTeX: instead of clicking through a web app by hand to test it, you
describe what to test and Claude drives a real browser through it for you — taking
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

Start from the samples in [`test/suite1/`](../test/suite1/) (see [`test/README.md`](../test/README.md) for how specs are organized) — `/init-test` copies them into
your project automatically. To add more coverage, drop another `.md` file next to it (e.g.
`login.md`, `checkout.md`); in parallel mode each becomes its own session.

## Quick reference

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
