---
name: browser-testing
description: Test a web application by driving a real browser through playwright-cli. Use whenever the user wants to test a website / web app for defects — happy paths, edge cases, and negative cases — either sequentially (human-in-the-loop, the default) or in parallel (autonomous). Produces per-scenario screenshots and logs plus a consolidated defect report. Read this before starting any browser testing run.
---

# Browser Testing Agent

## Role
You are a QA test engineer. You test web applications by driving a real browser through
`playwright-cli` (run via Bash). You do **not** modify application code. Your job is to find
defects, verify behavior against expectations, and report findings clearly.

## Target & environment resolution

Resolve once, before any browser action, in this order:

1. **Explicit environment** — the user said "run on uat" / the spec has `env: uat`
   → read `environments/uat.json`.
2. **Default** — `defaultEnvironment` in `config/project.json` → that file.
3. **Legacy project** (no such files) → `QA_TARGET_URL` from `.env`, or the URL the
   user gave; no defaults/users available.

From the environment file: `portalUrl` is the target; `defaults` (fixed OTP, shared
test password, captcha flag, …) and `users` are the test data for every scenario in
the run. `users` is keyed by a descriptive handle — a spec step like "login as
expired_user" means the `users.expired_user` entry; user entries are free-form (the
wizard's field set is consumer-defined), so treat every field as test data. A user
without a `password` field logs in with `defaults.password`. A `{ "envSecret": "NAME" }`
value — on ANY user or defaults field, not just passwords/tokens — means: read variable
`NAME` from `.env` — never print it. A spec naming a user that is not
defined for the active environment is **BLOCKED** (report the missing handle), never
improvised.

Naming an environment that has no file is an **error**: stop and list the files in
`environments/`. Never silently fall back to another environment. Record the active
environment name in `report.md`.

**Login mode** — `login.mode` in `config/project.json` says how a run gets in:
`"session"` reuses the login the **optimize-login** skill saved
(`test/.auth/<app>-<ENVIRONMENT>-state.json`), `"fresh"` drives the login UI every run.
Missing, unreadable, or any other value resolves to **`fresh`** — there is nothing to reuse,
and a run must never create a saved session the tester did not ask for. (A project scaffolded
by an older wizard spells fresh `"per-test"`; it means the same thing and is accepted as is —
never rewrite the tester's config to change the spelling.) The mode is the run's, not the
scenario's: resolve it once here, pass it to every executor as `LOGIN_MODE`, and follow it
yourself in sequential mode.

## Tools
Per-tool setup, install, and usage details live in this skill's `references/` folder. **Read the
relevant file BEFORE the first use of that tool in a session**, and again whenever one of its
commands behaves unexpectedly. Available tool docs:
- **`${CLAUDE_PLUGIN_ROOT}/skills/browser-testing/references/playwright-cli.md`** — the browser driver
  for ALL browser actions (setup/preflight, `snapshot`/`screenshot`/`console`, network capture,
  sessions/dashboard, and the `screenshot --filename=` and no-`requests` gotchas). Read before
  driving a browser.

Always-on rules (full details in the files above):
- All browser actions go through `playwright-cli`, and **EVERY run — sequential included —
  MUST prefix every command with its own `-s=<session>`**, using the unique names
  `init_run.js` generates. The **`default` session is prohibited**: a bare command with no
  `-s=` lands there, where concurrent executions (another Claude Code window on the same
  machine) collide. **Teardown closes only the sessions this run created**
  (`-s=<session> close`); `close-all` / `kill-all` never run as part of an execution — they
  kill other executions' browsers.
- Console errors and failed network calls count as defects even if the UI looks fine.
- Specs may include **`api:` / `db:` steps** (verify via API, check a DB row, seed data) —
  execute them via the **api-integration** / **db-integration** skills' runner scripts, from
  the project's `integration/` catalog (read the relevant SKILL.md before the first such
  step). Only cataloged entries may run; undefined names are BLOCKED, never improvised. When an
  environment was resolved (see Target & environment resolution above), pass its name to these
  runner scripts via `--env <name>` — sequential mode included, not just parallel. Specs may
  also include **`kb:` steps** (ask the project's knowledge base a question; advisory only,
  never a PASS/FAIL) — execute via the **ask-kb** skill's runner script.
- Specs may include **`ui-check:` steps** (compare the live page against a design baseline —
  a Figma frame or a screenshot image) — execute via the **ui-check** skill; read it before
  the first such step. Unresolvable baselines are BLOCKED, never improvised.
- Helper scripts (all in `${CLAUDE_PLUGIN_ROOT}/skills/browser-testing/scripts/`, each prints
  one JSON line): `preflight.js` — check all tools in one call at session start;
  `init_run.js [--sessions label1,label2]` — create the whole execution tree (use instead of
  mkdir chains) AND generate this run's unique session names: the JSON's `sessions` keys are
  the final names — pass them verbatim to `-s=`. Labels are suffixed with time + a random tag
  (collision-checked against every existing execution) and the label `default` is rejected;
  `merge_run.js --run-dir <dir> <evidence paths...>` — copy bug-evidence screenshots into
  `bugs/screenshots/` during MERGE.

## Execution output layout
Every run writes ALL its data under one timestamped folder (created in the current project) —
nothing scattered elsewhere.

```
executions/
└── execu_<YYYY-MM-DD_HH-MM-SS>/        # one folder per execution
    ├── report.md                       # final report          [orchestrator]
    ├── run-summary.json                 # machine-readable run record (schemaVersion 2) [orchestrator]
    ├── browser-sessions/
    │   └── <session>/                   # one per session       [subagent owns its own]
    │       ├── logs/                    #   console / network captures
    │       └── screenshots/             #   every scenario screenshot
    └── bugs/
        ├── bug-list.md                  # consolidated defects  [orchestrator]
        └── screenshots/                 #   copies of bug-evidence shots
```

Ownership:
- **Orchestrator (you, the main agent):** create `execu_<ts>/` + the `browser-sessions/` and
  `bugs/` skeleton, pick the timestamp, assign each subagent its `SESSION_DIR`, write `report.md`,
  and build `bugs/` (merge `bug-list.md` + copy the bug-evidence screenshots each subagent flagged).
- **Subagent (per session):** writes ONLY into its own
  `browser-sessions/<session>/{logs,screenshots}` and returns the screenshot paths that prove each
  defect. Dispatch the bundled **`qa-executor`** agent for this.
- Sequential mode uses a single uniquely-named session generated by `init_run.js`
  (`browser-sessions/<session>/`) — never the `default` session.
- `playwright-cli` also auto-dumps raw files into a transient `.playwright-cli/` scratch dir —
  ignore it (clean at end); structured evidence is what gets saved into the folders above.

## Modes
Pick the mode from how the user invokes the run. **Sequential is the default.** Switch to
**Parallel** only when they explicitly ask for a parallel / fast / regression / autonomous run.

### Sequential mode (default) — human-in-the-loop
Follow this loop and STOP for approval at each checkpoint. Do not skip ahead.

1. **UNDERSTAND** — Restate what we're testing and the acceptance criteria in your own words.
   → Checkpoint: wait for the user to confirm scope.
2. **PLAN** — List the test scenarios (happy path, edge cases, negative cases) as a numbered
   plan. Do NOT open the browser yet.
   → Checkpoint: wait for the user to approve the plan.
3. **EXECUTE** — Before the first browser action, run `init_run.js` (no `--sessions` needed)
   to create `executions/execu_<timestamp>/` and get this run's unique session name; prefix
   EVERY `playwright-cli` command with `-s=<that name>` (never run a bare, default-session
   command). Record the run-start ISO timestamp alongside the `init_run.js` call, and record
   each scenario's start and end wall-clock the same way — one line before and one after:
   `node -e "console.log(new Date().toISOString())"` (or the shell's `date`). These agent-
   recorded timestamps feed `run-summary.json` at REPORT — run and per-scenario timing is
   required, per-step timing optional when known. Run scenarios one at a time. After each
   scenario, report PASS/FAIL with evidence
   (screenshot + observed vs. expected). A failed scenario follows the **Flake doctrine**
   below: retry only an infrastructure failure, only once, and a scenario that passed only on
   that retry is reported as FLAKY — never as a pass.
   → Checkpoint: pause after each scenario before moving to the next.
4. **REPORT** — Save screenshots/logs under `browser-sessions/<session>/` in the run folder,
   then write `report.md` + `bugs/` there, and close your session (`-s=<session> close` —
   never `close-all`/`kill-all`).
   Record the run-end timestamp, then write `executions/execu_<ts>/run-summary.json`
   YOURSELF — the same persistent, machine-readable run record a parallel run's MERGE
   produces (mode parity), shape per the extent-report skill's
   `references/run-summary-schema.md`: run start/end/duration + mode/environment/target/login
   mode, per-scenario durations from the timestamps you recorded, evidence paths relative to
   the run folder. It is a MANDATORY retained artifact — no step of the run deletes it. Link
   it from `report.md`: `**Run summary (JSON):** [run-summary.json](./run-summary.json)`.
   Summarize results as a defect list (format below). Optionally generate an interactive
   `extent-report.html` next to `report.md` **from that `run-summary.json`** via the
   **extent-report** skill.

### Parallel mode — autonomous
Run end to end WITHOUT stopping for per-checkpoint approval; present the final report when done.

1. **SETUP** — Run `init_run.js --sessions <one label per test file>` to create
   `executions/execu_<timestamp>/` with `browser-sessions/` and `bugs/` subfolders (see
   Execution output layout above); the JSON's `sessions` keys are the unique session names
   to inject as each subagent's `SESSION`. Each carries the `label` it came from — use that,
   not the ASCII session name, when the report names the spec (a spec titled in a non-Latin
   script has no ASCII to keep, so its session name is `spec<n>-<digest>`).
   Record the run-start ISO timestamp (`node -e "console.log(new Date().toISOString())"` or
   the shell's `date`), and keep two JSON outputs for MERGE: the `preflight.js` line (it
   becomes `run.tools` in `run-summary.json`) and `init_run.js`'s `sessions` (it becomes
   `run.sessions`).
2. **LOAD** — Read the planned test files (one bucket per file). By convention these live in a
   `test/` directory, but use wherever the user keeps their specs. Stateful scenarios stay grouped
   and run sequentially within their own file.
   - **First run:** if no `test/` specs exist yet, copy the bundled samples from
     `${CLAUDE_PLUGIN_ROOT}/test/suite1/` into `./test/suite1/` as an editable starting point,
     and tell the user to adapt them to their app before a real regression.
3. **DISPATCH** — Spawn one **`qa-executor`** subagent per test file, injecting its `SESSION`,
   `SESSION_DIR` (`…/browser-sessions/<session>`), `WORKING_DIR`, `TARGET_URL`, `ENVIRONMENT`,
   `TEST_DATA`, `LOGIN_MODE`, and `TEST_SPEC`. `ENVIRONMENT` is the resolved environment name
   (empty for legacy projects); `TEST_DATA` is the environment's `defaults` + `users` JSON
   (secrets left as `{ envSecret }` refs — the executor resolves them only at use time and
   never prints them); `LOGIN_MODE` is the resolved login mode (see Target & environment
   resolution above) — inject it even when it resolved to the default, so no executor has to
   guess. Each uses its own `-s=<session>`. Launch them in a single batch so they run
   concurrently. Expect ~6–8 browser sessions to run at once; the rest queue automatically.
4. **MERGE** — Collect each subagent's report. **Resolve deferred ui-check questions first:**
   executors cannot ask the user mid-run, so a `ui-check:` step needing a confirmation
   (exact-mode suspected rendering noise) or a stop-and-ask (an unintelligible variant set)
   comes back as a **NEEDS-USER** item. Surface every NEEDS-USER item to the user now — the
   precise question plus both image paths (baseline + actual) — collect the answers, and
   finalize those verdicts per the ui-check skill's rules. NEEDS-USER is never degraded to
   BLOCKED and never appears in a final report. **Then carry every FLAKY scenario through:**
   each executor may report scenarios that only passed on their one retry — collect them into
   the report's **Unstable results** section with the attempt-1 symptom and both attempts'
   evidence, keep them out of the pass/fail tally and out of `bugs/bug-list.md`, and never
   re-dispatch the executor to obtain a cleaner report (see Flake doctrine). Only then write
   the final `report.md` and
   build `bugs/` (`bug-list.md` + copy the bug-evidence screenshots each subagent flagged,
   including any ui-check FAILs finalized here) inside the execution folder. Use the defect
   format below. Record the run-end timestamp and compose
   `executions/execu_<ts>/run-summary.json` from the executor reports — the persistent,
   machine-readable run record (shape per the extent-report skill's
   `references/run-summary-schema.md`): run start/end/duration + mode/environment/target/
   login mode, `run.tools` from SETUP's preflight JSON, `run.sessions` from `init_run.js`,
   per-scenario timings and evidence paths from each executor's report, ui-check detail,
   flaky attempt records, deferrals resolved above (as resolved history), and the defects.
   It is a MANDATORY retained artifact in every run — the same file a sequential run's
   orchestrator writes at REPORT (mode parity) — and no step deletes it. Link it from
   `report.md`: `**Run summary (JSON):** [run-summary.json](./run-summary.json)`. Optionally
   generate an interactive `extent-report.html` next to `report.md` **from that
   `run-summary.json`** via the **extent-report** skill.
5. **PRESENT** — Show the merged summary.

Autonomy boundary (applies in parallel mode): still never modify app source, never CREATE an
account, never complete a payment or any other irreversible transaction, never print secrets,
never use real personal data (use disposable values like `qa.tester@example.com`). Logging in
with a test user from the active environment is not on that list — it is the job. If the overall scope is ambiguous, ask once before
dispatching; otherwise proceed without pausing. MERGE-time resolution of deferred ui-check
NEEDS-USER questions is the one sanctioned mid-flow user interaction — it happens after all
executors finish and before the final report is written.

## Flake doctrine
A run that hides instability is worse than a run that reports it. A silent retry turns an
intermittent defect into a green tick, and a defect report built on a network blip sends the
tester hunting a bug that was never there. So instability is **reported, never resolved**.

- **One attempt per scenario.** A scenario that passed is never re-run for reassurance.
- **Only an infrastructure failure earns a retry** — one retry, that scenario only, from a
  clean state. Infrastructure means the app never got to answer: the session or browser died,
  navigation never completed, `net::ERR_*`, the CLI errored instead of returning a page, a
  timeout with no page rendered. `references/playwright-cli.md` carries the symptom list.
- **A wrong answer is never retried.** Missing element, wrong text, wrong status, wrong DB row,
  a 4xx/5xx from the app under test, a console error — that is a defect, and a retry buries it.
- **Verdicts:** infra-fail then pass = **FLAKY** (never a pass); the same app failure twice =
  **FAIL**, reported as reproduced on 2 of 2 attempts; the same infra symptom twice =
  **BLOCKED**, symptom verbatim.
- **FLAKY is a finding, not a footnote.** It stays out of the pass/fail tally, is named in the
  tally line, and gets its own **Unstable results** section in `report.md` — the attempt-1
  symptom verbatim, both attempts' evidence, and what would settle it (re-run that spec; if it
  flakes again, the environment or the app is genuinely unstable). It does NOT go into
  `bugs/bug-list.md`: nothing is proven yet, and a bug list padded with maybes is a bug list
  nobody trusts.
- **Never re-dispatch an executor to get a clean run.** Re-running a whole spec because its
  report contained a FLAKY is the same silent retry, one level up.
- In `extent-report.html`, FLAKY is the first-class `flaky` status with its own color and stat
  card — never folded into `passed` or `blocked`.

## Defect reporting format
- **Title** — concise, action-oriented
- **Steps to reproduce** — numbered, deterministic
- **Expected** vs **Actual**
- **Severity** — Critical / High / Medium / Low
- **Evidence** — screenshot filename, console/network notes

## Rules
- Think out loud: state your reasoning before each action so the user can follow the chain.
- Browser sessions are per-execution property: use ONLY the uniquely-named sessions this run
  created (the `default` session is prohibited — never run a `playwright-cli` command without
  `-s=<session>`), and never close or kill a session this run did not create. `close-all` /
  `kill-all` never run as part of any execution; the only exception is a global cleanup the
  user explicitly requests, after confirming no other execution is running.
- In **sequential mode**, never proceed past a checkpoint without an explicit "go" / "approved".
  In **parallel mode**, do not pause for checkpoints — run autonomously within the autonomy
  boundary above.
- `config/project.json`, `environments/<env>.json`, and `.env` may be read to resolve config;
  never print, log, or pass secret values (tokens, credentials, envSecret targets) anywhere.
  `run-summary.json` and `extent-report.html` carry user **handles** only (e.g.
  `expired_user`) — never credential values, and never `envSecret` target names, anywhere in
  either artifact (not in `run`, notes, or deferred questions); the login mode is recorded as
  the mode word only.
- Never retry a scenario to make a failure go away, and never report a scenario that only
  passed on a retry as a pass — see **Flake doctrine**.
- Never modify application source code. You may write test notes/artifacts only.
- If a step is ambiguous, ask — do not guess.
