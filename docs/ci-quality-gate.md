# CI Quality Gate

Run a full AgenTeX test suite from your CI/CD pipeline — headlessly, with zero user
interaction — and gate the delivery on a dependable machine-readable verdict. The plugin
provides the CI-invokable pieces (one entry-point script, a gating preflight, the verdict
contract, copyable pipeline templates); the pipeline itself — YAML hosting, scheduling,
secrets wiring — stays in your project. The plugin is never a CI runner or scheduler.

## Exit codes — the contract's core

The gate step (`ci_gate.js`) concludes with exactly one of three exit codes:

| Exit | Verdict | Meaning |
|---|---|---|
| `0` | `PASS` | Every scenario met expectations. An EXPECTED FAIL (a negative-case spec whose expected failure behavior appeared) is honored as a pass. |
| `1` | `FAIL` | **Real product defects**: failed scenarios, or warnings while `warningsFailGate` is on (the default). Exit 1 is reachable *only* through product observations. |
| `2` | `BLOCKED` | **Environment/infrastructure problem or otherwise indeterminate**: unreachable target, missing secret, preflight failure, timeout, a session that never concluded, blocked scenarios, a needed human answer. |

**The 1-vs-2 separation is the promise:** under no input does an environment failure
produce exit 1. A broken QA environment, an expired login gate, or a model API outage can
never masquerade as a product failure — and a real defect is never hidden behind an
environment excuse.

## The entry point

Run from the AgenTeX project root (the folder holding `config/project.json`, `test/`,
`executions/`):

```
node <plugin-root>/skills/test-execution/scripts/ci_gate.js
     [--spec <file>]... | --suite <folder> | --all
     [--env <name>]
     [--retries N] [--timeout-minutes N] [--warnings-fail true|false]
     [--flaky-fails-gate true|false]
     [--settings <file>]
```

- **Scope is selectable, never hardcoded** — a single spec file (`--spec`), an explicit
  list (repeat `--spec`), a suite folder (`--suite test/suite3/`), or everything
  (`--all`). Exactly one form is required.
- `<plugin-root>` is the installed plugin's path or a pinned checkout of the plugin
  repo. Never hardcode the `~/.claude/plugins` cache path — it is documented as
  ephemeral across updates. The script resolves its own plugin root internally, so a
  pinned checkout works standalone.
- Everything diagnostic goes to stderr. **stdout carries exactly one JSON line, ever** —
  the verdict below.

What it does per invocation: resolves policy (flags > `ci` config block > defaults), then
loops up to `1 + retries` attempts — each attempt runs a token-free **CI preflight**
(below), spawns a fresh headless claude session running the existing `$agentex:execute-test`
orchestration in CI mode, enforces the per-attempt wall-clock budget (on expiry the
session's process tree is killed and the partial report stays on disk), and locates the
attempt's verdict artifact fail-closed: a session that did not deterministically conclude
can only be exit 2, never 0 or 1.

## Verdict JSON — public contract v1

The gate's single stdout line, also written as `<runDir>/verdict.json` inside the run's
output. External pipelines may rely on this shape across releases.

```json
{
  "schemaVersion": 1,
  "verdict": "PASS | FAIL | BLOCKED",
  "exitCode": 0,
  "counts": { "passed": 9, "failed": 0, "blocked": 0, "warnings": 0,
              "viewMismatch": 0, "flaky": 0, "naDescoped": 0, "notRun": 0 },
  "durationMs": 734211,
  "runDir": "executions/execu_2026-08-28_14-02-11",
  "reportPath": "executions/execu_2026-08-28_14-02-11/report.md",
  "blockedReasons": [ { "code": "needs-user", "detail": "…the precise question…" } ],
  "attempt": 2, "maxAttempts": 4, "retries": 1,
  "attemptHistory": [ { "attempt": 1, "runDir": "…", "verdict": "BLOCKED",
                        "reasonCodes": ["preflight-target"] } ],
  "scope": { "kind": "suite", "value": "test/suite3/" },
  "environment": "uat",
  "pluginVersion": "0.20.1",
  "startedAt": "2026-08-28T14:02:11.000Z", "finishedAt": "2026-08-28T14:14:25.211Z",
  "policy": { "warningsFailGate": true, "retries": 3,
              "timeoutMinutes": 60, "flakyFailsGate": false }
}
```

Field by field:

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | int | Contract version. This page documents v1. |
| `verdict` | string | `PASS` / `FAIL` / `BLOCKED` — mirrors `exitCode`. |
| `exitCode` | int | `0` / `1` / `2` — the process exit code, duplicated for log scrapers. |
| `counts` | object | Per-status scenario counts in the run's established vocabulary (`passed`, `failed`, `blocked`, `warnings`, `viewMismatch`, `flaky`, `naDescoped`, `notRun`) — the same counts the extent report shows. Always all eight keys. |
| `durationMs` | int | Wall-clock duration of the whole gate invocation (all attempts). |
| `runDir` | string | The final attempt's run folder, relative to the project root. |
| `reportPath` | string | The human report (`report.md`) inside `runDir`. May not exist when the run died before REPORT — the partial artifacts in `runDir` are still preserved. |
| `blockedReasons` | array | `{ code, detail }` entries from the vocabulary below; `[]` unless the verdict is BLOCKED. Optional additive fields: `retryable: false` marks a reason the gate never retries (`unstable`, and the two named causes below); `cause` (`not-authenticated` \| `tool-denied` \| `unknown`) says why a session left no verdict; `tools` lists the denied tool names (deduplicated, first-seen order, at most 10) when `cause` is `tool-denied`. Never a secret value; for `needs-user` the detail is the question only, never an answer. The `detail` of a `cause` reason is fixed wording: it never echoes the session's own output or a tool's input. |
| `attempt` | int | The 1-based number of the final attempt. |
| `maxAttempts` | int | `1 + retries` policy. |
| `retries` | int | Retries actually performed (attempts − 1). |
| `attemptHistory` | array | One `{ attempt, runDir, verdict, reasonCodes }` entry per attempt, in order. |
| `scope` | object | `{ kind: "spec"\|"list"\|"suite"\|"all", value }` as invoked. |
| `environment` | string\|null | The environment **name** only (never its contents). |
| `pluginVersion` | string | The plugin that produced the verdict. |
| `startedAt` / `finishedAt` | string | ISO timestamps of the gate invocation. |
| `policy` | object | The resolved gate policy: `warningsFailGate`, `retries`, `timeoutMinutes`, `flakyFailsGate`. |

**Stability rules:** additive changes (new optional fields) may appear without a version
bump — parse tolerantly, never reject unknown fields. Breaking changes (renames,
removals, semantics) bump `schemaVersion` and are called out in the release notes. The
execution-speed program's future Phase 0 run-artifact contract, when it lands, will be
reconciled as a superset or an explicit `schemaVersion` bump — never as silent drift.

### Reason-code vocabulary

`usage` · `preflight-tools` · `preflight-target` · `preflight-environment` ·
`preflight-secrets` · `preflight-browser` · `preflight-plugin-version` · `preflight-driver` · `needs-user` ·
`interaction-required` · `captcha-or-otp` · `secret-unavailable` · `blocked-scenarios` · `view-mismatch` ·
`incomplete` · `timeout` · `no-verdict` · `session-error` · `unstable` · `ci-mode`

When the session ends without a verdict, the gate names the cause on the reason itself,
with no `schemaVersion` bump (the codes above are unchanged, so a pipeline that matches
`no-verdict` keeps working):

| Reason | Means | Retried |
|---|---|---|
| `{ code: "session-error", cause: "not-authenticated", retryable: false }` | The session could not log in (e.g. "Not logged in", "Invalid API key", or API status 401). | No |
| `{ code: "no-verdict", cause: "tool-denied", tools: [...], retryable: false }` | The CI settings denied one or more tools the session tried to use. | No |
| `{ code: "no-verdict", cause: "unknown" }` | Anything else: no output, unparseable output, or an error the gate does not recognise (rate limit, credit, 5xx). The cause is never guessed. | Yes |

### Verdict mapping (fixed order)

1. `counts.failed > 0` → **FAIL / 1**.
2. `warningsFailGate` and `counts.warnings > 0` → **FAIL / 1** (warnings are
   product-side caveats; the gate treats them as defects by default — relax with
   `warningsFailGate: false`).
3. Any environment/indeterminate contribution → **BLOCKED / 2** with named reasons:
   blocked scenarios, ui-check view mismatches, not-run scenarios, and run-level
   conditions (`needs-user`, `interaction-required`, `captcha-or-otp`,
   `secret-unavailable`, `timeout`, `session-error`).
4. `flakyFailsGate` and `counts.flaky > 0` → **BLOCKED / 2**, reason `unstable`,
   marked non-retryable.
5. Otherwise → **PASS / 0**. `naDescoped` never gates; flaky without the policy never
   gates (both stay visible in `counts`).

## Stability rules for runs: retries, flake, timeout

- **BLOCKED outcomes retry automatically, up to 3 times by default** (`retries`).
  Retries apply **only** to BLOCKED — never to exit 0 or 1: a product-defect verdict is
  never re-rolled. Each retry is a **fresh session** with its own run folder, after a
  fixed 30-second pause; the CI preflight re-runs first (token-free — a flapping target
  heals without burning a session). Still BLOCKED after the budget → concludes BLOCKED
  with `retries` and `attemptHistory` visible in the verdict.
- **No retry when every reason is `retryable: false`.** Re-running cannot change these
  attempts, so the gate concludes BLOCKED (exit 2) after the one attempt, with the named
  reason. Three cases carry the flag:
  - **`unstable`** (`flakyFailsGate` tripped): re-running to clear instability is exactly
    the silent-retry anti-pattern the Flake doctrine prohibits, one level up.
  - **`session-error` / `not-authenticated`:** the runner has no Claude auth source.
  - **`no-verdict` / `tool-denied`:** the CI settings deny a tool the run needs; the next
    session would be denied the same tool.

  A `preflight-driver` BLOCKED is never retried either (it is deterministic). A
  `no-verdict` with `cause: "unknown"` is retried as before.
- **How the gate names a missing verdict.** When the session closes, a valid verdict file
  always wins: a PASS or FAIL stays as written (exit 0 or 1, never retried), even if the
  session also reported denied tools, and a BLOCKED verdict keeps its own reasons. Only when no valid verdict exists does the gate read
  the session's own result JSON, in this order:
  1. Result not parseable (or empty) → `no-verdict`, `cause: "unknown"`.
  2. An error with a login signature → `session-error`, `cause: "not-authenticated"`.
  3. Any permission denials → `no-verdict`, `cause: "tool-denied"`, `tools` = the tool
     names only.
  4. Anything else → `no-verdict`, `cause: "unknown"`.

  For a named cause the gate prints one stderr line that names the cause and the fix, and
  says the attempt is not retried. Not authenticated: set `ANTHROPIC_API_KEY` (or your
  auth source) on the gate step. Tool denied: the runner's tool is not allowed by
  `ci-settings.json`. An unknown cause prints the usual retry line.
- **`flakyFailsGate` defaults to `false`:** FLAKY stays a visible finding in `counts`
  (and in the reports) without failing the gate. Enable it to conclude BLOCKED (exit 2 —
  instability is environment-flavored, never a product verdict).
- **Per-attempt timeout** (`timeoutMinutes`, default 60): on expiry the session's process
  tree is killed, the attempt concludes BLOCKED `timeout`, and **the partial report stays
  on disk** under `executions/`. Worst-case wall clock = `(1 + retries) ×
  timeoutMinutes` — set your pipeline-level timeout above that.

## CI preflight

Every attempt starts with `ci_preflight.js` — seven gating checks, one JSON line, exit 0
or exit 2 with named reasons (unlike the interactive `preflight.js`, which is
informational):

| Check | Reason code on failure |
|---|---|
| node + playwright-cli usable (judged by output — the known benign exit-crash on Windows/Node 24 never gates) | `preflight-tools` |
| Target reachable (any HTTP response counts — a 500 is the app's problem to fail scenarios on) | `preflight-target` |
| Environment resolves (named file exists / `defaultEnvironment` / legacy `QA_TARGET_URL`; never a silent fallback) | `preflight-environment` |
| Secrets present **by name** — every `{ "envSecret": "NAME" }` referenced by the active environment, `config/project.json`, and `integration/` catalogs resolves to a non-empty value (an empty or whitespace value counts as missing); missing NAMES are listed, values never appear. `sources` reports where each came from (`process-env` or `dotenv`); a name found only in `.env` gets a stderr note, never a gate | `preflight-secrets` |
| A Playwright browser binary is installed | `preflight-browser` |
| Plugin manifest readable; plugin↔project version drift is *reported*, not gate-closing | `preflight-plugin-version` |
| No spec in scope declares `Drivers: mobile` — mobile specs run via `$agentex:execute-mobile-test`, never in a browser; never retried | `preflight-driver` |

## The `ci` config block

Optional, read-if-present in `config/project.json` — no scaffold change, no migration.
Team-level policy lives here; per-pipeline variation uses the CLI flags
(**flags > config > defaults**):

```json
"ci": { "warningsFailGate": true, "retries": 3,
        "timeoutMinutes": 60, "flakyFailsGate": false }
```

## CI-agnostic recipe

Usable from any CI system, without either shipped template.

**Prerequisites on the runner:**

1. Node 20+.
2. The claude CLI (`npm install -g @anthropic-ai/claude-code`) and a model credential
   provided **by env-var name** from your secret store — `ANTHROPIC_API_KEY` (or your
   Bedrock/Vertex credentials).
3. The AgenTeX plugin — `claude plugin install <agentex@your-marketplace>`, or a pinned
   checkout of the plugin repo (then `<plugin-root>` is that checkout).
4. The browser driver, inside the project:
   `npm install -D @playwright/cli && npx playwright-cli install-browser chromium`.
5. Every `{ "envSecret": "NAME" }` your environment files reference, injected as env
   vars by the secret store (a checked-in `.env` is never needed). A local `.env` works for
   a trial run on your own machine, because the bundled scripts read it; preflight then
   notes on stderr which names came only from `.env`. A CI runner has no `.env`, so in a
   pipeline every name must come from the secret store.

**The invocation** (from the AgenTeX project root):

```
node "<plugin-root>/skills/test-execution/scripts/ci_gate.js" --suite test/suite1/ --env uat
```

**Consume the result:**

- Branch on the exit code: `0` proceed · `1` product defects (report in the artifacts) ·
  `2` environment/indeterminate — fix the environment and re-run; do not treat as a
  product failure.
- Parse the single stdout JSON line (or `executions/execu_*/verdict.json`) for the
  pipeline UI summary.
- Publish `executions/execu_*/` as the pipeline artifact — `report.md`,
  `extent-report.html`, screenshots, `verdict.json`. **Never publish `test/.auth/`**
  (see Security).

### Password-gated logins

Most enterprise logins need a secret password, and some need an OTP or another secret
field later in the flow. The whole path, by name only:

1. **Reference it by name.** In `environments/<env>.json`, write the field as
   `{ "envSecret": "QA_PASSWORD" }`, never the value.
2. **Inject it from the secret store.** Map the secret to that name in the gate step's
   `env:` block (GitHub Actions `env: QA_PASSWORD: ${{ secrets.QA_PASSWORD }}`, Azure
   Pipelines `env: QA_PASSWORD: $(QA_PASSWORD)`). Preflight gates on it being present and
   non-empty (`preflight-secrets`).
3. **The plugin types it.** The headless session never sees the value. It calls
   browser-driver's bundled `fill_secret.js` with the NAME and the field's ref. The
   script reads the value from its own environment and types it into the field through
   a temp file that is deleted right away. It submits in the same call and then clears
   the field, so a snapshot or screenshot taken afterwards does not show it. Four paths
   are closed by the agent's rules, not by code: the page echoing the value back, console
   logs, request bodies, and traces or video. The agent never captures any of them across
   a secret fill. The shipped `ci-settings.json` already allows the call (`Bash(node:*)`).
4. **Never printed.** The value never appears on a command line, in tool output, in
   `executions/`, or in the verdict. Only the NAME can appear. If the variable is
   missing or empty when the field is filled, the scenario is BLOCKED with the run
   reason `secret-unavailable:<NAME>` (exit 2). A real captcha, or an OTP nobody can
   supply, is still `captcha-or-otp`.

Inside the gate, the headless session runs as
`claude --bare -p "/agentex:execute-test ci <scope> [on <env>]" --plugin-dir
<plugin-root> --add-dir <plugin-root> --settings <ci-settings.json> --permission-mode
dontAsk --output-format json`. `--bare` keeps the run deterministic across runners (no
host hooks or CLAUDE.md); `--add-dir <plugin-root>` grants the session **read** access to
the plugin's own files (references, bundled scripts, templates) wherever the plugin is
installed — the settings allowlist reads only the consumer project, and the session must
read e.g. `references/procedures/ci-run.md` to conclude deterministically;
the shipped `templates/ci/ci-settings.json` is a deny-by-default allowlist — under
`dontAsk`, anything not allowed is denied, and a denied tool degrades to BLOCKED
`no-verdict` (exit 2), never a wrong PASS/FAIL. The reason then carries
`cause: "tool-denied"` and `tools` (the denied tool names, e.g. `["PowerShell", "Read"]`),
and the gate does not retry it: add a matching allow rule to your `ci-settings.json` (or
run on a runner whose shell the settings already allow) and re-run. A non-bare session
that inherits the runner's own `~/.claude` also works as a documented fallback, at the cost of
runner-to-runner determinism. Note that claude's own process exit code reflects session
completion, not the run verdict — only `ci_gate.js`'s exit code and the verdict JSON are
the contract.

## Advisory vs blocking

- **Blocking** (default): the gate step's exit code fails the stage automatically.
  Downstream stages depend on it succeeding.
- **Advisory**: the gate step never auto-fails the stage (`continueOnError: true` /
  `continue-on-error: true`); the **PM's manual approval is the gate**. The PM reviews
  the published artifacts (`extent-report.html`, `report.md`, `verdict.json`) and
  approves or rejects before downstream stages proceed.

Both shipped templates show the full stage including the PM approval step —
`ManualValidation` on Azure Pipelines, an environment with required reviewers on GitHub
Actions:

- `skills/test-execution/templates/ci/azure-pipelines.yml`
- `skills/test-execution/templates/ci/github-actions.yml`
- `skills/test-execution/templates/ci/ci-settings.json`

## CI mode semantics (what the run itself does differently)

- **Zero user interaction.** Anything needing a human — a deferred ui-check NEEDS-USER
  question, a confirmation gate — concludes as **BLOCKED with a named reason** (the
  precise question travels in `blockedReasons[].detail`), never a silent pass/fail.
- **No tracker writes of any kind.** Bug filing stays interactive-only; the bundled
  tracker scripts mechanically refuse writes under CI (`AGENTEX_CI=1` → exit 2, reason
  `ci-mode`). Defects are reported in `report.md` / `bugs/bug-list.md` for a human to
  file later.
- **Captcha / unobtainable OTP → BLOCKED** (`captcha-or-otp`), never defeated. A fixed
  test-environment captcha or OTP whose value comes from the spec or environment
  `defaults` is typed normally. A password or OTP declared as `{ "envSecret" }` is not a
  gate either: `fill_secret.js` types it (see Password-gated logins), and a missing or
  empty variable is `secret-unavailable`, never `captcha-or-otp`.
- **Mode parity:** a CI run produces the same artifacts as an interactive parallel run —
  `report.md`, `extent-report.html` (always generated in CI), screenshots, logs,
  `bugs/` — plus `verdict.json`.

## Security posture

- **Secrets by env-var name only.** Preflight reports missing secret *names*; the
  verdict JSON carries counts, paths, and names only. Nothing in the contract can carry
  a secret value. CI logs are long-lived — this is structural, not best-effort.
  Browser fields that need a secret are typed by `fill_secret.js`, which reads the value
  itself and never prints it.
- **`test/.auth/` is secret-grade.** A saved login session (`login.mode: "session"`,
  written by the optimize-login skill) is a credential equivalent. Never publish it as a
  pipeline artifact (the templates publish `executions/` only, and the shipped
  `ci-settings.json` denies reading it). If your CI runs need session login, provision
  the state file through the CI's secure-file mechanism — or set CI runs to fresh login
  (`login.mode: "fresh"`), the simplest safe choice.
- All run outputs land in the consumer project's `executions/` tree.

## Live proof

House live-lane pattern: one recorded end-to-end `ci_gate.js` invocation following the
CI-agnostic recipe verbatim, in a real credentialed session. Recorded as a dated row
below at release time.

| date | invocation | verdict | notes |
|---|---|---|---|
| — | — | — | no live CI-gate run recorded yet (pending the release flow) |

## Future reconciliation

The execution-speed program's Phase 0 run-artifact contract (deferred, separate backlog
item) overlaps this verdict's territory. When it lands, the two reconcile explicitly:
the verdict either adopts the Phase 0 record as a superset (additive, no bump) or bumps
`schemaVersion` with release notes. Pipelines parsing tolerantly per the stability rules
above will not notice the additive case.
