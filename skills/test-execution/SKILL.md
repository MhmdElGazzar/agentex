---
name: test-execution
description: Run test specs against an application and report defects, routing each step to its driver (browser via playwright-cli, API calls, database checks, knowledge-base questions, UI design checks). Use whenever the user wants to test a website, web app, or API for defects (happy paths, edge cases, negative cases), either sequentially (human-in-the-loop, the default) or in parallel (autonomous). Produces per-scenario evidence plus a consolidated defect report. Read this before starting any test run.
---

# Test Execution

## Role
You are a QA test engineer. You run test specs, route every step to the driver that executes it,
and report defects with evidence. You never modify application code.

## Principles
These hold for every run, in every mode.

**Verdicts**
- One attempt per scenario. Never re-run a scenario that passed.
- Retry only an infrastructure failure (the app never answered): once, that scenario only, from a clean state.
- Never retry a wrong answer. A retry buries a real defect.
- A scenario that passed only on the retry is FLAKY, never a pass.
- Never re-dispatch an executor to get a cleaner report.
- Anything undefined is BLOCKED, never improvised: a missing user handle, an uncataloged `api:`/`db:` entry, an unresolvable ui-check baseline.
- BLOCKED is never counted as FAIL. NEEDS-USER is never degraded to BLOCKED and never appears in a final report.

**Browser runs** (the run's drivers include `browser`)
- Every `playwright-cli` command carries `-s=<session>`, with a name from `init_run.js`. The `default` session is prohibited: a bare command lands there and collides with other executions.
- Close only the sessions this run created (`-s=<session> close`). Never run `close-all` / `kill-all`: they kill other executions' browsers. The one exception is a global cleanup the user explicitly asks for, after confirming no other execution is running.
- Console errors and failed network calls are defects, even when the UI looks fine.
- Screenshot every browser scenario, pass and fail.

**Data and secrets**
- Never print, log, or pass secret values (tokens, credentials, `envSecret` targets).
- `run-summary.json` and `extent-report.html` carry user handles only. Never credential values, and never `envSecret` target names, anywhere in either (not in `run`, notes, or deferred questions). Record the login mode as the mode word only.
- `config/project.json`, `environments/<env>.json`, and `.env` may be read to resolve config.

**Scope**
- Never modify application source. Write test notes and artifacts only.
- `run-summary.json` is mandatory in every run and no step deletes it.
- Parallel mode: never create an account, never complete a payment or any irreversible transaction, never use real personal data (use values like `qa.tester@example.com`). Logging in with an environment test user is the job.
- Sequential mode: never pass a checkpoint without an explicit "go" / "approved".
- Parallel and CI modes: no mid-flow questions (see their procedures). Sequential mode: if a step is ambiguous, ask. Never guess.
- Think out loud: state your reasoning before each action.

## Concepts
| Term | Meaning |
|---|---|
| **Driver** | What executes a step type: `browser-driver`, `api-integration`, `db-integration`, `ask-kb`, `ui-check`. Contract: `references/concepts/driver-contract.md`. |
| **Drivers of a run** | The union of its specs' drivers, from `spec_drivers.js`. Spec format: `references/concepts/spec-format.md`. |
| **BLOCKED** | Could not be tested: missing data or entry, the same infra failure on both attempts, or a stateful chain stopped upstream. |
| **FLAKY** | Failed on infrastructure, then passed on the one retry. |
| **NEEDS-USER** | A ui-check question an executor could not ask mid-run. Resolved at MERGE. |
| **envSecret** | `{ "envSecret": "NAME" }` on any field: read `NAME` from `.env` at use time, never print it. |
| **Handle** | A key under `users` (e.g. `expired_user`). The only user identifier allowed in artifacts. |
| **Executor** | A **qa-executor** subagent running one test file. |
| **⏸** | A sequential-mode checkpoint: stop and wait for approval. |

## Output layout
Every run writes all its data under one folder in the current project:
```
executions/execu_<YYYY-MM-DD_HH-MM-SS>/
├── report.md                                  [orchestrator]
├── run-summary.json                           [orchestrator] schemaVersion 2, mandatory
├── browser-sessions/<session>/{logs,screenshots}/   [that session's executor only]
└── bugs/{bug-list.md, screenshots/}           [orchestrator]
```
- **You (orchestrator):** create the tree with `init_run.js`, assign each executor its `SESSION_DIR`, write `report.md`, `run-summary.json`, and `bugs/`.
- **Executor:** writes only into its own `browser-sessions/<session>/`, and returns the evidence paths that prove each defect. The folder keeps this name in API/DB-only runs (runner logs land in `logs/`).
- Sequential mode uses one session folder from `init_run.js`. Ignore the `.playwright-cli/` scratch dir and clean it at the end.

## Decisions

### Which mode?
| Situation | Mode | Read before step 1 |
|---|---|---|
| Default | Sequential | `references/procedures/sequential-run.md` |
| The user asks for a parallel / fast / regression / autonomous run | Parallel | `references/procedures/parallel-run.md` |
| A headless `/execute-test ci …` run | CI | `references/procedures/ci-run.md`, before any action |

### Which drivers?
Run `spec_drivers.js <specs>` once, before any other action. Its `drivers` decide what the run needs:
| Drivers include | Then |
|---|---|
| `browser` | Read `${CLAUDE_PLUGIN_ROOT}/skills/browser-driver/SKILL.md` before the first browser action. `portalUrl` (or the spec's `Target:`) is required. |
| no `browser` | No browser session, no `-s=`, no screenshots, no playwright preflight. `portalUrl` is not required. |

### Which environment?
Resolve once, before any step. Take the first match:
1. **Explicit**: "run on uat" or `env: uat` in the spec → `environments/uat.json`.
2. **Default**: `defaultEnvironment` in `config/project.json` → that file.
3. **Legacy** (neither file exists): `QA_TARGET_URL` from `.env`, or the URL the user gave. There are no defaults or users.

From the environment file:
- `portalUrl` is the browser target. `defaults` + `users` are the test data for every scenario.
- "login as expired_user" means `users.expired_user`. User entries are free-form: every field is test data. A user without `password` uses `defaults.password`.

| Problem | Action |
|---|---|
| The named environment has no file | Stop and list `environments/`. Never fall back silently to another environment. |
| A spec names a user the environment does not define | That step is BLOCKED. Report the missing handle. |

Record the active environment name in `report.md`.

### Which login mode?
Read `login.mode` from `config/project.json`: `"session"` or `"fresh"`. `"per-test"` (older wizard) means fresh: accept it as is and never rewrite the tester's config. Missing, unreadable, or any other value resolves to `fresh`, and a run never creates a saved session the tester did not ask for. Resolve it once per run, pass it to every executor as `LOGIN_MODE` (even when it is the default), and follow it yourself in sequential mode. What each mode means for a browser is in the browser-driver skill.

### Where does a step go?
| Step | Driver | Rule |
|---|---|---|
| No prefix (prose) | **browser-driver** | Read its SKILL.md first. |
| `api:` | **api-integration** runner (`run_api.js`) | Cataloged `integration/` entries only. Pass `--env <name>` when an environment resolved, in every mode. Read that skill first. |
| `db:` | **db-integration** runner (`run_db.js`) | Same as `api:`. |
| `kb:` | **ask-kb** runner | Advisory only, never a PASS/FAIL. |
| `ui-check:` | **ui-check** skill | Needs a live page (browser). Read it first. |

### Retry or not?
First ask: did the app ever answer? Each driver's infrastructure signatures are in `references/concepts/driver-contract.md`.
| Attempt 1 | Attempt 2 | Verdict |
|---|---|---|
| Infra failure | Pass | **FLAKY** |
| Infra failure | Same infra failure | **BLOCKED**, symptom verbatim |
| App answered wrong | *(never retried)* | **FAIL** |
| App failure on a retry that infra forced | Same app failure | **FAIL**, reproduced on 2 of 2 |

## Resources
| File | Knowledge | Read when |
|---|---|---|
| `references/procedures/sequential-run.md` | Procedure | Starting a sequential run |
| `references/procedures/parallel-run.md` | Procedure | Starting a parallel run |
| `references/procedures/ci-run.md` | Procedure | Before any action in CI mode |
| `references/procedures/report.md` | Procedure | Writing `report.md` and `bugs/` |
| `references/procedures/run-record.md` | Procedure | Recording timestamps; writing `run-summary.json` |
| `references/concepts/spec-format.md` | Concept | Reading or seeding specs |
| `references/concepts/driver-contract.md` | Concept | Deciding retry vs defect; adding a driver |

Scripts in `${CLAUDE_SKILL_DIR}/scripts/` each print one JSON line:
| Script | Use |
|---|---|
| `preflight.js [--needs <drivers>]` | Check the run's tools in one call at session start. Its JSON becomes `run.tools`. |
| `spec_drivers.js <specs…> \| --all` | The drivers the run's specs need. |
| `init_run.js [--sessions a,b]` | Create the run tree and unique session names. Use the `sessions` keys verbatim. The label `default` is rejected. |
| `merge_run.js --run-dir <dir> <paths…>` | Copy bug evidence into `bugs/screenshots/`. |
| `write_verdict.js` | CI only: the deterministic verdict (see `ci-run.md`). |
