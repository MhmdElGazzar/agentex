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
`.env`; `prepare.js` copies them into the throwaway project's `.env` at run time.

## Scripts

| Script | Role | Exit codes |
|---|---|---|
| `prepare.js` | Create the throwaway project dir (system temp, `agentex-gate-<ts>`), copy the documented tracker keys from the plugin repo's untracked `.env` into the throwaway `.env` (values never printed), detect **sentinel vs live** mode from the PAT prefix (`EVAL_SENTINEL_PAT_` → sentinel). Prints one JSON line `{dir, mode}`. | 0 · 2 config |
| `verify-wizard.js` | After the wizard's `/api/done`: every answer landed in its documented home — project answers in `config/project.json`, per-env answers in `environments/<env>.json`, every secret **only** in `.env` (and absent from both JSON surfaces). Schema-driven from `scripts/wizard/schema.json`. | 0 · 1 findings · 2 usage |
| `verify-reports.js` | Reporting lane: `executions/execu_<ts>/report.md` **and** `extent-report.html` exist and reflect the run (every expected scenario name + verdict in both). | 0 · 1 · 2 |
| `gate-ledger.js` | The gate-owned teardown ledger: `open` / `record` / `disposition` / `check` / `finalize`. Strips `url` fields from everything it stores (ADO URLs embed the org). | check: 0 · 3 · 1 (below) |
| `teardown.js` | Settle every created id into a terminal disposition (deletes via the tracker lib — Recycle Bin only), finalize the surviving ledger copy, run the secret scan, only then remove the throwaway folder. | 0 · 3 · 1 · 2 |
| `scan-secrets.js` | Mechanical PAT / never-name scan of gate artifacts: compares env-loaded values in memory (PATs + their base64 auth forms, org URL + org segment, project name) and reports file + line + env **key** only. | 0 · 1 hit · 2 no values |
| `fixtures/` | Sentinel-mode canned reads: `story-ar.json` (generic Arabic User Story, `getWorkItem` shape) and `fields-bug.json` (`listFields` shape). Generic content only. |  |

Run order in a gate run: `prepare` → persona follows `commands/init-test.md` + drives the
wizard → `verify-wizard` → lanes (recording every tracker create in the ledger the moment
it is confirmed) → `verify-reports` → `gate-ledger.js check` → `teardown`.

## Sentinel vs live

Mode is auto-detected from the PAT prefix; nothing else changes in how the gate is driven.

- **Sentinel** (`AZURE_PAT=EVAL_SENTINEL_PAT_...`): no network call is made on the tracker
  lane. Writes stop at `execute:false` request descriptors; reads that the flows need are
  served from `fixtures/`. Ledger entries record `status: "descriptor-only"` with
  disposition `not-attempted` — self-describing: nothing reached the board, so no deletion
  is owed and the terminal-disposition check treats the run as complete without live ids.
  Missing org/project values are filled with generic placeholders so descriptor
  composition works with zero real values.
- **Live**: real ids, real Arabic round-trip, real Recycle Bin deletes, and the scan runs
  against the real secret values. Live mode without org/project in the source `.env` fails
  closed (exit 2).

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
    }
  ]
}
```

No `url` field is ever stored (never-name rule); ids and work-item types only.

**Terminal-disposition rule** — every `kind: "created"` entry must end `deleted` or
`undeletable-standard`, except entries that never put anything on the board
(`descriptor-only`, or `failed` with no id), whose `not-attempted` is terminal:

- exit **0** — all terminal, none undeletable;
- exit **3** — terminal, but `undeletable-standard` present (Test Cases: ADO offers no
  standard delete for test artifacts — **waivable finding**, always surfaced, never
  silent, never destroyed);
- exit **1** — any created id non-terminal → gate **FAIL**. On FAIL the throwaway folder
  is kept as evidence.

## Env keys the gate reads (names only — values never leave `.env`)

`AZURE_PAT` / `AZURE_DEVOPS_EXT_PAT` / `AZURE_DEVOPS_PAT` (mode detection, auth, scan),
`AZURE_URL`, `AZURE_PROJECT` (tracker org/project + scan), and the optional tracker
fallbacks `AZURE_TEAM`, `AZURE_AREA_PATH`, `AZURE_ITERATION_PATH`, `AZURE_BUG_TEMPLATE_ID`,
`AZURE_ASSIGNEE`, `AZURE_VALUE_AREA`, `AZURE_ENVIRONMENT`, `AZURE_BUG_CATEGORY`,
`AZURE_TEST_PLAN_ID`, `AZURE_API_VERSION` (copied into the throwaway `.env` when present).
All are listed in `.env.example`.

## Known interaction: the legacy-signal note

`prepare.js` writes `AZURE_URL` / `AZURE_PROJECT` into the throwaway `.env` **before**
`init.js` scaffolds it, and those key names are legacy signals to the scaffolder
(`ENV_KEY_MAP`). The consequence is one `[skipped]` line — the version stamp is not
written and init suggests `/update-agentex`. This is an expected artifact of the gate's
env pre-copy, **not a plugin defect**; the persona must not report it as one.

## Live outcomes

House pattern (evals README "Live lane"): every live gate run gets a dated row. Sentinel
runs are not recorded here — they are the build-time verification lane.

| date | plugin version | commit | verdict | surviving ledger |
|---|---|---|---|---|
| — | — | — | no live gate run yet — the first live run is this feature's own release gate | — |
