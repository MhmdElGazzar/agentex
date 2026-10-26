# Contributing to AgenTeX

Documentation for anyone building or extending the plugin itself — as opposed to
[docs/](../README.md), which covers *using* it.

| Doc | What it covers |
|-----|----------------|
| [Claude Code 101](./claude-code-101.md) | Plugins, skills, commands, subagents — from zero. |
| [Architecture](./architecture.md) | How AgenTeX composes those primitives: SKILL.md/references split, deterministic scripts, execution output, the qa-executor subagent. |
| [Adding a Skill](./adding-a-skill.md) | Full worked example — build a toy skill end to end. |
| [Adding a Capability](./adding-a-capability.md) | Checklist for something bigger than one skill — its own subagent, command, and docs page (real example: `mobile-testing`). |
| [Conventions](./conventions.md) | Naming, the no-employer-data rule, secrets, catalog-only execution. |
| [Testing](./testing.md) | Running and writing script tests. |
| [PR Workflow](./pr-workflow.md) | Fork → branch → PR, what's checked on review. |
| [Host Branches](./host-branches.md) | How `main` becomes the `store`, `copilot`, `devin` and `codex` branches, and what breaks a host build. |
| [Writing User Docs](./writing-user-docs.md) | Define before use, say the consequence, and the blind reader test that checks a README or `docs/` page before a release. |
| [Writing a Good Skill](./writing-a-good-skill.md) | The quality of a `SKILL.md`: a description that triggers, hard rules first, size and compaction limits, writing rules, scripts for fixed mechanics, frontmatter mistakes. |
| [Writing an Orchestrator Skill](./writing-an-orchestrator-skill.md) | A skill or agent that dispatches worker subagents: where it lives, the worker contract, deferred questions, one gate before writes, batches, hooks for dangerous rules. |

New to Claude Code plugins entirely? Start at [Claude Code 101](./claude-code-101.md). Already
comfortable with plugins/skills/commands and just want to add something? Jump straight to
[Adding a Skill](./adding-a-skill.md).

Ready to open a PR? See [PR Workflow](./pr-workflow.md).
