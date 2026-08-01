# Contributor Docs Track — Design

**Date:** 2026-08-01
**Status:** Approved by user
**Scope:** First of two content tracks (contributor/"geek" docs, then a user-manual pass later). This spec covers the contributor track only.

## Purpose

AgenTeX has a solid user-facing `docs/` folder (getting-started, per-feature docs, configuration) but essentially no contributor-facing content — only a short paragraph in the root README. This creates a new `docs/contributing/` track that teaches a newcomer, assumed to have **little to no prior Claude Code plugin knowledge**, everything needed to understand AgenTeX's architecture and add a new skill correctly.

## Structure

New folder mirroring the existing `docs/` pattern (index + one file per topic):

```
docs/contributing/
  README.md            — index table + PR-process pointer
  claude-code-101.md   — Claude Code primitives from zero
  architecture.md       — how AgenTeX composes those primitives
  adding-a-skill.md     — full worked example (toy "url-healthcheck" skill)
  conventions.md        — naming, no-employer-data rule, secrets, catalog-only principle
  testing.md             — script tests (node skills/*/scripts/*.test.js)
  pr-workflow.md         — fork/branch/PR, what's checked, CHANGELOG entry
```

The root `README.md` "Contributing" section is trimmed to a short pointer at `docs/contributing/README.md`, the same way it currently points at `docs/README.md` for users.

## Page contents

### `claude-code-101.md`
Claude Code concepts only, no AgenTeX specifics:
- What a **plugin** is (a bundle of skills/commands/agents installed via marketplace)
- What a **skill** (`SKILL.md`) is and when Claude loads it
- What a **command** is (`commands/*.md`, thin entrypoint, `$ARGUMENTS`)
- What a **subagent** is (e.g. `qa-executor`) and why work gets dispatched to one
- How a user request flows through these pieces end to end

### `architecture.md`
AgenTeX-specific composition, building on 101:
- `SKILL.md` = judgment/workflow only; `references/` = tool mechanics, read-before-first-use
- Deterministic-script principle: agent decides, script executes (`run_api.js`, `run_db.js`, `session.js`) — mechanical/security-sensitive work (catalog enforcement, DDL ban, param sanitization) lives in code, not agent reasoning
- Execution-tree output: `executions/execu_<timestamp>/` (report.md, extent-report.html, per-session logs/screenshots, merged bug list)
- How `qa-executor` subagents get dispatched per spec file in parallel mode vs. sequential human-in-the-loop
- Repo map: `skills/`, `commands/`, `agents/`, `docs/`, root config files

### `adding-a-skill.md`
Full worked build of a toy skill, **`url-healthcheck`** (checks whether a URL returns HTTP 200 — illustrative only, not a real shipped feature):
1. Naming it (noun-style, per convention)
2. Writing `skills/url-healthcheck/SKILL.md` (the judgment: when/why to check)
3. Writing `skills/url-healthcheck/references/mechanics.md` (the technical how)
4. Writing `skills/url-healthcheck/scripts/check_url.js` + `check_url.test.js`
5. Writing `commands/check-url.md` (thin entrypoint)
6. Updating `docs/contributing/README.md`'s example pointer and adding a `CHANGELOG.md` entry

Every step shows the actual file content for the toy example, not just descriptions.

### `conventions.md`
- Naming: noun-style skills (e.g. `browser-testing`), verb-style commands (e.g. `/execute-test`)
- No-employer-data rule: never ship org/project names, work-item IDs, work emails, vendor integration names in the published plugin
- Secrets: env-var only, never in catalog files or code
- Catalog-only principle: `api:`/`db:` steps execute only user-defined catalog entries, never agent-composed requests
- Shared-reference rule: centralize a reference into a shared skill only when a second consumer appears

### `testing.md`
- Running `node skills/<name>/scripts/<script>.test.js`
- What a script test should assert: catalog-only enforcement, param sanitization, DDL ban, etc.
- When a skill needs a script test (it does deterministic/security-sensitive work) vs. when it doesn't (pure-judgment skills like `extent-report`)

### `pr-workflow.md`
- Fork → branch → PR against `MhmdElGazzar/agentex` main
- Run script tests before opening a PR
- Keep the plugin generic — link to `conventions.md`'s no-employer-data rule
- Add a `CHANGELOG.md` entry under `[Unreleased]`
- What the maintainer checks on review

### `docs/contributing/README.md`
Index table in the same style as `docs/README.md`, one row per page above, plus a short paragraph pointing to `pr-workflow.md` for the actual contribution process.

## Out of scope
- The user-manual track (expanding/restructuring the existing `docs/` folder) — separate future spec.
- Any change to actual skill code, scripts, or behavior — this is documentation only.
- CI enforcement of any convention described here (e.g. automated employer-data scanning) — documentation describes existing manual practice, doesn't add tooling.

## Verification
Documentation-only change — verification is manual review: each page reads coherently standalone, the worked example in `adding-a-skill.md` is internally consistent (file paths/names match across its own steps), and root `README.md` + `docs/README.md` cross-links stay correct after the edit.
