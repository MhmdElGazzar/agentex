# Claude Code 101 — Concepts From Zero

This page explains the Claude Code building blocks AgenTeX is built from, with no AgenTeX
specifics yet. If you already know what a plugin/skill/command/subagent is, skip ahead to
[Architecture](./architecture.md).

## Plugin

A **plugin** is an installable bundle of capabilities for Claude Code: skills, commands, and
subagents packaged together, described by a `.claude-plugin/plugin.json` manifest (name,
version, author, description). Users install it from a **marketplace** — a git repo that lists
available plugins — with `/plugin marketplace add <repo>` then
`/plugin install <name>@<marketplace>`. AgenTeX itself is one such plugin.

## Skill

A **skill** is a folder under `skills/<name>/` containing a `SKILL.md` file. `SKILL.md` has two
parts:

- **YAML frontmatter** — `name` and a `description` written for Claude to decide *when* to use
  this skill. The description is matched against the user's request; write it like a trigger
  condition, not a summary.
- **Body** — instructions Claude follows once the skill is in play: role, rules, workflow steps.

Claude reads a skill's `SKILL.md` when its description matches the current task, then follows
its instructions for the rest of that work. A skill folder can also hold `references/` (details
read on demand, not upfront), `scripts/` (code the skill runs via Bash), and `templates/`
(starter files the skill scaffolds into the user's project).

## Command

A **command** is a file under `commands/<name>.md`. It becomes a slash command
(`commands/execute-test.md` → `/execute-test`). Its frontmatter holds a `description` (shown in
`/help` and used for usage hints); its body is the instructions Claude follows when invoked,
with `$ARGUMENTS` standing in for whatever text the user typed after the command name. Commands
are meant to be **thin** — a few steps that parse `$ARGUMENTS` and hand off to a skill, not
where the real logic lives.

## Subagent

A **subagent** is a separate Claude instance with its own context window, defined by a file
under `agents/<name>.md` (role, tools it's allowed to use, instructions). The main agent
*dispatches* work to a subagent — e.g. to run something in isolation, to parallelize independent
work, or to keep a long-running task's output from bloating the main conversation. The subagent
runs its task and returns a result to whoever dispatched it.

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
