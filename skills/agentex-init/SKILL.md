---
name: agentex-init
description: Initialize AgenTeX in the current project for OpenAI Codex. Use when the user asks to set up or initialize AgenTeX, create its QA test project, or prepare a project for AgenTeX browser tests.
---

# Initialize AgenTeX under Codex

1. Identify the installed plugin root from this skill's absolute `SKILL.md` path
   (`../..`). Run `node <plugin-root>/scripts/resolve_plugin_root.js` and use the
   returned `root`; the resolver accepts `AGENTEX_PLUGIN_ROOT`, then the legacy
   `CLAUDE_PLUGIN_ROOT`, then its own script location. Stop if it reports an error.
2. From the **consumer project root**, run `node <plugin-root>/scripts/init.js`.
   This is the shared, idempotent scaffold. It never overwrites existing files.
   Never run it from inside the AgenTeX plugin repository itself.
3. Relay the script's created/skipped summary. Do not read or print `.env` values.
4. If project configuration needs user input, run the shared setup wizard with
   `node <plugin-root>/scripts/wizard/server.js <consumer-project-root>` and give
   the user its local URL. The wizard handles its own save and shutdown. Do not
   claim configuration is complete until it finishes.
5. Explain that `integration/` is the allowlist for `api:`/`db:` steps, and that
   the sample specs need editing before testing a real app. Check Node and
   `@playwright/cli` availability before offering a first browser run; do not
   silently install dependencies.

The shared scaffold still writes its existing `CLAUDE.md` guidance for Claude
users. Codex reads this installed skill directly, so Phase 2 creates no consumer
`AGENTS.md`; preserve any existing `AGENTS.md` byte for byte. Codex sandbox and
tool approvals remain governed by the user's Codex configuration, never by the
Claude `settings.example.json` permission syntax.
