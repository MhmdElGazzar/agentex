# AgenTeX — agentic test execution for Claude Code

**AgenTeX** (Agentic Test eXecution) drives a **real browser** through
[`@playwright/cli`](https://www.npmjs.com/package/@playwright/cli) to run tests against web
applications from inside Claude Code. It plans test scenarios, runs them, captures screenshot/log
evidence, and produces a consolidated defect report — either **sequentially** (human-in-the-loop,
approving each step) or in **parallel** (autonomous, one browser session per test file).

Web is the first execution target; API, DB, and Azure targets are planned as sibling skills under
the same plugin.

The agent **never modifies your application code** — it only writes test artifacts.

## What's inside

| Component | File | Purpose |
|-----------|------|---------|
| Skill | `skills/website-qa/SKILL.md` | The orchestrator workflow — modes, output layout, defect format, rules |
| Agent | `agents/qa-executor.md` | Subagent that runs one test spec in its own isolated browser session |
| Reference | `skills/website-qa/references/playwright-cli.md` | The browser driver — setup & gotchas |
| Reference | `skills/website-qa/references/azure-cli.md` | `az` CLI — install/auth/common commands |
| Command | `commands/qa-test.md` | `/qa-test <url or scope>` convenience entrypoint |
| Permissions | `settings.example.json` | Recommended permission rules to copy into your project |

## Install

From Claude Code, add the marketplace that lists this plugin, then install it:

```
/plugin marketplace add MhmdElGazzar/elgazzar-plugins
/plugin install agentex@elgazzar-plugins
```

To try it straight from this repo without a marketplace:

```
/plugin marketplace add MhmdElGazzar/agentex
/plugin install agentex
```

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

- **Parallel (autonomous):** put one test spec per file in a `test/` directory, then:
  > Run a parallel regression against https://example.com from the specs in `test/`.

  It spawns one `qa-executor` subagent per file (each in its own `-s=<session>`) and merges the
  results.

- Or use the command: `/qa-test https://example.com`

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
