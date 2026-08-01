# Conventions

Rules established across AgenTeX's build-out. Follow these for any new skill, script, or doc.

## Naming

- Skills are **noun-style**: `browser-testing`, `ask-kb`, `optimize-login` — what the
  capability *is*.
- Commands are **verb-style**: `/execute-test`, `/estimate-story`, `/design-test` — what the
  user is asking to *do*.

## Never ship employer/project-specific data

The plugin is published and installed by strangers — it must stay fully generic. Never commit,
even "as an example":

- Real organization, project, or team names
- Real work-item/story IDs
- Real work email addresses
- Real vendor/integration names
- Real sprint naming or cadences

Config that varies per install resolves from `AZURE_*` / `KB_*` keys in `.env`, or is asked for
once per session — never hardcoded. Project-specific conventions (like a team's test-case
naming scheme) live in the **consumer's own project**, e.g. `.agentex/test-template.md`,
scaffolded from a template the plugin ships — the template is generic, the filled-in copy is
the user's own and never leaves their project.

## Secrets stay in the environment

Catalog files (`integration/*_api.json`, `*_db.json`) and skill code hold **env-var names**
only (e.g. `tokenEnv: "MY_SERVICE_TOKEN"`), never values. Values live in `.env` (gitignored in
the consumer's project) or the shell environment, and are never printed or logged by any runner
script.

## Catalog-only execution

`api:` / `db:` test steps execute **only** requests/queries the user has defined ahead of time
in their project's `integration/` catalog. An agent never composes its own SQL or HTTP request
for these steps — a step naming an undefined entry is `BLOCKED`, not improvised. This is
enforced in the runner scripts (`run_api.js`, `run_db.js`), not left to agent discipline.

## Shared-reference rule

Don't centralize a reference file "just in case." Move it into a shared location only when a
**second consumer** actually appears — e.g. `azure-devops-cli.md` moved into
`azure-integration/references/` once a second skill needed it, making `azure-integration` the
shared "Azure toolbox."

## Deterministic scripts print one JSON line

Any script a skill dispatches via Bash should print exactly one JSON line —
`{"result":"PASS|FAIL|BLOCKED", ...}` — and exit 0/1/2 to match, so the calling skill can branch
on structured output instead of parsing prose. See [architecture.md](./architecture.md) and the
worked example in [adding-a-skill.md](./adding-a-skill.md).

Next: [Testing](./testing.md) or [PR Workflow](./pr-workflow.md).
