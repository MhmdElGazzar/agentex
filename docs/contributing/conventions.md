# Conventions

Rules established across AgenTeX's build-out. Follow these for any new skill, script, or doc.

## Naming

**What:** skills = noun-style (`browser-testing`, `ask-kb`); commands = verb-style
(`/execute-test`, `/design-test`).

**Why:** the name alone signals capability vs. action.

**When:** every new skill/command.

**When not:** never — always applies.

**How:** `skills/<noun>/`, `commands/<verb>.md`.

**Example:** `ask-kb` (skill) + `/ask-kb` (command).

**Pros/cons:** + predictable, scannable — no real downside.

## Never ship employer/project-specific data

**What:** no real org/project/team names, work-item IDs, work emails, vendor names, or sprint
naming — anywhere, even as "examples."

**Why:** the plugin is public; strangers install it.

**When:** always, in this repo.

**When not:** never — real values live only in the consumer's own project (`.agentex/`,
gitignored there), never here.

**How:** resolve config from `AZURE_*`/`KB_*` env keys, or ask once per session.

**Example:** `.agentex/test-template.md` — generic template shipped, filled in by the user
later in their own project.

**Pros/cons:** + plugin stays publishable/reusable — but you can't hardcode a convenient
real-world shortcut.

## Secrets stay in the environment

**What:** catalog files and skill code hold **env-var names** only (e.g.
`tokenEnv: "MY_SERVICE_TOKEN"}`), never values.

**Why:** catalog files get committed; `.env`/the shell environment does not.

**When:** any secret — tokens, passwords, API keys.

**When not:** never — no exceptions.

**How:** catalog references the var name; the runner resolves it from `.env`/env at run time.

**Example:** `run_api.js`'s bearer/basic auth resolution.

**Pros/cons:** + secrets never leak into git — but one more layer of indirection to trace.

## Catalog-only execution

**What:** `api:`/`db:` test steps run only requests/queries predefined in the user's
`integration/` catalog.

**Why:** an agent must never improvise SQL/HTTP against a real system.

**When:** any test step that calls an API or database.

**When not:** never — an entry that isn't cataloged is `BLOCKED`, not worked around.

**How:** enforced in `run_api.js`/`run_db.js` (allowlist lookup), not left to agent discipline.

**Example:** `api: sample-api.get-todo(id=1) → expect HTTP 200`.

**Pros/cons:** + no runaway/unintended requests — but every call needs a catalog entry first.

## Shared-reference rule

**What:** centralize a reference file only once a **second consumer** needs it.

**Why:** avoids speculative shared modules nobody else uses yet.

**When:** a second skill needs the same reference content.

**When not:** only one skill uses it so far — keep it local to that skill.

**How:** move the file into the shared skill's `references/`, update both skills' pointers.

**Example:** `azure-devops-cli.md` moved into `azure-integration/references/` once a second
skill needed it.

**Pros/cons:** + no premature abstraction — but a brief window where content looks duplicated
right before the move.

## Deterministic scripts print one JSON line

Covered as its own concept in [Architecture](./architecture.md#deterministic-scripts-do-the-mechanical-work);
worked example in [Adding a Skill](./adding-a-skill.md).

Next: [Testing](./testing.md) or [PR Workflow](./pr-workflow.md).
