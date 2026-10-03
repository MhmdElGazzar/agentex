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

# QA Task Estimation & Task Creation (Azure DevOps or Jira)

## Role
You turn a sprint's User Stories into estimated QA `[Testing]` tasks on the configured
tracker (Azure DevOps Tasks or Jira sub-tasks). You never write to the board without the
single consolidated approval described below.

Automates QA testing-task creation on the **configured tracker's** User Stories, estimated
by story complexity. This file is the **workflow** (what tasks, how to estimate, the one
approval gate). The mechanics live in ONE bundled script — never run `az` or `acli`, and
never compose REST calls for board operations:

- **`${CLAUDE_PLUGIN_ROOT}/skills/task-estimation/scripts/create-tasks.js`** — sprint/story
  reads, fail-closed dry-run validation, and the task creation itself (tracker layer, ADO
  or Jira Cloud REST over built-in fetch — the script picks the configured provider itself;
  dry run by default; one JSON line; exit 0/1/2).
- **`${CLAUDE_PLUGIN_ROOT}/references/tracker/ado-boards.md`** — shared ADO boards
  knowledge: field reference names, the `@CurrentIteration` team-name gotcha, relation
  directions, delete constraints.
- **`${CLAUDE_PLUGIN_ROOT}/references/tracker/jira-boards.md`** — the Jira twin: field ids,
  ADF, JQL/sprint gotchas, accountId, timetracking, known limitations.

Read the configured provider's reference before interpreting script JSON in a session.

## Configuration (never hardcode)

Resolved from `config/project.json` — the `azure` block on ADO projects (legacy `AZURE_*`
keys in `.env` as fallback), the `jira` block on Jira projects (no `.env` fallback for
non-secrets). Do not bake an organization, site, project, team, or email into anything.
Anything missing joins the ONE bundled question round (Phase B) — never a drip of questions.

| Setting | Source |
|---|---|
| Organization / Project (ADO) | `azure.org` / `azure.project` — the script resolves them itself |
| Team (ADO) | `azure.team` → `AZURE_TEAM` → ask (needed by `@CurrentIteration`) |
| Site / Project key (Jira) | `jira.site` / `jira.project` — the script resolves them itself |
| Board (Jira, optional) | `jira.board` — steers sprint discovery on multi-sprint projects |
| Sub-task type (Jira, optional) | `jira.subtaskType` — pins the type when the project has several |
| Story Points field (Jira, optional) | `jira.storyPointsField` — pins the site's custom field once confirmed |
| Default assignee | `azure.assignee` → `AZURE_ASSIGNEE` → ask · `jira.assignee` (emails) → ask |
| Auth | ADO: `AZURE_PAT` in `.env`. Jira: `JIRA_EMAIL` + `JIRA_API_TOKEN` in `.env`. The script reads them itself and sends them only in the Authorization header. **Never** read, print, or pass them. |

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

## On Jira

The template is **verbatim** — the same five `[Testing]` titles, the same estimation
methodology, the same one-gate workflow. What differs is mechanical, and the script owns it:

- Each task is a **sub-task of the story** (`fields.parent` inline — one atomic create per
  task, like ADO's inline parent link).
- Hours map to Jira **time tracking** (`timetracking.originalEstimate`/`remainingEstimate`,
  e.g. `"2h"`) only where Jira's API accepts them. Jira writes the field only when it is on
  the screen, so the dry run reports `validation.hours.mode`:
  - `create`: hours ride the create.
  - `edit-after-create`: each create is followed by one `set-hours` update in the plan.
  - `none`: no hours are written, and each description carries `Estimate: <n>h`.

  Always show the mode and its `message` on the consolidated screen; the user approves it
  with the rest. `Activity=Testing` maps to the label `testing`.
- The assignee email resolves to an **accountId** (one user-search read at validation time;
  the resolution is shown on the consolidated screen). Unresolvable/ambiguous → blocks,
  never assigned blind.
- **No iteration/area on Jira** — sub-tasks ride their parent story's sprint; the plan says
  this explicitly.
- **Sub-task type**: exactly one sub-task type in the project → used; several → the choice
  joins the ONE Phase-B bundle (real options listed) and `jira.subtaskType` pins it
  thereafter — confirmed once, never guessed.
- **Current sprint** resolves via `sprint in openSprints()`. When that spans more than one
  open sprint, the script blocks with the real sprint names — ask the user which sprint in
  the ONE bundle round and re-run with `--sprint "<name>"`, or set `jira.board` to steer
  discovery. Never pick silently.
- **No open sprint** blocks before any write with `no-open-sprint` (Kanban board, no
  started sprint, or an empty sprint). Relay the fix and offer `--ids` for named stories;
  never guess a sprint. The fixes are in the reference's "Project prerequisites" section.
- **Story Points** come from a site-specific custom field discovered by display name; when
  none/ambiguous the JSON says so with `storyPoints: null` — estimate from the factor
  counts and name the `jira.storyPointsField` override to the user.

Details (field ids, JQL, timetracking format, known limitations) live in
`${CLAUDE_PLUGIN_ROOT}/references/tracker/jira-boards.md`.

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
- Never run `az` or `acli` (or compose your own REST calls) for board operations — the
  script owns transport and auth on both providers.
- Never read `.env*` or put a PAT / API token anywhere — the script reads credentials
  itself, header-only.
- Iteration/area are inherited from each parent story by the script (ADO) — never ask for
  them and never accept spec overrides. On Jira they don't exist: sub-tasks ride their
  parent's sprint.
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
