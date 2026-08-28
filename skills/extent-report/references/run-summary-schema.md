# run-summary.json — schemaVersion 2 (internal contract)

The machine-readable record of a completed test run. It persists at the run folder root next
to `extent-report.html` (`executions/execu_<ts>/run-summary.json`) and is the input
`make_html_report.js` renders the HTML dashboard from. **Internal contract, not a public
API** — consumers are not invited to build on it; additive evolution only (see Versioning).

## Versioning policy

- The legacy shape (`{title, date, summary, testCases}`, no `schemaVersion` key) is
  implicitly **version 1**. The renderer treats *absence* of `schemaVersion` as the legacy
  path and renders it exactly as before this schema existed.
- This document describes **`schemaVersion: 2`** (integer).
- **Additive optional fields never bump the version.** A breaking change (rename, removal,
  semantic change) bumps it.
- The renderer treats any `schemaVersion >= 2` as the enriched path and renders known fields
  best-effort — it never fails on a higher version, on unknown extra fields, or on absent
  optional fields.

## "Required" semantics

Required fields are a contract on the **capture side**: the browser-testing orchestrator's
instructions demand them, and behavioral evals enforce them. The **renderer never fails on
absence** — a missing field means its section/chip/column is omitted and the rest of the
report renders untouched. Only `title`, `date`, `summary`, `testCases` are renderer-required
(same as the legacy shape).

## Field table

Presence column: **required** = required-by-capture (the orchestrator must write it);
*optional* = written when the run produced it.

### Top level

| Field | Type | Presence | Notes |
|---|---|---|---|
| `schemaVersion` | integer | required | `2`. Absent = legacy shape (version 1). |
| `title` | string | required | Descriptive run name, e.g. `"Suite1 Regression — 2026-08-28"`. |
| `date` | string | required | Run date. |
| `run` | object | required | Execution context + run timing (below). |
| `summary` | object | required | Status counts (below). |
| `testCases` | array | required | One object per test case (below). |
| `defects` | array | optional | Run-level defect list, mirrors `bugs/bug-list.md` (below). |

### `run`

| Field | Type | Presence | Notes |
|---|---|---|---|
| `startedAt` | string | required | ISO-8601, agent-recorded — a real wall-clock fact in both modes. |
| `endedAt` | string | required | ISO-8601, agent-recorded — a real wall-clock fact in both modes. |
| `durationMs` | integer | required | **Execution time** (active execution incl. setup); human-wait excluded — see Duration semantics. |
| `mode` | string | required | `"sequential"` \| `"parallel"`. |
| `environment` | string | optional | Active environment name; `""`/absent for legacy projects. |
| `targetUrl` | string | optional | The tested portal URL. |
| `loginMode` | string | optional | `"session"` \| `"fresh"` — the mode word ONLY (see Secrets). |
| `sessions` | array | optional | Session→spec map, kept from `init_run.js` output: `{session, spec, label}`. |
| `tools` | object | optional | The `preflight.js` JSON, verbatim (`{ "<tool>": {"ok": bool, "version": "…"} }`). |

**Duration semantics (every `durationMs` field).** Durations are **execution time**, not raw
wall-clock. In sequential (human-in-the-loop) runs, time spent waiting on the user —
checkpoint approvals, questions, NEEDS-USER resolution — is excluded from `run.durationMs`
and from per-scenario `durationMs`. Parallel/autonomous runs have no human wait, so their
durations equal the recorded wall-clock spans — the semantics are identical in both modes.
`startedAt`/`endedAt` stay real wall-clock timestamps (raw wall-clock remains derivable from
them), so in a sequential run `endedAt − startedAt` may exceed `durationMs`; that is
expected, not an inconsistency.

### `summary`

Counts per status: `total`, `passed`, `failed`, `blocked`, `naDescoped`, `notRun` (required),
plus optional `warnings`, `viewMismatch`, `flaky` — omit them for a run without `ui-check:`
steps or flakes.

**The `warnings`-key quirk (kept, owner-approved vocabulary):** the summary *count* key is
`warnings` (plural) while the step/test-case *status* key is `warning` (singular). Unchanged
from the legacy shape.

### `testCases[]`

| Field | Type | Presence | Notes |
|---|---|---|---|
| `name` | string | required | Scenario name. |
| `spec` | string | optional | Spec file path. |
| `status` | string | required | `passed`/`failed`/`blocked`/`na`/`notrun`/`warning`/`viewMismatch`/`flaky` — rollup, worst status among steps. |
| `durationMs` | integer | required* | *For executed scenarios; absent for `notrun`/`na`. Execution time (see Duration semantics). |
| `startedAt`, `endedAt` | string | optional | ISO-8601 per scenario. |
| `session` | string | optional | The session that ran it. |
| `screenshots` | array | optional | Evidence for pass AND fail: `{path, caption}`. Paths RELATIVE to this JSON's folder (the run root), e.g. `browser-sessions/<s>/screenshots/x.png`. |
| `flaky` | object | optional | Only on flaky scenarios: `{attempt1Symptom, attempt1Evidence[], attempt2Evidence[]}` — symptom verbatim, evidence paths relative. |
| `blockedBy` | string | optional | Upstream-block causality on BLOCKED rows: the upstream scenario's name. |
| `deferred` | array | optional | RESOLVED NEEDS-USER records only: `{question, resolution, finalStatus, baselineImage, actualImage}`. Unresolved NEEDS-USER never appears in a final artifact. |
| `steps` | array | required | Step rows (below). |

### `testCases[].steps[]`

| Field | Type | Presence | Notes |
|---|---|---|---|
| `desc` | string | required | Step description. |
| `status` | string | required | Same vocabulary as test-case status. |
| `note` | string | optional | One-line detail. |
| `durationMs` | integer | optional | Per-step duration when known. |
| `evidence` | array | optional | `{path, caption}` — relative paths, embedded at render time. |
| `integration` | object | optional | api/db/kb outcome — **summary only, never payloads**: `{kind: "api"\|"db"\|"kb", entry, verdict, result, durationMs}`. Full request/response payloads stay in the run folder's evidence logs. |
| `uiCheck` | object | optional | `{mode, baseline: {source, id}, verdict, cached, cachedReason, baselineImage, actualImage}` — `cachedReason` is rendered verbatim when `cached: true`. |

### `defects[]`

| Field | Type | Presence | Notes |
|---|---|---|---|
| `id` | integer | optional | Defect number. |
| `title` | string | required | Concise, action-oriented. |
| `severity` | string | required | `Critical` / `High` / `Medium` / `Low`. |
| `scenario` | string | optional | The scenario that found it. |
| `steps` | array | optional | Steps to reproduce. |
| `expected`, `actual` | string | optional | Expected vs actual. |
| `evidence` | array | optional | Screenshot paths, relative to the run root (e.g. `bugs/screenshots/…`). |

## Secrets rule (strictest reading — instruction-level, capture side)

The JSON carries user **handles** only (e.g. `expired_user`) — never credential values, and
**never `envSecret` target names** — not in `run`, not in step notes, not in `deferred`
questions, not anywhere. `loginMode` is the mode word only (`"session"`/`"fresh"`), never a
credential or variable name. The renderer cannot detect a secret, so this rule binds whoever
writes the JSON; release-gate runs additionally sweep artifacts via `scan-secrets.js`.

## Rendering guarantees (degradation matrix)

| Input | Rendering |
|---|---|
| No `schemaVersion` (legacy shape) | The legacy code path — output exactly as today |
| v2, any optional field absent | That section/column/chip omitted; nothing else affected |
| v2, required-by-capture field absent | Chip omitted; report still renders |
| v2, evidence path missing/unreadable | Labeled text placeholder; exit 0 |
| v2, unknown extra fields | Ignored |
| `schemaVersion` > 2 | Best-effort render of known fields; never a failure |

## Complete example (disposable values only)

```jsonc
{
  "schemaVersion": 2,
  "title": "Suite1 Regression — 2026-08-28",
  "date": "2026-08-28",
  "run": {
    "startedAt": "2026-08-28T14:02:11+02:00",
    "endedAt": "2026-08-28T14:14:45+02:00",
    "durationMs": 754000,
    "mode": "parallel",
    "environment": "qc",
    "targetUrl": "https://app.example.com",
    "loginMode": "session",
    "sessions": [
      { "session": "cart-140211-a3f2", "spec": "test/suite1/cart.md", "label": "cart" },
      { "session": "search-140211-b7e1", "spec": "test/suite1/product-search.md", "label": "search" }
    ],
    "tools": { "node": { "ok": true, "version": "v22.1.0" },
               "playwright-cli": { "ok": true, "version": "1.2.3" } }
  },
  "summary": { "total": 6, "passed": 3, "failed": 1, "blocked": 0, "flaky": 1,
               "naDescoped": 0, "notRun": 1, "warnings": 0, "viewMismatch": 0 },
  "testCases": [
    {
      "name": "cart-add-item", "spec": "test/suite1/cart.md", "status": "flaky",
      "durationMs": 42000,
      "startedAt": "2026-08-28T14:02:30+02:00", "endedAt": "2026-08-28T14:03:12+02:00",
      "session": "cart-140211-a3f2",
      "screenshots": [
        { "path": "browser-sessions/cart-140211-a3f2/screenshots/s1-cart.png", "caption": "cart after add" }
      ],
      "flaky": {
        "attempt1Symptom": "net::ERR_CONNECTION_RESET before the page loaded",
        "attempt1Evidence": ["browser-sessions/cart-140211-a3f2/screenshots/s2-attempt1.png"],
        "attempt2Evidence": ["browser-sessions/cart-140211-a3f2/screenshots/s2-attempt2.png"]
      },
      "steps": [
        { "desc": "Add to cart", "status": "passed", "note": "", "durationMs": 3200,
          "evidence": [ { "path": "browser-sessions/cart-140211-a3f2/screenshots/s1-cart.png", "caption": "cart badge shows 1" } ],
          "integration": { "kind": "api", "entry": "orders.get_order", "verdict": "PASS",
                           "result": "status 200, id matched", "durationMs": 1200 },
          "uiCheck": { "mode": "reference", "baseline": { "source": "figma", "id": "12:34" },
                       "verdict": "warning", "cached": true,
                       "cachedReason": "Figma unreachable; cache of 2026-08-20",
                       "baselineImage": "browser-sessions/cart-140211-a3f2/screenshots/s3-ui-check-baseline.png",
                       "actualImage": "browser-sessions/cart-140211-a3f2/screenshots/s3-ui-check-actual.png" }
        }
      ]
    },
    {
      "name": "checkout-blocked", "spec": "test/suite1/cart.md", "status": "blocked",
      "durationMs": 4000, "blockedBy": "cart-add-item",
      "deferred": [
        { "question": "3px sidebar shift — rendering noise?", "resolution": "user confirmed noise",
          "finalStatus": "passed",
          "baselineImage": "browser-sessions/cart-140211-a3f2/screenshots/s4-baseline.png",
          "actualImage": "browser-sessions/cart-140211-a3f2/screenshots/s4-actual.png" }
      ],
      "steps": [ { "desc": "Proceed to checkout", "status": "blocked", "note": "upstream: cart-add-item" } ]
    }
  ],
  "defects": [
    { "id": 1, "title": "Empty search shows no 'no results' text", "severity": "Medium",
      "scenario": "product-search",
      "steps": ["Open the shop", "Search for 'zzzxqq'"],
      "expected": "A 'no results' message", "actual": "Empty grid, no message",
      "evidence": ["bugs/screenshots/search-empty.png"] }
  ]
}
```
