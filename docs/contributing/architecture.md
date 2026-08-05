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

**What:** every skill splits into `SKILL.md` (judgment) and `references/*.md` (mechanics).

**Why:** keeps `SKILL.md` short and skimmable; tool details load only when needed.

**When:** any skill that calls an external tool/API with real flags or a request shape.

**When not:** trivial skills with no external tool — keep it all in `SKILL.md`.

**How:** `SKILL.md` says "read `references/x.md` before the first use of tool X."

**Example:** `browser-testing/SKILL.md` → read `references/playwright-cli.md` before driving a
browser.

**Pros/cons:** + short main file, on-demand detail — but one more file to keep in sync.

## Deterministic scripts do the mechanical work

**What:** a small Node script does the mechanical/security-sensitive step instead of agent
reasoning; it prints one JSON line — `{"result":"PASS|FAIL|BLOCKED", ...}` — and exits 0/1/2.

**Why:** the agent decides *what* to run; the script decides *whether it's allowed* and
executes it the same way every time — consistent, and testable in isolation.

**When:** the step is repeatable, security-sensitive, or easy to get subtly wrong if
improvised (catalog checks, DDL bans, param sanitization, auth headers).

**When not:** a one-off judgment call with nothing to enforce in code.

**How:** skill calls `node scripts/<name>.js --flags`, branches on the JSON result/exit code.

**Example:** `run_api.js`, `run_db.js`, `session.js`, `preflight.js`/`init_run.js`/`merge_run.js`.

**Pros/cons:** + consistent, testable, safe — but needs a script + test to write and maintain.

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

**What:** `agents/qa-executor.md` — a subagent that runs **one** test spec file in its own
`playwright-cli` session, never touching application code.

**Why:** isolates and parallelizes browser sessions without bloating the main agent's context.

**When:** parallel/autonomous mode — one spec file, one subagent, one session.

**When not:** sequential mode — a single `default` session, no dispatch needed.

**How:** the main agent batches dispatch (one call, many subagents), injecting each one's
`SESSION`/`SESSION_DIR`/`TARGET_URL`/`TEST_SPEC`.

**Example:** `browser-testing/SKILL.md`'s parallel mode — ~6–8 sessions run concurrently, the
rest queue automatically; the main agent then merges every report into one `report.md`/`bugs/`.

**Pros/cons:** + real concurrency, isolated evidence per session — but needs a merge step to
combine results.

## Where to go next

- [Conventions](./conventions.md) — naming, the no-employer-data rule, secrets, the
  catalog-only principle.
- [Adding a Skill](./adding-a-skill.md) — build a toy skill end to end using everything above.
