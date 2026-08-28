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
node <plugin-root>/skills/browser-testing/scripts/ci_gate.js
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
(below), spawns a fresh headless claude session running the existing `/execute-test`
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
| `blockedReasons` | array | `{ code, detail }` entries from the vocabulary below; `[]` unless the verdict is BLOCKED. The `unstable` reason additionally carries `retryable: false`. Never a secret value; for `needs-user` the detail is the question only, never an answer. |
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
`preflight-secrets` · `preflight-browser` · `preflight-plugin-version` · `needs-user` ·
`interaction-required` · `captcha-or-otp` · `blocked-scenarios` · `view-mismatch` ·
`incomplete` · `timeout` · `no-verdict` · `session-error` · `unstable` · `ci-mode`

### Verdict mapping (fixed order)

1. `counts.failed > 0` → **FAIL / 1**.
2. `warningsFailGate` and `counts.warnings > 0` → **FAIL / 1** (warnings are
   product-side caveats; the gate treats them as defects by default — relax with
   `warningsFailGate: false`).
3. Any environment/indeterminate contribution → **BLOCKED / 2** with named reasons:
   blocked scenarios, ui-check view mismatches, not-run scenarios, and run-level
   conditions (`needs-user`, `interaction-required`, `captcha-or-otp`, `timeout`,
   `session-error`).
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
- **The `unstable` carve-out:** a BLOCKED whose *only* reason is `unstable`
  (`flakyFailsGate` tripped) is **never auto-retried** — re-running to clear instability
  is exactly the silent-retry anti-pattern the Flake doctrine prohibits, one level up.
- **`flakyFailsGate` defaults to `false`:** FLAKY stays a visible finding in `counts`
  (and in the reports) without failing the gate. Enable it to conclude BLOCKED (exit 2 —
  instability is environment-flavored, never a product verdict).
- **Per-attempt timeout** (`timeoutMinutes`, default 60): on expiry the session's process
  tree is killed, the attempt concludes BLOCKED `timeout`, and **the partial report stays
  on disk** under `executions/`. Worst-case wall clock = `(1 + retries) ×
  timeoutMinutes` — set your pipeline-level timeout above that.

## CI preflight

Every attempt starts with `ci_preflight.js` — six gating checks, one JSON line, exit 0
or exit 2 with named reasons (unlike the interactive `preflight.js`, which is
informational):

| Check | Reason code on failure |
|---|---|
| node + playwright-cli usable (judged by output — the known benign exit-crash on Windows/Node 24 never gates) | `preflight-tools` |
| Target reachable (any HTTP response counts — a 500 is the app's problem to fail scenarios on) | `preflight-target` |
| Environment resolves (named file exists / `defaultEnvironment` / legacy `QA_TARGET_URL`; never a silent fallback) | `preflight-environment` |
| Secrets present **by name** — every `{ "envSecret": "NAME" }` referenced by the active environment, `config/project.json`, and `integration/` catalogs resolves; missing NAMES are listed, values never appear | `preflight-secrets` |
| A Playwright browser binary is installed | `preflight-browser` |
| Plugin manifest readable; plugin↔project version drift is *reported*, not gate-closing | `preflight-plugin-version` |

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
   vars by the secret store (a checked-in `.env` is never needed).

**The invocation** (from the AgenTeX project root):

```
node "<plugin-root>/skills/browser-testing/scripts/ci_gate.js" --suite test/suite1/ --env uat
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

Inside the gate, the headless session runs as
`claude --bare -p "/agentex:execute-test ci <scope> [on <env>]" --plugin-dir
<plugin-root> --settings <ci-settings.json> --permission-mode dontAsk --output-format
json`. `--bare` keeps the run deterministic across runners (no host hooks or CLAUDE.md);
the shipped `templates/ci/ci-settings.json` is a deny-by-default allowlist — under
`dontAsk`, anything not allowed is denied, and a denied tool degrades to BLOCKED
`no-verdict` (exit 2), never a wrong PASS/FAIL. A non-bare session that inherits the
runner's own `~/.claude` also works as a documented fallback, at the cost of
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

- `skills/browser-testing/templates/ci/azure-pipelines.yml`
- `skills/browser-testing/templates/ci/github-actions.yml`
- `skills/browser-testing/templates/ci/ci-settings.json`

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
  `defaults` is typed normally.
- **Mode parity:** a CI run produces the same artifacts as an interactive parallel run —
  `report.md`, `extent-report.html` (always generated in CI), screenshots, logs,
  `bugs/` — plus `verdict.json`.

## Security posture

- **Secrets by env-var name only.** Preflight reports missing secret *names*; the
  verdict JSON carries counts, paths, and names only. Nothing in the contract can carry
  a secret value. CI logs are long-lived — this is structural, not best-effort.
- **`test/.auth/` is secret-grade.** A saved login session (`login.mode: "session"`,
  written by `/optimize-login`) is a credential equivalent. Never publish it as a
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
