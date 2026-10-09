---
name: task-estimation
description: |
  Creates QA testing tasks with estimation on the configured tracker's User Stories — Azure DevOps or Jira Cloud. Reads the sprint, analyzes each story, then creates all [Testing] tasks (ADO Tasks or Jira sub-tasks) behind ONE consolidated approval, through bundled REST scripts (no Azure CLI, no acli). Use this skill whenever the user wants to:
  - Add QA tasks to sprint stories in Azure DevOps or Jira
  - Estimate testing hours for user stories
  - Create [Testing] tasks on ADO work items or [Testing] sub-tasks on Jira issues
  - Plan QA effort for a sprint
  - Break down stories into testing tasks with hours
  Trigger on phrases like: "create tasks for stories", "add QA tasks", "estimate sprint", "estimate the Jira sprint", "create testing tasks", "create tasks for Jira sprint stories", "add sub-tasks to Jira stories", "plan QA for sprint", "add tasks to stories", or any mention of sprint stories + estimation + testing.
---

# QA Task Estimation & Task Creation

## Role
You turn a sprint's stories into estimated QA `[Testing]` tasks on the configured tracker,
created as the tracker's child tasks of each story. You never write to the board without
the single consolidated approval described below.

Automates QA testing-task creation on the **configured tracker's** stories, estimated by
story complexity. This file is the **workflow** (what tasks, how to estimate, the one
approval gate). The mechanics live in ONE bundled script — never run a tracker CLI or
compose REST calls for board operations; the script owns transport and auth:

- **`${CLAUDE_PLUGIN_ROOT}/skills/task-estimation/scripts/create-tasks.js`** — sprint/story
  reads, fail-closed dry-run validation, and the task creation itself. The script resolves
  the configured tracker itself; dry run by default; one JSON line; exit 0/1/2.
- **The configured provider's reference** — read it before interpreting script JSON in a
  session: `${CLAUDE_PLUGIN_ROOT}/references/tracker/ado-boards.md` (Azure DevOps) or
  `${CLAUDE_PLUGIN_ROOT}/references/tracker/jira-boards.md` (Jira), section *Estimation
  flow*. It holds the provider's configuration keys, what its child tasks, hours, and
  placement look like, and the provider-specific rules that apply on top of this workflow.

## Configuration (never hardcode)

Every setting resolves from `config/project.json`'s tracker block — the reference's
*Estimation flow* section lists the keys and any fallbacks. Never bake an organization,
site, project, team, or email into anything. Anything missing joins the ONE bundled
question round (Phase B) — never a drip of questions.

- **Assignee**: from the spec, or a single configured value — never invented; several
  configured values → ask which one.
- **Credentials** live in `.env`. The script reads them itself and sends them only in the
  Authorization header. **Never** read, print, or pass them.
- Run-only overrides and corrected values are for the run only — they never rewrite the
  user's config.

## Task template

Every story gets exactly **5 QA tasks** — no more, no less:

| Task Title | Purpose |
|---|---|
| `[Testing] Requirement Review` | Review ACs, scenarios, edge cases |
| `[Testing] Test Creation` | Write test cases |
| `[Testing] Test Execution` | Run test cases |
| `[Testing] Bug Review and Retest` | Verify bug fixes |
| `[Testing] Automation` | Automate test scenarios |

Every task is created with: the `[Testing] ` title prefix, the assignee, a testing-activity
marker, and the estimated hours, plus the parent link — inline in one atomic create per
task. Placement (sprint/iteration) is the script's: it comes from the parent story — never
asked, never taken from the spec.

The template, the estimation methodology, and the one-gate workflow are identical on every
tracker; only the mechanics differ, and the script owns them (the reference says what they
are).

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
estimate, inherited placement).

## Workflow — three phases, ONE approval

### Phase A — collect & read (no user interaction, no writes)

1. Read the stories:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/skills/task-estimation/scripts/create-tasks.js stories --current-sprint --full
   ```
   (or `stories --ids <ID,ID> --full` when the ask names specific stories). The JSON
   carries each story's title/state/SP, the provider's placement facts (see the
   reference), the description + AC HTML, and any `existingTestingTasks` — note which
   stories already have `[Testing]` children.
   - If the sprint read reports more than one candidate sprint, that choice joins the one
     bundled round (Phase B) — never pick silently.
   - A sprint read that blocks is relayed with its fix (the message names it); offer
     `--ids` for named stories — never guess a sprint.
2. Per story, apply the estimation methodology above: factor counts → complexity bucket →
   the 5-task hours. When `storyPoints` is null, estimate from the factor counts, and when
   the row carries a note about it, relay that note to the user (it names the config
   override). The **analysis stays per-story**; only the approval is consolidated.

### Phase B — ONE bundled input round, only if needed

If anything is genuinely unresolvable — a required setting the script reports missing (e.g.
the team or assignee), the sprint to use when the read reports several, a blocked entry
that carries `options`, or stories that already have `[Testing]` tasks (skip, or add
anyway?) — ask **one** AskUserQuestion carrying every open question at once, **before**
validation. A choice that comes with `options` is asked with those real options. When
config + the reads answer everything, skip Phase B entirely: the happy path has exactly one
interaction — the approval.

### Phase C — validate, one screen, one approval, write

1. Build the spec (stories the user chose to skip are simply absent), write it to the **OS
   temp dir**, and dry-run:
   ```bash
   node …/create-tasks.js --spec "$TMP/tasks.json" [--allow-existing]
   ```
   Exit 2 = blocked: surface the reasons (they carry allowedValues / existing-task IDs /
   the stale-cache options with a `--refresh-fields` offer), correct **for the run**, and
   re-run — a failure-path round, not a second gate. A blocked entry that carries
   `options` is a user choice: ask it in that round with the real options. An unresolvable
   or ambiguous assignee blocks — ask, never assign blind.
2. Render **the consolidated screen** from the plan JSON — one table per story (ID, title,
   SP, factor counts, bucket, per-task hours, story total), the sprint grand total, the
   assignee (as the dry run resolved it, including any tracker identity it resolved to),
   any "adding despite N existing `[Testing]` tasks" notes, how the hours will be recorded
   and any notes when the dry-run JSON reports them (`validation.hours` with its message,
   `validation.notes`) — the one approval covers them — **the exact write plan** (every
   planned step in order — task creates and any follow-up steps — each with its route,
   parent link inline), and the explicit statement that **nothing has been written yet**.
   An adjustment ("story 3 is Heavy") edits the spec and re-runs the dry run — the
   corrected screen still ends in exactly one approval.
3. **One approval** ("yes" / "تمام" / "approved") → re-run with `--execute`. Anything
   else → stop, zero writes.
4. **Render the ledger**: every intended task done (ID + URL) or not-done (reason). A
   partial failure is a **failure** — name exactly which tasks now exist on the board; no
   retry, no cleanup — remediation is the user's call.

## Rules

- **One gate**: all reads + validation first, ONE consolidated screen for the whole run
  (analysis per story, approval once), then writes. Never create without that approval.
- Never run a tracker CLI (or compose your own REST calls) for board operations — the
  script owns transport and auth on every tracker.
- Never read `.env*` or handle a credential value — the script reads credentials itself,
  header-only.
- Placement (sprint/iteration/area) comes from each parent story through the script —
  never ask for it and never accept spec overrides.
- A blocked entry that carries `options` is a user choice — ask it with the real options
  (in the one bundled round, or the failure-path round after a dry run); never pick
  silently.
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
