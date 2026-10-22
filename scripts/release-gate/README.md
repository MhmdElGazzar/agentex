# Release E2E gate — `scripts/release-gate/`

The maintainer-run harness behind **Precondition 5** of the release checklist: before any
behavior-changing release, prove the plugin end to end **as a consumer would use it** —
fresh throwaway consumer project outside the plugin repo, the full setup wizard, four live
lanes (UI / API / tracker / reporting), and a total, auditable teardown. It is driven by
the untracked `release-gate-runner` dev persona; these scripts are the deterministic
mechanics under it (judgment stays with the persona, checks that could produce a confident
wrong PASS live here, in tested code).

Nothing in this folder is ever invoked by consumer flows. The private tracker project is
**never named** in any artifact of this gate — not in scripts, fixtures, ledgers, logs, or
reports (the never-name rule). Real values live only in the plugin repo's untracked
`.env`; `inject-env.js` copies them into the throwaway project's `.env` at run time —
**after** the wizard, never before `init.js` (the tracker key names are legacy signals to
the scaffolder, and a pre-seeded `.env` would send init down the migration branch instead
of the fresh-consumer path this gate attests).

## Scripts

| Script | Role | Exit codes |
|---|---|---|
| `prepare.js` | Create the throwaway project dir (system temp, `agentex-gate-<ts>`) and detect **sentinel vs live** mode from the PAT prefix (`EVAL_SENTINEL_PAT_` → sentinel), reading the plugin repo's untracked `.env` (values never printed). Writes **nothing** into the dir — to `init.js` it must look like a genuinely fresh consumer folder. Prints one JSON line `{dir, mode}`. | 0 · 2 config |
| `inject-env.js` | **After** the wizard's `/api/done`, **before** the tracker lane: copy the documented tracker keys from the plugin repo's untracked `.env` into the throwaway `.env` — empty scaffolded `KEY=` lines filled in place, missing keys appended, non-empty wizard-written values preserved verbatim (never clobbered). Key names only on stdout; values never printed. Fails closed like prepare (nothing written on failure). Prints one JSON line `{ok, mode, injected, preserved}`. | 0 · 2 config |
| `verify-wizard.js` | After the wizard's `/api/done`: every answer landed in its documented home — project answers in `config/project.json`, per-env answers in `environments/<env>.json`, every secret **only** in `.env` (and absent from both JSON surfaces). Schema-driven from `scripts/wizard/schema.json`. | 0 · 1 findings · 2 usage |
| `verify-reports.js` | Reporting lane: `executions/execu_<ts>/report.md` **and** `extent-report.html` exist and reflect the run — every expected scenario name with its verdict adjacent, in each artifact's own vocabulary (`report.md`: `PASS`/`FAIL`/`BLOCKED`; `extent-report.html`: the generator's `Passed`/`Failed`/`Blocked` pills). Fail-closed: an expected verdict outside that map is a usage error. | 0 · 1 · 2 |
| `gate-ledger.js` | The gate-owned teardown ledger: `open` / `record` / `disposition` / `check` / `finalize`. Strips `url` fields from everything it stores (ADO URLs embed the org). | check: 0 · 3 · 1 (below) |
| `suite-check.js` | Tracker lane, after `/design-test`: the **suite-membership check**. Reads the pooled suite's members (testplan route), adds ≥ 1 pool case that is **not** a member (every pool case already a member → FAIL naming them as residue), ledgers each chosen id **before** the add, adds through the adapter's real `addCaseToSuite`, then re-reads independently — any missing id FAILS, named. `plan` (sentinel) sends nothing: the add descriptor + the planned re-read. Prints the lane's `suite-membership:` line. | 0 · 1 · 2 |
| `teardown.js` | Settle every ledger entry into a terminal disposition — suite entries first (association removal only), then created ids (deletes via the tracker lib — Recycle Bin only) — finalize the surviving ledger copy, run the secret scan, only then remove the throwaway folder. | 0 · 3 · 1 · 2 |
| `scan-secrets.js` | Mechanical PAT / never-name scan of gate artifacts: compares env-loaded values in memory (PATs + their base64 auth forms, org URL + org segment, project name) and reports file + line + env **key** only. | 0 · 1 hit · 2 no values |
| `gate-plan.js` | **Which lanes this release needs** (policy Q16): reads `git diff --name-only <base>..HEAD` (`--base`, default the latest `chore: bump to` commit) and maps each file through a path-glob → lane table kept as data at the top of the script. `setup` and `wizard` always run; a change to the execution core or the shared libraries (`skills/browser-testing/`, `agents/qa-executor.md`, run merging/reporting scripts, `scripts/lib/tracker/`, `scripts/lib/project_config.js`) runs the full gate; docs/evals/tests only → `docsOnly` (gate skipped); a non-doc file the table does not know forces the full gate. Prints one JSON line `{base, head, full, docsOnly, lanes:{<lane>:{run, because}}, unmapped}`. Maintainer-only: never shipped by a host. | 0 · 2 git/usage |
| `fixtures/` | Sentinel-mode canned reads: `story-ar.json` (generic Arabic User Story, `getWorkItem` shape) and `fields-bug.json` (`listFields` shape). Generic content only. |  |

Before a gate run, `node scripts/release-gate/gate-plan.js` decides its scope: run only
the lanes with `run: true`, and name every skipped lane with its reason (no changed file
maps to it) in the gate record. `full: true` means all lanes; `docsOnly: true` means no gate.
When the plan lists `unmapped` files, add them to the table rather than accepting the full
gate silently.

Run order in a gate run: `prepare` → persona follows `commands/init-test.md` + drives the
wizard → `verify-wizard` → `inject-env` → lanes (recording every tracker create in the
ledger the moment it is confirmed; the tracker lane runs `suite-check.js` after
`/design-test`) → `verify-reports` → `gate-ledger.js check` → `teardown`.

## Suite-membership check

The tracker lane reuses pooled Test Cases, so `/design-test`'s create path never proves
that an add to a suite actually lands. `suite-check.js` does, on every gate run:

- **Bound, reused suite.** The plan and suite come from the untracked pool file
  (`.claude/release-gate/testcase-pool.json`, a `suite: { planId, suiteId, planName,
  suiteName }` block bound by the pool's existing `projectBinding` / `bindingRule` — a
  mismatch means the pool is absent: fail closed). No plan or suite is minted per run; the
  one-time bootstrap goes through `testplan.js ensure-plan` / `ensure-suite`, and every
  later run sees `exists: true` with zero writes.
- **A real add.** At least one pool case that is not a member is added, so the add's
  idempotent skip can never mask a broken add.
- **Independent re-read.** Membership is read on the testplan route, not the legacy route
  the add re-reads internally.
- **Ledgered, then removed.** Each chosen id is written to the ledger as
  `kind: "associated"` **before** the add; teardown removes it as an association only
  (`removeCaseFromSuite`), never a work-item delete.
- **Report line.** `suite-membership: PASS — added N, re-read N/N members, removed at
  teardown` (or `FAIL — …` naming the ids).

The runner invokes the check only when `scripts/release-gate/suite-check.js` exists in the
tree under test, so older trees' gates are unaffected.

A `[skipped]` version-stamp line or any legacy-signal note from `init.js` on the gate's
fresh scaffold is a **defect** (gate or plugin), never an expected artifact: nothing may
touch the throwaway dir between `prepare` and `init.js`.

## Sentinel vs live

Mode is auto-detected from the PAT prefix; nothing else changes in how the gate is driven.

- **Sentinel** (`AZURE_PAT=EVAL_SENTINEL_PAT_...`): no network call is made on the tracker
  lane. Writes stop at `execute:false` request descriptors; reads that the flows need are
  served from `fixtures/`. Ledger entries record `status: "descriptor-only"` with
  disposition `not-attempted` — self-describing: nothing reached the board, so no deletion
  is owed and the terminal-disposition check treats the run as complete without live ids.
  Missing org/project values are filled with generic placeholders by `inject-env.js` so
  descriptor composition works with zero real values.
- **Live**: real ids, real Arabic round-trip, real Recycle Bin deletes, and the scan runs
  against the real secret values. Live mode without org/project in the source `.env` fails
  closed (exit 2) — in `prepare.js` (early, before a wizard run is wasted) and again in
  `inject-env.js`.

## Teardown ledger

During the run it lives at `<throwaway>/.agentex/release-gate/ledger.json`; `teardown.js`
finalizes a surviving copy (plus the gate log beside it) to
`.claude/release-gate/runs/<ts>/` under the plugin repo root — resolved at runtime, never
committed — **before** the throwaway folder is deleted.

```json
{
  "run": "<ISO timestamp>",
  "mode": "live | sentinel",
  "entries": [
    {
      "step": "fixture-story",
      "describe": "Create fixture User Story (Arabic)",
      "kind": "created",
      "type": "User Story",
      "id": 12345,
      "status": "done | failed | not-attempted | descriptor-only",
      "disposition": "deleted | undeletable-standard | pending | not-attempted",
      "reason": "<only for failed/not-attempted/undeletable-standard/pending>"
    },
    {
      "step": "suite-add",
      "describe": "add pooled test case 77 to the gate suite (association only)",
      "kind": "associated",
      "type": "suite-entry",
      "id": 77,
      "status": "done | descriptor-only",
      "disposition": "removed | pending | not-attempted",
      "planId": 3,
      "suiteId": 4
    }
  ]
}
```

`kind: "created"` is a work item the gate created (owed a delete); `kind: "associated"` is
a suite entry the gate added to an existing test case (owed an association removal —
terminal only when `removed`, or `descriptor-only` + `not-attempted` in sentinel mode). A
pooled test case can appear as both a reused row and a suite entry; `gate-ledger.js
disposition … --kind <kind>` addresses one of them. `check` reports `associations` and
`associationsRemoved`.

No `url` field is ever stored (never-name rule); ids and work-item types only.

**Terminal-disposition rule** — every `kind: "created"` entry must end `deleted` or
`undeletable-standard`, except entries that never put anything on the board
(`descriptor-only`, or `failed` with no id), whose `not-attempted` is terminal:

- exit **0** — all terminal, none undeletable;
- exit **3** — terminal, but `undeletable-standard` present (Test Cases: ADO offers no
  standard delete for test artifacts — **waivable finding**, always surfaced, never
  silent, never destroyed);
- exit **1** — any created id or suite entry non-terminal → gate **FAIL**. On FAIL the
  throwaway folder is kept as evidence.

## Env keys the gate reads (names only — values never leave `.env`)

`AZURE_PAT` / `AZURE_DEVOPS_EXT_PAT` / `AZURE_DEVOPS_PAT` (mode detection, auth, scan),
`AZURE_URL`, `AZURE_PROJECT` (tracker org/project + scan), and the optional tracker
fallbacks `AZURE_TEAM`, `AZURE_AREA_PATH`, `AZURE_ITERATION_PATH`, `AZURE_BUG_TEMPLATE_ID`,
`AZURE_ASSIGNEE`, `AZURE_VALUE_AREA`, `AZURE_ENVIRONMENT`, `AZURE_BUG_CATEGORY`,
`AZURE_TEST_PLAN_ID`, `AZURE_API_VERSION` (injected into the throwaway `.env` by
`inject-env.js` when present). All are listed in `.env.example`.

## Live outcomes

House pattern (evals README "Live lane"): every live gate run gets a dated row. Sentinel
runs are not recorded here — they are the build-time verification lane.

| date | plugin version | commit | verdict | surviving ledger |
|---|---|---|---|---|
| — | — | — | no live gate run yet — the first live run is this feature's own release gate | — |
