# Architecture — How AgenTeX Composes Claude Code

Builds on [Claude Code 101](./claude-code-101.md). This page is AgenTeX-specific: how its
skills, commands, and subagent are put together, and the conventions that make that composition
predictable.

## Repo map

```text
skills/       one folder per capability (SKILL.md + references/ + scripts/ + templates/)
commands/     thin slash-command entrypoints ($ARGUMENTS -> skill)
agents/       subagent definitions (currently: qa-executor.md)
docs/         user-facing feature docs (this contributing/ subfolder is the exception)
test/         sample specs scaffolded by /init-test
executions/   NOT shipped in the plugin — output folder created in the consumer's project
```

## SKILL.md = judgment, references/ = mechanics

Every skill splits into two layers:

- **`SKILL.md`** holds *judgment*: when to act, which mode to pick, what to check before
  proceeding, how to report results. It's what Claude reads every time the skill is in play.
- **`references/*.md`** holds *mechanics*: exact CLI flags, API request/response shapes,
  gotchas. These are read on demand — "before the first use of that tool in a session" — not
  loaded upfront, so `SKILL.md` stays short and skimmable.

Example: `skills/browser-testing/SKILL.md` says to read `references/playwright-cli.md` before
driving a browser for the first time, rather than inlining every `playwright-cli` flag into the
main skill file.

## Deterministic scripts do the mechanical work

Where a step is mechanical, security-sensitive, or easy to get subtly wrong if an agent
improvised it, AgenTeX moves that step into a small Node script instead of leaving it to agent
reasoning:

- `skills/api-integration/scripts/run_api.js` — executes one cataloged API request: catalog
  lookup, param validation, env resolution, the HTTP call, evidence logging, assertions.
- `skills/db-integration/scripts/run_db.js` — the same shape for SQL Server queries, with a DDL
  ban and parameter sanitization enforced in code (not something an agent is trusted to
  self-police).
- `skills/optimize-login/scripts/session.js` — verifies/saves/resumes a browser `storageState`.
- `skills/browser-testing/scripts/{preflight,init_run,merge_run}.js` — tool checks, execution
  tree scaffolding, bug-evidence merging.

**The pattern:** the agent decides *what* to run and reports the result; the script decides
*whether it's allowed to run* and executes it exactly the same way every time. Every runner
prints exactly one JSON line — `{"result":"PASS|FAIL|BLOCKED", ...}` — and sets its exit code
(0/1/2) to match, so the calling skill can branch on it without parsing prose.

## Execution output layout

Every test run writes into one timestamped folder inside the **consumer's** project (never
inside the plugin itself):

```text
executions/execu_<YYYY-MM-DD_HH-MM-SS>/
├── report.md
├── browser-sessions/<session>/{logs,screenshots}/
└── bugs/{bug-list.md, screenshots/}
```

`skills/browser-testing/scripts/init_run.js` creates this tree in one call rather than a chain
of `mkdir`s — see [testing.md](./testing.md) for how scripts like this get tested.

## Dispatching the qa-executor subagent

`agents/qa-executor.md` defines a subagent whose job is to execute **one** test spec file in its
own `playwright-cli` session, never touching application code. `skills/browser-testing/SKILL.md`
dispatches it two ways:

- **Sequential mode** (default): a single `default` session, human approves each checkpoint.
- **Parallel mode**: one `qa-executor` per spec file, all dispatched in a single batch so they
  run concurrently (queued automatically past ~6–8 concurrent sessions), each writing only into
  its own `browser-sessions/<session>/` folder. The main agent then merges their reports into
  one `report.md` and `bugs/`.

This is the concrete case of "dispatch a subagent for isolated/parallel work" from
[Claude Code 101](./claude-code-101.md).

## Where to go next

- [Conventions](./conventions.md) — naming, the no-employer-data rule, secrets, the
  catalog-only principle.
- [Adding a Skill](./adding-a-skill.md) — build a toy skill end to end using everything above.
