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
| **API & database execution targets** | 🚧 Planned |

The rest of this README covers the **browser-testing** flow — the core of AgenTeX today.

## Quick start

```
/plugin marketplace add MhmdElGazzar/elgazzar-plugins
/plugin install agentex@elgazzar-plugins
```

Then, in the project you want to test: `/init-test` to scaffold sample specs, and
`/execute-test https://example.com` to run. See [One-time setup](#one-time-setup-in-the-project-you-want-to-test) for the Playwright + permissions steps.

## What's inside

| Component | File | Purpose |
|-----------|------|---------|
| Skill | `skills/browser-testing/SKILL.md` | The orchestrator workflow — modes, output layout, defect format, rules |
| Skill | `skills/azure-integration/SKILL.md` | Reach Azure resources during a run via the `az` CLI |
| Agent | `agents/qa-executor.md` | Subagent that runs one test spec in its own isolated browser session |
| Reference | `skills/browser-testing/references/playwright-cli.md` | The browser driver — setup & gotchas |
| Reference | `skills/azure-integration/references/azure-cli.md` | `az` CLI — install/auth/common commands |
| Command | `commands/init-test.md` | `/init-test` — scaffold sample specs + `executions/` in your project |
| Command | `commands/execute-test.md` | `/execute-test <url or scope>` — run the tests |
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
