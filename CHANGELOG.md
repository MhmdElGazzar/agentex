# Changelog

All notable changes to AgenTeX are documented here.

## [Unreleased]
### Added
- **`endpoint-testing` skill** — standalone sanity/regression pass over cataloged API
  endpoints, independent of any browser test spec (the "Standalone API test suites" row
  flips from planned to available). New `integration/suites/*.json` case files reference
  `integration/*_api.json` entries by name and supply the concrete params/expected result a
  standalone run needs — one entry can have multiple cases (happy path, not-found, …), each
  tagged `sanity`/`regression`.
- `run_suite.js` — deterministic runner that filters suite cases by scope and shells out to
  `api-integration`'s `run_api.js` per case (never duplicates its catalog/auth/assertion
  logic), aggregating one PASS/FAIL/BLOCKED summary.
- `agents/api-executor.md` — subagent (sibling to `qa-executor`) that runs a suite scope in
  one call and returns a consolidated defect report, keeping per-case logs out of the
  orchestrator's context.
- `/test-endpoints [sanity|regression|all]` command — entrypoint for the standalone flow;
  scaffolds `integration/suites/sample_suite.json` on first run.
- **`swagger-import` skill** — generates a catalog (`integration/*_api.json`) and suite
  (`integration/suites/*_suite.json`) from a Swagger 2.0 / OpenAPI 3.x JSON document (local
  file or URL), via `import_swagger.js` and the `/import-swagger <path-or-url> [--name
  <service>]` command. Picks one supported auth scheme per catalog file (`bearer` > `apiKey`
  header > `basic`), flags unsupported schemes (oauth2/openIdConnect) and every generated
  best-effort value (param examples, request bodies, "not found" placeholders) for manual
  review instead of guessing silently. Never overwrites an existing catalog/suite file.
  JSON-only input (no YAML parser); Postman import and response-schema/contract validation
  are explicitly out of scope.
- `run_api.js`: two small additive extensions needed for imported entries to work against
  real specs — `auth.type: "apiKey"` (custom header auth) and a query-string fallback for any
  declared param not consumed by a `{name}` path placeholder (previously silently dropped).
  Backward compatible; existing catalogs are unaffected.

### Fixed
- `import_swagger.js`: found while testing against a live public OpenAPI spec — relative
  `servers[].url` values (e.g. `"/api/v3"`, common in real specs) were used literally instead
  of being resolved against the spec's own host; now resolved when the spec was fetched from
  a URL (flagged for manual review when imported from a local file, since there's no origin
  to resolve against). Also: enum-typed params now use the first enum value instead of a
  generic placeholder (e.g. a `status` param picks its first valid value), and array-typed
  params are explicitly flagged in `review` — a single representative value is generated, not
  full OpenAPI array-serialization (`style`/`explode`), which remains a known limitation.

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
