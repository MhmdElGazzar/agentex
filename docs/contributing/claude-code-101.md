# Claude Code 101 — Concepts From Zero

This page explains the Claude Code building blocks AgenTeX is built from, with no AgenTeX
specifics yet. If you already know what a plugin/skill/command/subagent is, skip ahead to
[Architecture](./architecture.md).

## Plugin

**What is it?** An installable bundle of skills, commands, and subagents, described by a
`.claude-plugin/plugin.json` manifest (name, version, author, description).

**Why use it?** To package related capabilities so others can install and reuse them with one
command, instead of copy-pasting files into every project.

**When to use it?** You have one or more skills/commands you want to distribute, version, and
let people install from a marketplace.

**When not to use it?** For a one-off instruction only you need in one project — that's a
project `CLAUDE.md` or a local skill, not a plugin.

**How to use it:**
```
/plugin marketplace add <repo>
/plugin install <name>@<marketplace>
```

**Example:** AgenTeX itself — `/plugin marketplace add MhmdElGazzar/elgazzar-plugins` then
`/plugin install agentex@elgazzar-plugins`.

**Pros and cons:**
- Shareable, versioned, one-command install
- Groups related skills/commands/agents under one identity
- Overhead (manifest, marketplace listing) isn't worth it for a single throwaway skill
- Can't ship project-specific secrets/config — those stay in the consumer's own project

## Skill

**What is it?** A folder under `skills/<name>/` with a `SKILL.md` file: frontmatter
(`name`, `description`) plus body instructions Claude follows once triggered.

**Why use it?** To give Claude a repeatable, well-defined procedure for a recurring kind of
task, triggered automatically when the description matches.

**When to use it?** The task recurs, needs judgment/workflow steps, and benefits from
consistent behavior across sessions.

**When not to use it?** A single ad hoc request that won't recur — just do it directly, don't
scaffold a skill for it.

**How to use it:** Nothing to invoke by hand — Claude reads it automatically when its
`description` matches the request. A `commands/*.md` file can also invoke it explicitly.

**Example:** `skills/browser-testing/SKILL.md` — triggers whenever the user wants a web app
tested for defects.

**Pros and cons:**
- Reusable, consistent behavior every time it's triggered
- Can bundle `references/`, `scripts/`, `templates/` alongside it
- A badly written `description` means wrong or missed triggering
- Adds indirection — more to trace than just doing a one-off ask directly

## Command

**What is it?** A file under `commands/<name>.md` that becomes a slash command;
frontmatter holds a `description`, the body uses `$ARGUMENTS` for whatever the user typed
after the command name.

**Why use it?** To give the user an explicit, discoverable, predictable way to invoke a
capability, instead of relying on Claude to infer intent from natural language.

**When to use it?** The capability has a clear, fixed invocation shape (a target, an ID, a
question) worth naming directly.

**When not to use it?** The real logic is complex — commands should stay thin and hand off to
a skill, not contain the workflow themselves.

**How to use it:** `/command-name <arguments>`

**Example:** `/ask-kb acme-store: how does checkout work?` → `commands/ask-kb.md` parses
`$ARGUMENTS` and calls the `ask-kb` skill's runner.

**Pros and cons:**
- Explicit and discoverable (shows in `/help`) — no ambiguity about intent
- Keeps the entrypoint thin and easy to reason about in isolation
- Requires the user to know/type the command name
- Wrong place for actual business logic — that belongs in the skill

## Subagent

**What is it?** A separate Claude instance with its own context window, defined by
`agents/<name>.md`, dispatched by the main agent to run a task in isolation.

**Why use it?** To isolate work (own session/tools), parallelize independent tasks, or keep a
long-running task's output from bloating the main conversation.

**When to use it?** The work is independent of the main conversation, can run concurrently with
similar work, or produces intermediate output you don't need in full.

**When not to use it?** A quick, sequential step that depends on the main conversation's
context — dispatching a subagent adds overhead and loses that context.

**How to use it:** The dispatching skill decides when/how — which arguments and paths to
inject; the user doesn't invoke a subagent directly.

**Example:** `agents/qa-executor.md` — one instance per test-spec file in parallel mode, each
driving its own `playwright-cli` session.

**Pros and cons:**
- True isolation (own context, own tools) and real parallelism
- Keeps the main conversation's context window clean
- Loses the main conversation's context — must be given everything it needs explicitly
- Coordination/merging overhead — someone has to combine the results

## How a request flows through these

1. User types a request (natural language, or a `/command`).
2. If it's a command, Claude reads `commands/<name>.md`, substitutes `$ARGUMENTS`, and follows
   its steps.
3. Those steps (or the user's plain request directly) trigger a **skill** whose `description`
   matches — Claude reads that `SKILL.md` and follows it.
4. The skill's instructions may dispatch one or more **subagents** to do isolated or parallel
   work, and may run **scripts** via Bash for deterministic, mechanical steps.
5. Results flow back up: subagent → skill → command → user.

Next: [Architecture](./architecture.md) — how AgenTeX puts these pieces together.
