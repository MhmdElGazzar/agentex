# Changelog

All notable changes to AgenTeX are documented here.

## [0.13.0] — 2026-08-12
### Added
- **Behavioral eval suite** — new `evals/` folder with 9 cases in three families
  (trigger / negative / discipline), each as `prompt.md` + `graders/*.md`, with
  self-contained fixture projects for the db/api catalog-discipline cases. Layout follows
  `claude plugin eval` (early access); until it unlocks, cases run manually via fresh
  subagents — the 2026-08-12 baseline results are recorded in `evals/README.md`.

### Changed
- **Setup wizard rework** — 7-step flow: file import (BRD/PDF/Word) moved off the numbered
  steps to a dedicated screen; imported test users merge by handle instead of clobbering
  the list; environments can be added in isolation without changing the project default;
  per-step localized validation (environment/env-var names, at least one test user);
  secrets are written under the env var name the user chose; review & save reflects the
  screen exactly; the UI locks into a terminal done state after save; binary uploads are
  refused honestly with no temp-file litter.

### Fixed
- **`bug-report-azure` skill was undiscoverable at runtime** — its frontmatter description
  contained an unquoted `: `, so YAML parsing failed and the skill loaded with empty
  metadata (silently invisible in v0.12.0). Description is now quoted;
  `claude plugin validate` passes.
- **`/ask-kb` command loaded with empty metadata** — same unquoted-`: ` frontmatter issue
  in its description; now quoted.

## [0.12.0] — 2026-08-06
### Added
- **Interactive Setup Wizard** — `/init-test` now launches a local web-based setup wizard
  (`http://127.0.0.1:7373/setup`) immediately after scaffolding files. A dark-mode RTL
  Arabic UI guides the user through 8 ordered steps: project basics, test environment,
  test users (dynamic list), Azure DevOps, DB connection, API integration, AI file import
  (BRD/PDF/Word → Claude extracts fields automatically), and a review & save screen.
  Results are written directly to `config/project.json` and `environments/<env>.json`.
- `scripts/wizard/schema.json` — portable wizard step/field definition shared between
  the local plugin server and the planned website wizard (Phase 2).
- `scripts/wizard/engine.js` — config file mapper and validator with no external
  dependencies; usable by both the local server and a future web app.
- `scripts/wizard/ui.html` — self-contained wizard UI supporting `mode=local` (writes
  files via local server) and `mode=web` (downloads JSON files as a ZIP — Phase 2).
- `scripts/wizard/server.js` — zero-dependency Node.js HTTP server that serves the
  wizard UI, handles save/schema/config/extract/done API endpoints, and opens the
  browser automatically (Windows/macOS/Linux).

## [0.11.0] — 2026-08-06
### Added
- **Project config files** — settings split out of `.env` into their proper homes: new
  `config/project.json` (Azure org/project/team, KB settings, `login.mode`,
  `defaultEnvironment`) and `environments/<env>.json` (`portalUrl`, `defaults`, `users`
  keyed by descriptive handle, `db`, `api`). Full walkthrough and key reference in
  `docs/configuration.md`.
- `{ "envSecret": "NAME" }` convention: any secret-valued field in the JSON config
  (`password`, `token`) is either a plain string (team-known throwaway test credential)
  or a reference naming the `.env` variable holding the real value — the JSON files
  themselves never carry a secret.
- `--env` flag on `run_db.js` / `run_api.js` selects `environments/<env>.json` for the
  run; naming an environment with no file is an error (available environments are
  listed), never a silent fallback.
- `/init-test` scaffolding now creates `config/project.json` and a sample
  `environments/qa.json` alongside the (now secrets-only) `.env`.

### Changed
- `.env` becomes secrets-only. Every reader resolves the new config files first and
  falls back to the old `.env` variables (`QA_TARGET_URL`, `DB_*`, `AZURE_*`, `KB_*`)
  when the files or blocks are missing, so existing projects keep working unchanged.

## [0.10.0] — 2026-08-06
### Changed
- `/init-test` file scaffolding now runs as a bundled script (`scripts/init.js`) in a single
  call instead of agent-performed steps — deterministic, idempotent (`[created]`/`[skipped]`
  report, never overwrites, `CLAUDE.md`/`.gitignore` append-only), and it refuses to run
  inside the plugin folder itself. The command keeps the conversational steps (fill `.env`
  values, permissions reminder, playwright preflight) as agent instructions.

## [0.9.0] — 2026-07-28
### Added
- `optimize-login` skill: pay a web application's login cost once per session instead of once
  per test. Drive the login live, reduce it to the smallest script that works, verify by
  landmark, save `storageState`, then reload that session into a fresh browser and continue.
  Measured on a real project: ~197s of agentic login per scenario became **~38s once, then
  ~8s** per later run.
- `skills/optimize-login/scripts/session.js` — the only app-agnostic part, usable as a library
  (`isAuthenticated` / `saveSession` / `resumeSession`) or as a CLI
  (`session.js resume --state <path> --url <url> --absent <selector>`) to check whether a saved
  session is still alive. It verifies **before** saving, so a half-finished login cannot write
  a valid-looking state file, and **after** loading, because a state file outlives the session
  it describes — age is reported, never trusted (a 15-minute-old session was dead while a
  47-minute-old one restored cleanly).
- Authentication is verified by landmark, never by URL: a login page carrying
  `?returnUrl=/dashboard` satisfies any path-based check while the user is still logged out.

### Notes
- The skill deliberately ships **no catalogue of known login pitfalls**. Those are findings
  from exploring one application and belong in that application's notes (the page map's
  `gotchas`); shipping them as doctrine invites reading the next login through the wrong lens.
  What generalises is the loop, the landmark rule, and the session contract.
- Gates are surfaced, never defeated: a page-rendered captcha can be read by a person or the
  agent; reCAPTCHA/hCaptcha/Turnstile and received OTPs mean running headed and letting a
  person finish — the session is still saved afterwards. `storageState` covers cookies and
  localStorage only, so IndexedDB-based auth cannot be resumed this way.

## [0.8.1] — 2026-07-21
### Added
- `/ask-kb <question>` command — ask the project's Knowledge Base a question directly
  (standalone, outside a test run). `/ask-kb <project>: <question>` targets a project.
  Read-only, advisory only.

## [0.8.0] — 2026-07-21
### Added
- `ask-kb` skill: explicit `kb:` step to query a project's KB Ask API for advisory,
  natural-language answers (never used as PASS/FAIL evidence). Sends `x-api-key` from
  `KB_ASK_API_KEY` when set (never logged); maps `401` to a non-retryable BLOCKED, honors
  `Retry-After` on `429`, surfaces the `cached` flag, and documents the API's `sonnet` default.
- `kb:` step handling wired into `qa-executor` and noted in `browser-testing`; `.env.example`
  gains `KB_ASK_BASE_URL` / `KB_PROJECT` / `KB_ASK_API_KEY`.

## [0.7.0] — 2026-07-14

### Added
- **Deterministic runner scripts** — mechanical work moved from agent reasoning into code:
  - `run_api.js` (api-integration) — executes one cataloged API request via Node fetch:
    catalog-only enforcement, param validation, env resolution, evidence log, status/body
    assertions; prints PASS/FAIL/BLOCKED JSON.
  - `run_db.js` (db-integration) — executes one cataloged query via sqlcmd: catalog-only,
    **DDL ban and param sanitization enforced in code**, env-based connection
    (`SQLCMDPASSWORD` only), row-count assertions.
  - `preflight.js`, `init_run.js`, `merge_run.js` (browser-testing) — one-call tool checks,
    execution-tree scaffold, and bug-evidence merging.

### Changed
- Split the `integrations` skill into **`api-integration`** and **`db-integration`** (sharper
  triggering, engine-specific references/scripts/templates per skill).
- Consumer catalog folder renamed `integrations/` → **`integration/`**.
- References rewritten runner-first; curl/manual sqlcmd remain as documented fallbacks.

## [0.6.0] — 2026-07-14

### Added
- **`integrations` skill** — test scenarios can now include `api:` / `db:` steps (verify via
  API, check a DB row, seed data). Execution is **catalog-only**: the agent runs exclusively
  the named, parameterized requests/queries the user defines in the project-root
  `integrations/` folder (`*_api.json` via curl, `*_db.json` via sqlcmd/SQL Server) — it never
  composes its own SQL or HTTP. Writes run if cataloged; DDL (`DROP`/`TRUNCATE`/`ALTER`) is
  refused even if cataloged. Secrets stay in env vars — catalog files hold only env-var names.
- References: `api-requests.md` (curl preflight/install, auth, assertions, logging) and
  `sqlcmd.md` (preflight/install, env-based connection, substitution/escaping rules).
- Catalog samples scaffolded by `/init-test` into `./integrations/`.
- `qa-executor` and browser-testing now route `api:`/`db:` spec steps through the skill;
  results logged to the session's `logs/` as evidence.

### Changed
- Permissions: `curl` moved from deny to allow (it was browser-era theater); `sqlcmd` allowed.
- `.env.example`: new Integrations section (`API_BASE_URL`, `API_TOKEN`, `DB_SERVER`,
  `DB_NAME`, `DB_USER`; password via `SQLCMDPASSWORD`).

## [0.5.0] — 2026-07-14

### Added
- **`test-design` skill** — analyze a User Story's ACs into test conditions, map them to
  titled test cases, create them in ADO with structured steps (Steps XML), and link them
  `Tested By` to the story, ending with a coverage check. Project conventions (persona,
  journey step map, setup steps, languages, extra categories) live in the consumer project at
  `.agentex/test-template.md`, scaffolded from the bundled template on first run.
- **`/design-test <ids>` command** — entrypoint for the test-design flow.
- Reference `test-case-mechanics.md`: Steps XML format, file+`$STEPS` quoting trick,
  `TestedBy-Forward` direction rule, the CLI no-delete gotcha and DELETE-ME workaround.

### Changed
- Moved the shared `azure-devops-cli.md` reference from `task-estimation/references/` to
  `azure-integration/references/` — azure-integration is now the Azure toolbox shared by the
  ADO workflow skills (task-estimation, test-design).
- Recommended permissions: deny agent reads of `executions/**` run artifacts.

## [0.4.0] — 2026-07-14

### Added
- **`extent-report` skill** (contributed by @mabdel130, PR #1) — turns a finished run's results
  into a standalone interactive `extent-report.html` dashboard (dark theme, donut chart,
  per-status stat cards, expandable per-test-case steps) next to `report.md`, generated by
  `scripts/make_html_report.js`.
- browser-testing REPORT/MERGE steps now mention the optional dashboard.

### Fixed
- Donut chart rendered invisible when a single status covered 100% of the run (SVG full-circle
  arc collapse) — segments are now capped just under 360°.

## [0.3.0] — 2026-07-14

### Added
- **`task-estimation` skill** — estimates QA effort for Azure DevOps User Stories
  (complexity buckets from scenarios/fields/validations/integrations) and creates 5
  `[Testing]` tasks per story, one story at a time with confirmation.
  Reference: `references/azure-devops-cli.md` (`az boards` / `az devops` mechanics).
- **`/estimate-story [ids]` command** — entrypoint for the estimation flow; defaults to the
  current sprint's stories.
- `/init-test` now also scaffolds a keys-only `.env` (no values, no credentials) and ensures
  it's gitignored.
- `.env.example`: `AZURE_TEAM`, `AZURE_ASSIGNEE`, and the `AZURE_DEVOPS_EXT_PAT` shell-export
  auth pattern.
- Recommended permissions: `az boards` / `az devops` / `az extension` and read-only base `az`
  commands allowed; destructive ones (`work-item delete`, `webapp deploy`, `blob upload`,
  `aks get-credentials`, `group create`) gated behind a prompt.

### Changed
- `.env` is no longer denied to the agent — it may read config keys; secrets must never be
  printed or passed (instruction-level rule).
- Plugin description & keywords updated for the Azure DevOps estimation capability.

## [0.2.0] — 2026-07-13

### Changed
- Renamed the `website-qa` skill to **`browser-testing`**.
- Moved the Azure CLI reference out into a new **`azure-integration`** skill.
- Simplified `.env.example` to target URL + Azure DevOps values.
- Reduced recommended permissions to a `playwright-cli` wildcard allow.

### Added
- `/execute-test` and `/init-test` commands, bundled sample specs (`test/suite1/`), and the
  `executions/` output scaffold.

## [0.1.0] — 2026-07-12

- Initial release: `website-qa` skill (sequential & parallel modes), `qa-executor` subagent,
  `/qa-test` command, playwright-cli & azure-cli references, recommended permissions.
