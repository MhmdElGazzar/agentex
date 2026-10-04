---
name: task-estimation
description: |
  Creates QA testing tasks with estimation on Azure DevOps User Stories — reads the sprint, analyzes each story, then creates all [Testing] tasks behind ONE consolidated approval, through bundled REST scripts (no Azure CLI). Use this skill whenever the user wants to:
  - Add QA tasks to sprint stories in Azure DevOps
  - Estimate testing hours for user stories
  - Create [Testing] tasks on ADO work items
  - Plan QA effort for a sprint
  - Break down stories into testing tasks with hours
  Trigger on phrases like: "create tasks for stories", "add QA tasks", "estimate sprint", "create testing tasks", "plan QA for sprint", "add tasks to stories", or any mention of sprint stories + estimation + testing.
---

# QA Task Estimation & Task Creation (Azure DevOps)

Automates QA testing-task creation on Azure DevOps User Stories, estimated by story
complexity. This file is the **workflow** (what tasks, how to estimate, the one approval
gate). The mechanics live in ONE bundled script — never run `az` or compose REST calls for
board operations:

- **`${CLAUDE_PLUGIN_ROOT}/skills/task-estimation/scripts/create-tasks.js`** — sprint/story
  reads, fail-closed dry-run validation, and the task creation itself (tracker layer, ADO
  REST over built-in fetch; dry run by default; one JSON line; exit 0/1/2).
- **`${CLAUDE_PLUGIN_ROOT}/references/tracker/ado-boards.md`** — shared boards knowledge:
  field reference names, the `@CurrentIteration` team-name gotcha, relation directions,
  delete constraints. Read it before interpreting script JSON in a session.

## Configuration (never hardcode)

Resolved from `config/project.json`'s `azure` block (legacy `AZURE_*` keys in `.env` as
fallback). Do not bake an organization, project, team, or email into anything. Anything
missing joins the ONE bundled question round (Phase B) — never a drip of questions.

| Setting | Source |
|---|---|
| Organization / Project | `azure.org` / `azure.project` — the script resolves them itself |
| Team | `azure.team` → `AZURE_TEAM` → ask (needed by `@CurrentIteration`) |
| Default assignee | `azure.assignee` → `AZURE_ASSIGNEE` → ask |
| PAT (auth) | `AZURE_PAT` in `.env` — the script reads it itself and sends it only in the Authorization header. **Never** read, print, or pass it. |

A `--team` or corrected value is for the run only — never rewrite the user's config.

## Task template

Every User Story gets exactly **5 QA tasks** — no more, no less:

| Task Title | Purpose |
|---|---|
| `[Testing] Requirement Review` | Review ACs, scenarios, edge cases |
| `[Testing] Test Creation` | Write test cases |
| `[Testing] Test Execution` | Run test cases |
| `[Testing] Bug Review and Retest` | Verify bug fixes |
| `[Testing] Automation` | Automate test scenarios |

Every task is created with: the `[Testing] ` title prefix, the **parent story's** iteration
and area (the script inherits both fresh from the story — they cannot be omitted or wrong),
the assignee, `Activity=Testing`, and `OriginalEstimate`/`RemainingWork` = the estimated
hours, plus the parent link — inline in one atomic create per task.

## Estimation factors

Score these from the story's description + ACs before estimating:

| Factor | What to count |
|---|---|
| Scenarios / ACs | Given/When/Then scenarios |
| UI Elements | Fields, buttons, dropdowns, toggles |
| Validations | Inline errors, required fields, min/max rules |
| Conditions / Logic | Branching behavior, default states, toggles |
| Error Messages | Inline errors + toasts + API failures |
| API Integrations | External service calls (identity verification, maps, etc.) |
| Translations | EN/AR string pairs |
| Edge Cases | Explicitly listed failure modes |

## Estimation guidelines

### Complexity buckets

| Complexity | Story Points | Indicators |
|---|---|---|
| **Simple** | 2–3 SP | 2–3 scenarios, few fields, Yes/No inputs, minimal validations |
| **Medium** | 5 SP | 3–4 scenarios, 5–7 fields, dropdowns with many options, some validations |
| **Heavy** | 8+ SP | 5+ scenarios, map/API integration, 7+ fields, many edge cases, 20+ translations |

### Hours per task by complexity

| Task | Simple | Medium | Heavy |
|---|---|---|---|
| Requirement Review | 1h | 1h | 2h |
| Test Creation | 1h | 1–2h | 3–4h |
| Test Execution | 1h | 1–2h | 3h |
| Bug Review & Retest | 1h | 1h | 2h |
| Automation | 1h | 1–2h | 3h |
| **Total** | **5h** | **5–8h** | **13–14h** |

The exactly-5-canonical-tasks template and these numbers are the methodology — the user may
adjust either at the gate; the script enforces only what is mechanical (prefix, positive
estimate, inherited paths).

## Workflow — three phases, ONE approval

### Phase A — collect & read (no user interaction, no writes)

1. Read the stories:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/skills/task-estimation/scripts/create-tasks.js stories --current-sprint --full
   ```
   (or `stories --ids 12345,12346 --full` when the ask names specific stories). The JSON
   carries each story's title/state/SP, its iteration/area, the description + AC HTML, and
   any `existingTestingTasks` — note which stories already have `[Testing]` children.
2. Per story, apply the estimation methodology above: factor counts → complexity bucket →
   the 5-task hours. The **analysis stays per-story**; only the approval is consolidated.

### Phase B — ONE bundled input round, only if needed

If anything is genuinely unresolvable — no team/assignee anywhere, or stories that already
have `[Testing]` tasks (skip, or add anyway?) — ask **one** AskUserQuestion carrying every
open question at once, **before** validation. When config + the reads answer everything,
skip Phase B entirely: the happy path has exactly one interaction — the approval.

### Phase C — validate, one screen, one approval, write

1. Build the spec (stories the user chose to skip are simply absent), write it to the **OS
   temp dir**, and dry-run:
   ```bash
   node …/create-tasks.js --spec "$TMP/tasks.json" [--allow-existing]
   ```
   Exit 2 = blocked: surface the reasons (they carry allowedValues / existing-task IDs /
   the stale-cache options with a `--refresh-fields` offer), correct **for the run**, and
   re-run — a failure-path round, not a second gate.
2. Render **the consolidated screen** from the plan JSON — one table per story (ID, title,
   SP, factor counts, bucket, per-task hours, story total), the sprint grand total, the
   assignee, any "adding despite N existing `[Testing]` tasks" notes, **the exact write
   plan** (every task create in order with its route, parent link inline), and the explicit
   statement that **nothing has been written yet**. An adjustment ("story 3 is Heavy")
   edits the spec and re-runs the dry run — the corrected screen still ends in exactly one
   approval.
3. **One approval** ("yes" / "تمام" / "approved") → re-run with `--execute`. Anything
   else → stop, zero writes.
4. **Render the ledger**: every intended task done (ID + URL) or not-done (reason). A
   partial failure is a **failure** — name exactly which tasks now exist on the board; no
   retry, no cleanup — remediation is the user's call.

## Rules

- **One gate**: all reads + validation first, ONE consolidated screen for the whole run
  (analysis per story, approval once), then writes. Never create without that approval.
- Never run `az` (or compose your own REST calls) for board operations — the script owns
  transport and auth.
- Never read `.env*` or put a PAT anywhere — the script reads it itself, header-only.
- Iteration/area are inherited from each parent story by the script — never ask for them
  and never accept spec overrides.
- At most ONE bundled question round before validation; missing config values are asked
  there once and corrections apply to the run only (the config is never rewritten).
- No retries, no cleanup writes — a partial result is reported exactly, from the ledger.

## Example interaction

```
User: estimate the sprint
Bot: [reads stories + analyzes silently, then ONE screen:]
     #12345 Capture Contact Preferences (3 SP) — 3 scenarios · 4 Yes/No inputs → Simple, 5 tasks @ 1h (5h)
     #12346 Address Lookup (8 SP) — 6 scenarios · map API · 9 fields → Heavy, 13h (2/3–4/3/2/3)
     #12347 already has 5 [Testing] tasks — you chose: add anyway
     Sprint total: 31h · Assignee: qa.engineer@example.com
     Write plan: 15 task creates (routes below), parent links inline. Nothing has been written yet. Approve?
User: تمام
Bot: [--execute] ✅ 15/15 created — IDs + URLs listed.
```
