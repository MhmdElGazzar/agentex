# Changelog

All notable changes to AgenTeX are documented here.

## [Unreleased]
### Added
- **`/update-agentex` now checks whether the plugin itself is stale — before any project
  migration.** New bundled script `scripts/self_update.js` (`check`/`pull` verbs, one JSON
  line, exit 0/1/2) derives the marketplace and plugin identity from its own install path
  (`plugins/cache/<marketplace>/<plugin>/<version>` — never hardcoded), refreshes the
  marketplace's local cache, and compares versions with the same shared semantics the
  stamp-newer abort uses (`compareVersions` extracted to `scripts/lib/version.js`, required
  by both `migrate.js` and `self_update.js`, so the two gates can never disagree). When a
  newer version exists, the command asks exactly ONE confirmation (installed vs. latest,
  `plugin@marketplace`, what a yes does) — never a silent pull, never inform-only. After a
  successful pull the command STOPS with the instruction to run `/reload-plugins --force`
  (or restart) and re-run `/update-agentex`, so the migration runs entirely on the new
  version; the pull is verified deterministically against the refreshed cache (fail
  closed). A check that cannot run (offline, cache missing, not a marketplace install —
  e.g. a dev clone) and a pull that fails after consent are reported loudly and the
  migration proceeds on the installed version. CLI invocations are non-interactive with
  hard timeouts (win32 `.cmd` shim handled), covered by sibling unit tests
  (`self_update.test.js`, `lib/version.test.js`) and 4 new discipline evals
  (`discipline-update-agentex-{one-gate-pull,stop-after-pull,loud-check-failure,loud-pull-failure}`).

## [0.20.1] — 2026-08-28
### Fixed
- **Wrong exit codes from the tracker CLIs on Windows/Node 24.** A correct read could
  exit 127 after printing valid JSON: force-exiting after fetch work trips a libuv
  assertion (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c:94) on open undici
  handles, corrupting the exit code — the release gate observed it live on
  `create-cases.js story`. The five tracker CLIs (`create-cases.js`, `testplan.js`,
  `create-tasks.js`, `create-bug.js`, `read-workitem.js`) now print their one JSON line,
  set `process.exitCode`, and let the event loop drain — the `run_api.js` doctrine.
  Exit-code semantics (0/1/2) are unchanged, and each sibling test file structurally
  pins the pattern: the delivered script's source contains no `process.exit(`.

## [0.20.0] — 2026-08-27
### Added
- **A behavior-changing release must now prove itself as a consumer before it ships.** New
  maintainer-facing harness `scripts/release-gate/` — the mechanics under the release
  checklist's new Precondition 5 (E2E gate): `prepare.js` creates a genuinely fresh
  throwaway consumer project in the system temp dir (writes nothing into it — pre-seeded
  tracker keys are legacy signals that would send `init.js` down the migration branch;
  sentinel-vs-live mode auto-detected from the `EVAL_SENTINEL_PAT_` prefix, values never
  printed), `inject-env.js` copies the tracker env values into the throwaway `.env` only
  AFTER the wizard's `/api/done` — merge without clobbering wizard-written keys, fail
  closed like prepare,
  `verify-wizard.js` asserts every wizard answer landed in its documented home with secrets
  ONLY in `.env` — schema-driven from `scripts/wizard/schema.json`, so it cannot drift from
  the wizard, `verify-reports.js` requires `report.md` + `extent-report.html` to exist and
  reflect the run — every expected scenario's verdict adjacent to its name in each
  artifact's own vocabulary (caps `PASS`/`FAIL`/`BLOCKED` in report.md, the generator's
  `Passed`/`Failed`/`Blocked` pills in extent-report.html), fail-closed on any verdict
  outside that map, scenario names matched longest-first with word boundaries so a name
  that is a proper prefix of another can never borrow the longer card's verdict; the
  first live gate run caught its original single-vocabulary matcher failing all 8
  scenarios of a healthy extent-report.html, so its HTML tests now exercise the real
  `make_html_report.js` output instead of synthetic fixtures,
  `gate-ledger.js` keeps the teardown ledger (WritePlan-compatible entries
  plus `kind`/`type`/`disposition`, every `url` field stripped — ADO URLs embed the org),
  `teardown.js` settles every created id into a terminal disposition and finalizes a
  surviving ledger copy under `.claude/release-gate/runs/<ts>/` before the folder is
  removed, and `scan-secrets.js` greps every surviving artifact for the PAT (plus its
  base64 auth form) and the org/project values — compared in memory, never echoed. Exit
  codes carry the failure posture: 0 clean, 3 waivable (`undeletable-standard` Test Cases —
  ADO has no standard delete for test artifacts; always surfaced, never destroyed, never a
  destroy API call), 1 `FAIL` (any created id without a terminal disposition, or a secret
  in an artifact — the folder is then kept as evidence). The doctrine: every check that
  could produce a confident wrong `PASS` lives in deterministic, tested code, not in per-run
  agent reasoning — each script carries a sibling offline `*.test.js` (66 cases together).
- **The tracker adapter can now delete a work item — and only into the Recycle Bin.**
  `adapters/ado.js` gains `deleteWorkItem(id, {execute})`, backing the existing
  `deleteWorkItem: 'partial'` capability flag: `execute:false` returns the redacted DELETE
  descriptor and sends nothing, `execute:true` performs the standard (recoverable) delete.
  Permanent destroy is structurally impossible — no `destroy` option exists in the
  signature, and the id is validated to a positive integer before the URL is composed, so
  no input can put `destroy=true` on the route; the adapter tests assert exactly that.

- **Two flow scripts on the tracker layer** — estimation and test design get the same
  bundled-script mechanics bug filing got in 0.19.0, with zero new adapter surface:
  - `skills/task-estimation/scripts/create-tasks.js` — reads the current sprint's User
    Stories (WIQL `@CurrentIteration('[<project>]\<team>')`, `--team` as a run-only
    override) or named IDs, scans for existing `[Testing]` children, then validates a task
    spec fail-closed (story really is a User Story, iteration/area inherited fresh from
    the story — never trusted from the spec, `[Testing] ` title prefix, finite positive
    estimates, assignee never invented, `Activity=Testing` checked against the project's
    real field cache, one server-side `validateOnly` probe) and — only behind `--execute`
    — creates the tasks, one atomic create per task with the parent link inline (an
    unparented `[Testing]` task cannot exist), behind an exact per-write ledger.
  - `skills/test-design/scripts/create-cases.js` — reads a story for AC analysis, then
    validates a case spec fail-closed (duplicate-title check against the board that fails
    CLOSED when it cannot complete, in-spec title uniqueness, structured
    `{type, text, expected}` steps) and builds the `Microsoft.VSTS.TCM.Steps` XML itself
    (IDs from 2 incrementing by 1, escaping, the empty second `parameterizedString` — the
    quoting/8191-char command-line failure classes die in tested code); `--execute`
    creates one atomic Test Case per case with the `Microsoft.VSTS.Common.TestedBy-Reverse`
    link inline, so an unlinked or wrongly-linked case cannot exist. Same ledger.
  - Both: one JSON line, exit 0/1/2, dry-run default, offline sibling tests via the
    injected-fetch seam, PAT from `.env` into the Authorization header only.
- `references/tracker/ado-boards.md` — REST-flavored shared boards knowledge (field
  reference names, WIQL + the `@CurrentIteration` team-name gotcha, relation directions,
  the Test-Case no-delete constraint), replacing the az-flavored reference.
- **Two discipline evals** — `discipline-estimation-one-gate`,
  `discipline-test-design-one-gate` — one per flow's new consolidated-approval rule;
  recorded as authored, pending the release run on the installed build.

### Changed
- **`/estimate-story` and `/design-test` are one gate, fail-closed, and ledger-accounted —
  and no longer need the Azure CLI at all.** Estimation's per-story confirmations and
  test-design's free-standing condition-table round consolidate into ONE screen per flow:
  all reads and validation first with zero board writes, at most one bundled question
  round for genuinely unresolvable inputs, then the validated content plus the exact
  write plan on a single screen and ONE approval before `--execute`. The per-story
  analysis (factor counts → complexity bucket → the 5-task hours) and every documented
  outcome — 5 `[Testing]` tasks per story with iteration/area/Activity/estimates and the
  parent link, titled test cases with Steps XML and Tested By links, the coverage table —
  are unchanged; the coverage table's facts now come from the ledger plus a fresh story
  read instead of agent memory. The manual `AZURE_DEVOPS_EXT_PAT` shell export dies with
  the transport (the legacy name still resolves from `.env` for users who kept it).
- `skills/test-design/references/test-case-mechanics.md` rewritten for the script surface:
  spec shape, Steps-XML doctrine as the script builds it, link-direction facts; all az
  command blocks and the file+`$STEPS` trick removed.
- **Recommended permissions trimmed** (`settings.example.json`): the `Bash(az boards:*)`,
  `Bash(az devops:*)`, `Bash(az extension:*)` allows and the `Bash(az boards work-item
  delete:*)` ask are gone — no tracker flow issues `az` anymore, so the remaining az rules
  serve only the azure-integration skill (the Azure resource plane, unchanged by this
  release). Docs (`docs/azure-devops.md`, `docs/configuration.md`, `README.md`, the
  scaffolded consumer README template) updated to match.

### Fixed
- **The setup wizard now saves what its Figma step collected.** Typing a Figma File Key
  through the wizard and saving left `config/project.json` with the template's empty
  `fileKey` — the next `ui-check:` step then had no file to fetch its baseline from. The
  save path managed only the `azure` and `kb` blocks; the Figma answers were prefilled on
  a re-run and then silently dropped on every save (only the token *value*'s path to
  `.env` worked). The block is now written like the others — mirror-the-screen, in the
  documented `{ "fileKey": ..., "token": { "envSecret": ... } }` shape, with the
  `FIGMA_TOKEN` fallback db/api already had. Caught deterministically by the first live
  release-gate run (`verify-wizard.js`, defect W2); the other three optional groups were
  audited for the same gap — Azure DevOps and Knowledge Base ride the managed-block
  writer, DB and API ride the environment-file writer — Figma was the only orphan.
- **Angle-bracket text in a field hint renders instead of vanishing.** Hint text was
  interpolated raw into `innerHTML`, so the browser parsed the Figma hint's literal
  placeholder — `figma.com/design/<FILE KEY>/...` — as an HTML tag and swallowed it,
  hiding the one token the hint exists to explain (first live gate run, defect W1). All
  three hint injection points (standard fields, the read-only environment name, secret
  defaults fields) now escape, and the ui tests pin an angle-bracket placeholder
  rendering literally at each of them.
### Removed
- `references/tracker/ado-boards-cli.md` (az-flavored; kept in 0.19.0 explicitly "retired
  by Phase 2") — superseded by `references/tracker/ado-boards.md`. No `az` invocation
  remains anywhere in the task-estimation or test-design surface.

## [0.19.0] — 2026-08-26
### Added
- **A provider-neutral tracker layer** (`scripts/lib/tracker/`) — resolution
  (`resolveTracker`, fail-closed on no/many/unsupported providers), a `WritePlan` ledger
  (declared intents, first failure stops, no retry/no cleanup, IDs of completed steps
  survive a later throw), a per-project field-metadata cache
  (`.agentex/cache/tracker-fields-ado.json`, schemaVersion-stamped, gitignored by default
  with a documented `!.agentex/cache/` commit opt-in, `--refresh-fields` to rebuild), and
  an **Azure DevOps REST adapter** over Node's built-in fetch: work-item show/WIQL/create
  (with server-side `validateOnly`)/patch, attachment upload, field metadata with
  `$expand=allowedValues`, test-plan suites/cases/points, suite-entries add, and test
  runs/results. Capability flags (`validateOnly`, `attachments`, `testPlans`/`testRuns`,
  `relations`, `dialect`, `query`) are shaped so a future Jira adapter (plain-JSON
  dialect, JQL, no test-plan APIs, no Tested-By) fits without interface rework — a
  provider gap is detected and told to the user, never silently substituted. Zero runtime
  npm dependencies; every module carries a sibling offline test with an injected fake fetch.
- **Three bug-filing discipline evals** — `discipline-bug-filing-one-gate`,
  `discipline-bug-filing-ledger`, `discipline-bug-filing-cache-refresh` — one per new
  user-visible rule; recorded as authored, pending the release run on the installed build.

### Changed
- **Bug filing is one gate, fail-closed, and ledger-accounted — and no longer needs the
  Azure CLI at all.** The old flow forced 7 mandatory interactions (max 10) and ~10–12
  `az` process launches per filing; the PAT only reached `az` if the user remembered a
  manual `AZURE_DEVOPS_EXT_PAT` export (the likely root of the reported field failures);
  custom picklists were never pre-validated; a post-create failure hid the orphan bug's
  ID; and the duplicate check failed OPEN. Now `bug-report-azure` collects and validates
  everything first with zero board writes — parent story really is a User Story, the
  duplicate check **fails CLOSED**, severity/priority/custom picklists check against the
  **project's real values** (a stale cache rejection surfaces the live options with
  `cacheStale: true`), screenshots keep the two-pass evidence gate, and the server
  pre-validates the create — then shows ONE consolidated screen (validated fields + the
  exact write plan) and takes ONE approval. Writes run in a fixed fail-closed order
  (attachments → create → parent link → ReproSteps/evidence patch) behind an exact
  per-write ledger: done with ID + URL or not-done with the reason, created IDs always
  reported, nothing retried, no cleanup without the user. The PAT is read from `.env` by
  the scripts themselves and sent only in the Authorization header. Windows quirks die
  with the transport: no more cmd.exe quoting/@tempfile passing, no 8191-char
  command-line ceiling on repro HTML, no `PYTHONIOENCODING` workaround.
- **Test-case mechanics moved home.** `testplan.js` now lives with the skill that owns
  test cases — `skills/test-design/scripts/` — rebuilt directly on the tracker layer (no
  move-then-rewrite); bug filing invokes it cross-skill for create-case / fail with the
  same ledger guarantees (an orphaned Test Case or a run left InProgress is a named
  ledger line, never a silent state). The shared ADO boards CLI reference moved out of
  the Azure *resources* skill to the new plugin-root `references/tracker/ado-boards-cli.md`
  (consumers: task-estimation and test-design, which still drive `az` until their own
  migration); `azure-integration` now covers only the Azure resource plane. Every path
  that pointed at the old homes was re-pointed; `/estimate-story` and `/design-test`
  behavior is unchanged.
- **Scaffold/migration:** `.gitignore` gains `.agentex/cache/` (a cache, safe to delete,
  rebuilt on demand); the existing m05 picks it up on legacy projects and never re-adds
  the ignore line over a user's `!.agentex/cache/` commit opt-in.

### Removed
- `skills/bug-report-azure/scripts/_lib.js` (the az process launcher: `shQuote`,
  `@tempfile` arg passing, the cmd.exe `%VAR%` expansion guard, hardcoded
  severity/priority tables) and the old az-based `testplan.js` — superseded by
  `scripts/lib/tracker/` and the rebuilt scripts. No `az` invocation remains anywhere in
  the bug-filing surface.

### Credits
- Pattern harvest from **PR #16** (closed with credit, not merged): the `validateOnly`
  create pattern, the `uploadAttachmentBinary` and `patchWorkItem` fetch shapes, the
  `resolvePat` pattern (env order inverted to put the scaffolded `AZURE_PAT` first), the
  ledger's done/not-done messages, and the list-picklist semantics that became the
  field-cache builder.
- **PR #4** and **PR #11** (closed with credit, not merged): Jira operation semantics and
  field mappings, recorded as design input for the Phase-3 Jira adapter.

## [0.18.0] — 2026-08-25
### Added
- **A flake is reported, not retried away.** Nothing in the execution path said what to do
  when a scenario failed for a reason that had nothing to do with the app, so the call was the
  executor's to improvise — and both improvisations are harmful: a silent retry turns an
  intermittent defect into a green tick, and a defect filed against a network blip sends the
  tester after a bug that was never there. The browser-testing skill now carries a **Flake
  doctrine**, and `references/playwright-cli.md` a symptom list that separates "the app never
  answered" (retry once, that scenario only, from a clean state) from "the app answered and the
  answer was wrong" (a defect — never retried). A scenario that only passed on its one retry is
  **FLAKY**: out of the pass/fail tally, named in the tally line, reported under its own
  *Unstable results* heading with both attempts' evidence and the attempt-1 symptom verbatim,
  and kept out of `bugs/bug-list.md` because nothing is proven yet. The same app failure twice
  is a FAIL reported as reproduced on 2 of 2 attempts; the same infrastructure symptom twice is
  BLOCKED. `flaky` became a first-class status in `extent-report.html` — own color, stat card,
  donut segment, and a rollup that can never read green — and the orchestrator may not
  re-dispatch an executor to obtain a cleaner report, which is the same silent retry one level
  up.
- **The Setup Wizard speaks English.** The schema had carried `titleEn`/`labelEn` twins that
  nothing ever read, so a tester who does not read Arabic faced ~190 strings of Arabic-only UI
  with no way out of it. Every string now renders through `L(ar, en)` (the page's own copy) or
  `loc(obj, key)` (anything the schema supplies), with an EN/ع toggle in the header that redraws
  the current screen without losing what was typed, remembers the choice, and sets `lang`/`dir`
  so the layout reads the right way — four RTL-only CSS rules became logical properties. Arabic
  is still the boot default, so an existing tester sees exactly the wizard they had.
  `node scripts/wizard/server.js --lang=en` (or `/setup?lang=en`) opens it in English directly,
  and `/init-test` now addresses the user in whatever language they have been using instead of
  one hardcoded Arabic line. Twelve schema strings that had no English twin were written, and
  three new guards make a one-language string a test failure: every Arabic-bearing schema string
  must have a non-empty twin, every `L()` call must carry both sides, and the English copy of
  every screen must still be present.

### Fixed
- **A Figma rate limit no longer costs the tester every ui-check in the run.** A parallel
  regression is two Figma calls per `ui-check:` step, so a 19-step sweep fired 38 at once and
  the limiter answered 429 — a status `fetch_baseline.js` had no branch for, so all 19 checks
  BLOCKED on designs that had not changed in weeks. 429 and 5xx are now retried (`Retry-After`
  honoured, then exponential, plus jitter so 19 callers do not come back in the same instant
  and earn the same 429), and every successful fetch leaves a copy in `test/.ui-baselines/`,
  keyed on file key + node + scale with a sidecar carrying the dimensions, node identity and
  variants. That cache is a **fallback, never a first choice**: the live design is always
  fetched first, because a cache read that quietly stood in for a design that HAD moved would
  produce a confident wrong PASS — worse than any BLOCKED. So it is read only after a
  transient failure, never on a 403 or a 404 (broken config has to stay visible), never past
  the 7-day ceiling (`--cache-max-age-days`, and `--no-cache` turns it off), and never
  silently: a fallback emits `cached: true`, `cachedAt` and a reason, the skill requires that
  caveat in the step report, a conforming result is PASS + warning rather than a clean PASS,
  and a deviation names the cache date so nobody files a design *change* as a defect.
- **`/define-flow` no longer edits the file it was given.** Walkthrough mode forbade
  rewriting the user's spec and then instructed writing a note into it — invariant #11 with a
  hole in the middle, next to an ambiguous "the recorded step" that made reaching for the
  original the easy read. A definition session now writes exactly two things: its draft in the
  transient scratch, and the new spec file confirmed at ASSEMBLE. The cross-reference line
  keeps its value as an *offer* — the one line that may ever be added to an original, and only
  after the user says yes; a no is a complete outcome, and both paths are named either way.
- **`/optimize-login`'s session check actually runs on a QA machine.** `session.js` required
  `playwright` bare, which resolves through the PLUGIN's install directory — so a project
  that had run `npm i -D playwright` still got `Cannot find module` with a stack, curable
  only by a `NODE_PATH=` prefix buried in one doc line. It now resolves the package from the
  project (working directory upwards, monorepo hoists included, `NODE_PATH` still honoured)
  and, when it genuinely is missing, prints the install command instead of a resolver stack.
  It also hardcoded `channel: "chrome"`, demanding a Google Chrome install on machines where
  `npx playwright install chromium` had already provided a browser; the bundled Chromium is
  now the default, with `--channel` / `PLAYWRIGHT_CHANNEL` to opt into a real browser and no
  silent substitution when the one you asked for will not launch. New `--headed` flag.
  `preflight.js` probes the package the same way now, next to `playwright-cli`, so a missing
  library shows up as a preflight line instead of as a resume that dies mid-run.
- **A failed session resume no longer leaks a browser.** Only the landmark check closed the
  browser it had launched, so a bad URL, a navigation timeout or any context error left a
  headless browser running for the rest of the run — one per attempt, noticed as memory
  rather than as an error. Everything past launch now closes on the way out, and a missing
  state file is reported before a browser is started at all. Covered by a new
  `session.test.js` (16 cases) that fakes the browser, so it runs with no browser installed.
- **Logging in is the job, not a forbidden action.** The executor agent carried the rule
  "skip auth-gated actions: no real signup / login / checkout" while the rest of the plugin
  handed it test users, `defaults.password`, an `/optimize-login` skill and a `login.mode`
  setting — so an executor that read its own instructions literally skipped every scenario
  behind a login, which is most of them. The rule now says what is actually off limits
  (creating an account, completing a payment or any other irreversible transaction, real
  personal data) and names logging in with a configured test user as expected work; a spec
  naming a user the active environment does not define is BLOCKED, never improvised.
- **`login.mode` reaches the run that needs it.** The wizard collected it and
  `config/project.json` stored it, but no reader in the run path ever looked at it, so
  choosing "reuse the saved session" changed nothing. The orchestrator now resolves it
  alongside the environment (absent → `fresh`) and injects it into every executor as
  `LOGIN_MODE`, and the executor knows both branches. The wizard also wrote `"per-test"`
  where every doc and template said `"fresh"`; new projects get `"fresh"` and the old
  spelling keeps working as a synonym.
- **Saved login sessions are gitignored for real.** A Playwright storage-state file is a live
  bearer token, and the docs called `test/.auth/` "gitignored by convention" — but the only
  entry `/init-test` ever wrote was `.env`, so on every scaffolded project a `git add -A`
  after an `/optimize-login` run committed a working session. The shared scaffold action now
  ensures three entries — `.env`, `test/.auth/`, `.playwright-cli/` — appending only what is
  genuinely missing (a project already ignoring one under any common spelling keeps its own
  line), and migration **m05** (renamed `gitignore-env` → `gitignore-secrets`) backfills them
  into existing projects.
- **Spec files named in a non-Latin script get usable session names.** A session label is a
  spec file name, and sanitizing it to ASCII left nothing at all for an Arabic or CJK title —
  every such label collapsed to `-`, so a whole suite ran as `-`, `-2`, `-3` and the session
  name (which is also the screenshots/logs folder) no longer said which spec had failed.
  `init_run.js` now falls back to `spec<n>-<digest of the label>` — distinct per spec, stable
  across runs — trims leading/trailing separators from sanitized names, and echoes the label as
  given back on each session (`sessions[name].label`) so the report can print the spec's real
  title next to its ASCII session. Covered by a new `init_run.test.js`.
- **m03 env-split no longer resolves alias collisions by file order.** Six legacy names mean
  `portalUrl` and two mean `db.name`; when two of them held different values and the JSON
  field was unset, the first line in the .env won, the second was reported as "JSON wins over
  .env <KEY>" — about a value that had just been written from the .env in that same run — and
  its line was then deleted, discarding a value the tester had set. Entries are now grouped by
  target: agreement carries once and removes every alias, disagreement is left completely
  untouched (nothing written, no .env line removed) and raised as a `[manual]` item naming the
  colliding keys, which withholds the version stamp until the tester picks.
- **`settings.example.json` now matches what a run actually issues.** It allowed no `node`
  command while the plugin does all its non-browser work through nine bundled `node` scripts
  (a permission prompt at every one of them); `Bash(npm install *)` never matched anything
  (prefix rules need `:*`); `Edit(./src/**)` left `Write`/`MultiEdit` free to reach the same
  files; `Bash(rm -rf:*)` was defeated by `rm -fr` and by Windows `Remove-Item`; and `curl`/
  `sqlcmd` were pre-approved rather than prompted. Secret reads (`.env`, `*.pem`, `*.key`,
  `*.pfx`, `id_rsa*`, `.npmrc`, `test/.auth/`) are now denied, destructive git and delete
  commands are denied per spelling, and a `//notes` block explains each choice plus the two
  entries a tester must adapt. [docs/configuration.md](docs/configuration.md) no longer
  claims protections the file did not have.

## [0.17.0] — 2026-08-17
### Added
- **Customizable test-user fields — one shared, consumer-owned field schema.** The wizard's
  fixed user field set (phone/email/role/notes) and fixed defaults pair (password/OTP) are
  now descriptor arrays in the consumer's `config/project.json` (`userFields` +
  `defaultsFields`): defined once, shared across ALL environments — every user's form in
  every environment shows the same fields; only *values* are per-environment. A field-set
  editor affordance (users page + defaults section, never a step) adds, renames, removes,
  marks secret, and reorders fields: a **rename** migrates the key in every environment
  file in one batch save (riding the multi-environment save-all); a **removal** is
  consented with its blast radius (the environments holding values under the key) and both
  appear in the review's operations list. Removed/renamed-away keys are the one exception
  to the unknown-prop preservation rule — every other hand-added property still survives
  (invariant #11). A custom field can be **marked secret**: the wizard renders the
  established env-var-NAME + value pair (prefill `USER_<HANDLE>_<KEY>` per user,
  `DEFAULT_<KEY>` per defaults entry), the file stores `{ "envSecret": "NAME" }` and the
  typed value goes only to `.env` (invariant #5) — never to JSON, logs, or the review
  (names-only summary). The account **handle stays required and fixed** — it keys the
  `users` object and specs reference it. Engine/UI/server are schema-driven end to end
  (`buildUsers` whitelist removed); the save validates descriptor arrays (key pattern,
  uniqueness, reserved `handle`, `text|email|number|url` type vocabulary) and refuses
  invalid `envSecret` names in user/defaults entries. First-time users who customize
  nothing get exactly the historical built-in set; the effective arrays are always written
  back to `config/project.json` (explicit round-trip, no hidden divergence).
- **Migration m11 `user-field-schema`** — backfills the built-in `userFields`/
  `defaultsFields` arrays into an existing `config/project.json` that carries none
  (m09-style: additive, idempotent, only the missing array is added, a customized schema
  is never rewritten, environment files and user values are never touched). The
  `config/project.json` template ships the same arrays for fresh scaffolds.
- **Multi-environment wizard — one session manages every environment.** The setup wizard
  now shows all environments (on disk or added this session) on a new environments-manager
  page that opens the environment group, with state badges (on disk / new / edited /
  default) and explicit controls. Add asks interactively whether to start blank or copy
  **safe sections** from an existing environment — test-user values and defaults values
  only; connection targets (portalUrl, db, api) are never offered and never inherited.
  Rename and delete — the wizard's first destructive capability — sit behind double
  consent (a confirm dialog naming the exact file operation, then the review step's
  operations list) and execute only through the one batch save: `/api/save` takes every
  dirty/new environment plus explicit `ops` (each carrying `confirmed: true`), validated
  whole by the engine's `planSave` — un-consented ops are refused, rename sources and
  deletes must name files the project actually has, collisions and path escapes are
  refused, at least one environment must remain after all ops, and the final
  `defaultEnvironment` must name a post-save file (invariant #10 extended over the
  rename/delete arithmetic); the response echoes every file op performed. Renaming the
  default updates `defaultEnvironment` inside the same confirmed save; deleting the
  default requires designating a new one in the same dialog; adding never re-points it
  (first-configured-claims-default unchanged). The environment-name field is now a
  read-only label whose one rename affordance routes through the confirm dialog — the
  accidental type-a-new-name fork is gone. Editing prefills from each environment's own
  file and merges back onto it, now including per-user entries (hand-added user
  properties survive a save — invariant #11). On a 2nd+ environment the db/api
  env-var-name fields prefill a suffixed suggestion (`API_TOKEN_UAT`) so two environments
  don't silently share one `.env` secret slot. `/api/config` enumerates every
  environment (unreadable files are flagged and excluded from editing; pristine samples
  are reported by name only, never as editable data); the legacy single-environment save
  payload is still accepted.
- **Knowledge Base wizard page** — the `kb` block of `config/project.json` was buildable
  by the engine and fillable by text import, but had no page. A new optional project-group
  page collects `kb.baseUrl` + `kb.project`, and the KB Ask API key goes to `.env` under
  the fixed `KB_ASK_API_KEY` name that `ask_kb.js` reads (secret field, never written to
  JSON, never shown).
- **Migration m10 `phantom-sample-env`** — detects a pristine leftover sample sitting
  under a non-default name beside a real environment (all three conditions must hold; a
  lone pristine sample on an unconfigured project is legitimate scaffolding) and emits a
  `[manual]` offer that withholds the version stamp. Removal happens only through the
  consented re-run `node scripts/migrate.js --remove-phantom-sample` — the engine's first
  consent-flag (`ctx.flags`) — never silently; renaming the file or changing any value in
  it (claiming it) also clears detection. `/update-agentex` relays the offer and re-runs
  the engine with the flag only after explicit user confirmation.

### Changed
- **Wizard pages map one-to-one to config files.** The setup wizard's steps are reordered
  into two labeled, contiguous groups that mirror the config model instead of interleaving
  it: first the project group (Project Basics → Azure DevOps → Figma → Knowledge Base, all
  writing `config/project.json`), then the environment group (Environment → Test Users →
  Database → API, all writing `environments/<name>.json`), then review. Every card head
  carries a monospaced target-file chip naming the ONE file that page writes (live-updating
  with the environment name); the steps track shows the group labels. The environment-name
  field moved off the first page to the top of the environment group — naming the file is
  the first act of environment configuration, not a project setting — and its answer key is
  renamed `defaultEnvironment` → `envName` everywhere (schema, engine, text-extraction
  labels, UI). `project.json.defaultEnvironment` remains derived output only
  (first-configured-claims-default, unchanged). The review step is schema-driven — one tab
  per file-keyed output, a names-only `.env` keys summary (values never shown) — and its
  reconciliation notice now enumerates **every** pristine sample the save will remove
  (`/api/config` reports the full `pristineSamples` list, the same scan the save uses),
  not just the one under the default name. Prefill/preserve semantics (invariant #11) are
  untouched: only where fields appear changed, never what saving preserves.
- **Default environment name is `qc` (was `qa`)** — still a prefilled, freely editable
  default, not a presumption, and now one shared constant (`DEFAULT_ENV_NAME` in
  `scripts/wizard/engine.js`, required by `server.js` and `migrate.js`, mirrored by the
  schema default/placeholder and the `ui.html` fallbacks). The sample template is
  `templates/environments/qc.json`; legacy migrations on projects without a
  `config/project.json` now create `environments/qc.json`.

### Fixed
- **Environment name integrity — no phantom sample environment.** The scaffold used to
  copy the sample environment unconditionally, so a wizard save under any other name left
  it behind as a never-configured environment that runs could silently resolve against.
  The sample is now copied only when `environments/` has no environment files at all (one
  rule shared by `/init-test`, its re-runs, and m07 fill-gaps); the wizard's save
  reconciles away a differently-named sample that is *structurally pristine* — identical
  to a sample shape the plugin ever shipped, i.e. zero user values — listing the removal
  on the review step first and echoing it in the save response (`reconciled: [...]`);
  `/api/config` reports pristine scaffolding (`samplePristine`/`projectPristine`) instead
  of prefilling it as "your existing configuration". First-configured-claims-default: a
  `defaultEnvironment` pointing at a pristine sample (or at no file) is scaffolding, so
  the first environment the user actually configures claims it — and `/api/save` rejects
  any save whose final `defaultEnvironment` would name no post-save file. A file that
  differs from the sample in any value is user-touched: prefilled, protected, and never
  reconciled.

## [0.16.1] — 2026-08-14
### Fixed
- **Browser-session isolation across concurrent executions.** The shared playwright-cli
  `default` session is now prohibited in every mode. Sequential runs and define-flow
  sessions previously used it, so two executions on one machine — e.g. two Claude Code
  windows — landed on the same browser and could kill each other's session. `init_run.js`
  now generates each run's unique session names (label + time + random tag,
  collision-checked against every existing execution; the label `default` is rejected),
  sequential mode scaffolds its run folder before the first browser action, define-flow
  generates its own unique session name, and teardown discipline is explicit everywhere:
  an execution closes ONLY the sessions it created — `close-all` / `kill-all` never run
  as part of an execution (a user-requested global cleanup is the only exception).
  `settings.example.json` now gates `close-all` / `kill-all` behind an `ask` prompt.

## [0.16.0] — 2026-08-13
### Added
- **`/define-flow` — guided flow definition.** The flow is defined by doing it, not by
  writing it: an agent-led session proposes each step, executes it in a live browser the
  moment the user agrees, and the user asserts the actual outcome before the next step is
  defined. Forward-only correction, one sitting; values a step surfaces — and user-supplied
  inputs that must be unique per run (e.g. a registration email) — are captured
  symbolically / as fresh disposable data so fresh runs resolve them live; each confirmed
  step is appended immediately to a scratch draft (a late crash loses nothing confirmed);
  integration steps stay catalog-only; the
  session writes no `executions/` evidence (only the offered validation run does). Output
  is a normal natural-language spec (stateful chain, existing conventions) saved under the
  project's suite folder and runnable unmodified via `/execute-test`. Pointing the command
  at an existing spec walks it step by step, clarifies unclear steps with the user, and
  saves the defined flow as a new file — the original gains only a top note pointing to it.
- Eval cases `trigger-define-flow`, `discipline-define-flow-execute-before-next`,
  `discipline-define-flow-forward-only`, `discipline-define-flow-symbolic-values`
  (automated lane), plus a live-lane log in `evals/README.md` for manual define-flow
  sessions against a public practice target.

## [0.15.0] — 2026-08-13
### Added
- **`ui-check:` spec steps — design conformance inside test runs.** A scenario can now
  assert "this screen matches the approved design" as an executed, evidenced step:
  `ui-check: figma <node-id|frame URL>` or `ui-check: image <path>`, each with
  `mode: exact` (every visible detail; no silent tolerance — suspected rendering noise
  is confirmed with the user before any verdict) or `mode: reference` (only the
  enumerated details can fail; layout drift is a warning). A new `ui-check` skill owns
  the semantics; the bundled `fetch_baseline.js` resolves baselines deterministically
  (Figma REST render downloaded before the short-lived URL expires, node-id
  normalization, variant enumeration, structural image validation) and exits
  OK/BLOCKED only — an unresolvable baseline is BLOCKED with a named reason, never
  improvised. Same form factor is mandatory (mismatch = a named **view mismatch
  error**, never PASS/FAIL); named viewports ship with defaults (desktop 1440×900,
  tablet 768×1024, mobile 390×844), overridable via a `viewports` block. Both images
  land in the run's evidence tree; a failed check files through the existing Azure bug
  flow with baseline + actual attached. Docs: `docs/ui-check.md`.
- **extent-report: first-class `warning` and `viewMismatch` statuses.** The
  run-summary JSON contract widens from 5 to 7 statuses — own colors, pills, stat
  cards, legend rows, and donut segments; coverage counts both as exercised. Backward
  compatible: run-summary JSONs without the new keys render exactly as before.
- **Figma config plumbing.** `config/project.json` template gains the `figma` block
  (`{ "fileKey": "", "token": { "envSecret": "FIGMA_TOKEN" } }`), `.env.example` the
  `FIGMA_TOKEN=` key, the setup wizard an optional Figma step, and
  `scripts/migrations/09-figma-config.js` adds both to existing projects
  additively/idempotently (house rule: scaffold-convention change ⇒ migration).
- Eval cases: `trigger-ui-check` plus four discipline cases
  (`blocked-baseline`, `view-mismatch`, `reference-mode`, `exact-noise`) with
  schematic screenshot fixtures — no network needed.

### Changed
- Wizard UI polish: SVG logo mark (replaces the emoji glyph), real stepper
  connector elements instead of the `::before` hack, intro layout/spacing cleanup.

### Fixed
- **bug-report-azure: untrusted text no longer touches the shell command line.** On
  Windows `cmd.exe` re-parses the command string and expands `%VAR%` even inside
  double quotes, so bug titles, area paths, assignees, etc. could break the `az` call
  or leak secret environment variables. All untrusted values now reach `az` through
  its native `@<tempfile>` argument mechanism — only an inert file path hits the
  shell. Covered by new unit tests for `_lib.js`, `create-bug.js`, and `testplan.js`.

## [0.14.0] — 2026-08-13
### Added
- **`/update-agentex` — project migration command.** Updating the plugin never
  updated the consumer project; now one command migrates a project scaffolded by ANY
  older version to the installed version's conventions. A bundled engine
  (`scripts/migrate.js` + one state-detecting module per migration under
  `scripts/migrations/`) does every file change deterministically: renames
  `integrations/` → `integration/`, absorbs legacy `agentex.config.json` KB settings,
  splits a keys-only `.env` into `config/project.json` + `environments/<env>.json`
  (values carried into their new homes — never reset; secrets and unrecognized keys
  stay in `.env` untouched), carries catalog `connection` blocks into the environment
  `db` block (catalogs themselves only flagged), ensures the `.gitignore` entry and
  `CLAUDE.md` bullet, fills missing scaffold pieces, and flags spec-convention drift
  without ever rewriting user specs or old `executions/` runs. Apply-then-report;
  clean git tree required (git is the rollback; the gitignored `.env` is rewritten
  loss-proof by writing JSON homes first); idempotent (second run: zero writes,
  "already up to date"); an interrupted run is completed by committing (or
  git-restoring) the partial state and re-running.
- **Version stamp** `.agentex/version.json` — written by `/init-test` at scaffold
  time and refreshed by every migration; stamp-less legacy projects are inferred
  from their files on first run.
- Eval case `discipline-update-agentex-relay` — the agent must run the engine, relay
  its report, hand-edit nothing, and print no secret values.
- Contributing rule: any PR changing scaffold conventions must ship a
  `scripts/migrations/` module (see `docs/contributing/conventions.md`).

### Changed
- `scripts/init.js` now delegates to the shared scaffold library
  (`scripts/lib/scaffold.js`) and stamps `.agentex/version.json` on first scaffold;
  the wizard's legacy `.env` key mapping moved to `scripts/lib/env_key_map.js`,
  shared with the migrator. No behavior change to scaffolding itself.

### Fixed
- Wizard test suite no longer launches a real browser on every run: `server.js`
  gained a `--no-open` flag and `server.test.js` always passes it. The `/init-test`
  user flow is unchanged (browser still opens for the human).
- README version badge tracks releases again (was stuck at 0.8.1).

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
