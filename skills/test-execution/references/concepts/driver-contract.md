# Concept: driver contract

A driver executes one step type for the orchestrator. Every driver provides the same five things, so the orchestrator never needs to know how a step runs, only where it goes.

| # | A driver provides | Why the orchestrator needs it |
|---|---|---|
| 1 | The **step form** it owns (a prefix, or unprefixed prose) | Routing (SKILL.md *Where does a step go?*) |
| 2 | **How a step runs**: a bundled runner printing one JSON line (PASS / FAIL / BLOCKED, exit 0/1/2), or a tool the executor drives | Execution stays deterministic and catalog-only |
| 3 | **Evidence** it leaves under `SESSION_DIR` | Defects cite it; `merge_run.js` copies it |
| 4 | **Infrastructure signatures**: the failures where the app never answered | The retry-or-not decision |
| 5 | **Preflight needs**: the tools and target it requires | `spec_drivers.js` → `preflight.js` / `ci_preflight.js --needs` |

## The drivers
| Driver | Step form | Runs via | Evidence | Infrastructure (retry once; twice = BLOCKED) | Preflight needs |
|---|---|---|---|---|---|
| **browser-driver** | unprefixed prose | `npx playwright-cli -s=<session>` | screenshots, console/network logs | The session or browser died, navigation never completed (`net::ERR_*`), the CLI errored instead of returning a page, a timeout with no page rendered. Full list: `browser-driver/references/experience/gotchas.md`. | playwright-cli, a browser binary, `portalUrl` |
| **api-integration** | `api:` | `run_api.js` | the runner's `--log` | The request never got a response: `request failed` (connection refused, DNS, timeout). | `api.baseUrl` answers, when the env defines one |
| **db-integration** | `db:` | `run_db.js` | the runner's `--log` | sqlcmd could not connect or run (a sqlcmd error, not a wrong row). | sqlcmd |
| **ask-kb** | `kb:` | `ask_kb.js` | the runner's `--log` | Advisory only: never a verdict, never retried. | none |
| **ui-check** | `ui-check:` | the ui-check skill + `fetch_baseline.js` | baseline + actual images | An unresolvable baseline is BLOCKED (not retried). | a live browser page |

## What is never infrastructure
The app answered, and the answer was wrong: a missing element, wrong text or count, a 4xx/5xx served by the app under test, a wrong DB row, a JS console error. That is a defect, and it is never retried.

## Adding a driver (e.g. mobile)
Write a driver skill that provides the five items above. Then add its row here and in SKILL.md's routing table, its prefix to `spec_drivers.js`, and its gating check to `ci_preflight.js`. Its runs write the same `executions/` tree and `run-summary.json`, so downstream consumers work unchanged.
