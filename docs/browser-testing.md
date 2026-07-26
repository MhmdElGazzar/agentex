# Browser Testing

The core of AgenTeX: an agent drives a **real browser** through
[`@playwright/cli`](https://www.npmjs.com/package/@playwright/cli), runs your scenarios, captures
evidence, and reports defects. It **never modifies your application code** — it only writes test
artifacts.

## How it works

1. **Plan** — the agent reads your request (or a spec file), restates the scope, and proposes a
   numbered plan of scenarios (happy path, edge, negative).
2. **Drive** — it opens a `playwright-cli` browser session and executes each scenario, taking a
   screenshot per scenario (pass *and* fail) and recording console/network activity.
3. **Judge** — a console error or failed network request is treated as a defect even if the UI
   looks fine. Success states are verified by computed visibility, not just DOM presence.
4. **Report** — results are written to a timestamped `executions/` folder as `report.md`, per-session
   logs/screenshots, and a merged bug list.

## Execution modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Sequential** (default) | A natural-language request or `/execute-test <url>` | Human-in-the-loop. The agent pauses for your approval at each checkpoint. Best for exploratory / first-run testing. |
| **Parallel** (autonomous) | "Run a parallel regression … from the specs in `test/suite1/`" | Spawns one `qa-executor` subagent per spec file, each in its own isolated browser session, then merges their defect lists into one report. Best for regression suites. |

**One spec file = one browser session.** Keep stateful flows (login → action → assert) in a single
file so they share a session.

## Writing a spec

Each spec is plain language: a target, acceptance criteria, and numbered scenarios. Start from the
examples in [`test/suite1/`](../test/suite1/); see [`test/README.md`](../test/README.md) for how
specs are organized.

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

To add coverage, drop another `.md` file next to it (e.g. `login.md`, `checkout.md`) — in parallel
mode each becomes its own session.

## Output layout

```
executions/execu_<YYYY-MM-DD_HH-MM-SS>/
├── report.md
├── extent-report.html                 # interactive dashboard (see extent-report skill)
├── browser-sessions/<session>/{logs,screenshots}/
└── bugs/{bug-list.md,screenshots/}
```

## Setup

```bash
npm install -D @playwright/cli
npx playwright-cli install-browser chromium
```

Copy the `permissions` block from [`settings.example.json`](../settings.example.json) into your
project's `.claude/settings.json` to pre-approve the safe `playwright-cli` commands.

## Reference

- Skill: `skills/browser-testing/SKILL.md`
- Subagent: `agents/qa-executor.md`
- Driver notes: `skills/browser-testing/references/playwright-cli.md`
- HTML dashboard: see [extent-report](./extent-report.md)
