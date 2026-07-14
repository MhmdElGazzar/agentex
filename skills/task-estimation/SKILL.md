---
name: task-estimation
description: |
  Creates QA testing tasks with estimation on Azure DevOps User Stories. Use this skill whenever the user wants to:
  - Add QA tasks to sprint stories in Azure DevOps
  - Estimate testing hours for user stories
  - Create [Testing] tasks on ADO work items
  - Plan QA effort for a sprint
  - Break down stories into testing tasks with hours
  Trigger on phrases like: "create tasks for stories", "add QA tasks", "estimate sprint", "create testing tasks", "plan QA for sprint", "add tasks to stories", or any mention of sprint stories + estimation + testing.
---

# QA Task Estimation & Task Creation (Azure DevOps)

Automates QA testing-task creation on Azure DevOps User Stories, estimated by story complexity.
This file is the **workflow** (what tasks, how to estimate, when to confirm). The `az boards` /
`az devops` command mechanics live in the reference — **read it before the first `az boards`
command in a session**:

- **`${CLAUDE_PLUGIN_ROOT}/skills/azure-integration/references/azure-devops-cli.md`** —
  extension install, `az devops configure`, work-item create/show/query, WIQL
  `@CurrentIteration`, parent linking, delete, and the known gotchas.

Base `az` install/auth is covered by the sibling **azure-integration** skill — read its
`references/azure-cli.md` if `az` itself isn't installed or you aren't logged in.

## Configuration (never hardcode)

Read these once at the start of a session — from the values the user gives you, or from an
existing `az devops configure --defaults`. If any is unknown, **ask the user once** and reuse it
for the whole session. Do not bake an organization, project, team, or email into commands.

| Setting | Source | Example |
|---|---|---|
| Organization URL | `AZURE_URL` / ask | `https://dev.azure.com/<org>` |
| Project | `AZURE_PROJECT` / ask | `My Project` |
| Team | `AZURE_TEAM` / ask | `My Project Team` |
| Default assignee | `AZURE_ASSIGNEE` / ask | `qa.engineer@example.com` |
| PAT (auth) | `AZURE_DEVOPS_EXT_PAT` env in the user's shell — **never** print or pass it | — |

(See `.env.example` for these keys. You may read `.env` to resolve the config values above,
but NEVER print, log, or pass the PAT (or any secret) anywhere — auth flows through the
`AZURE_DEVOPS_EXT_PAT` env var that the user exports in their shell.)

## Task template

Every User Story gets exactly **5 QA tasks** — no more, no less:

| Task Title | Purpose |
|---|---|
| `[Testing] Requirement Review` | Review ACs, scenarios, edge cases |
| `[Testing] Test Creation` | Write test cases |
| `[Testing] Test Execution` | Run test cases |
| `[Testing] Bug Review and Retest` | Verify bug fixes |
| `[Testing] Automation` | Automate test scenarios |

Every task must set, at create time: `--type Task`, `--title "[Testing] <name>"`,
`--iteration <parent story's iteration>`, `--assigned-to <assignee>`,
`Microsoft.VSTS.Common.Activity=Testing`, and `OriginalEstimate`/`RemainingWork` = the estimated
hours — then link it to its parent story. Exact commands are in the reference.

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

> Always **show the estimate and ask the user to confirm or adjust** before creating tasks.

## Workflow

0. **Resolve config** — organization, project, team, assignee (see Configuration). Ask once if
   missing.
1. **Get current iteration** — fetch the current sprint dynamically (never hardcode); see reference.
2. **Fetch sprint stories** — WIQL query for User Stories in the current iteration; show a
   summary table: ID | Title | State | Story Points.
3. **Process one story at a time** — for each:
   1. Fetch details (`work-item show --expand all`).
   2. Analyze description + ACs against the estimation factors.
   3. Show the analysis: factor counts, complexity bucket, proposed hours per task.
   4. **Ask for confirmation** — never create without an explicit "yes" / "تمام" / "approved".
   5. **Check for existing child tasks first** (see reference); if present, ask whether to skip
      or add.
   6. Create the 5 tasks with all mandatory fields, then link each to the parent story.
   7. Move to the next story.

## Rules

- One story at a time — never batch-create across all stories.
- Never create tasks without showing the estimate and getting confirmation.
- Never put a PAT on the command line or read `.env*` — auth is handled via the shell env.
- Always set `--iteration` (inherit the parent story's) and `Activity=Testing` — the two most
  common omissions.
- Ask once for any missing config value, then reuse it for the session.

## Example interaction

```
Bot: Story #12345 — Capture Contact Preferences (3 SP)
     - 3 scenarios · 4 Yes/No questions · Simple complexity
     Proposed: all 5 tasks @ 1h each (Total: 5h). Confirm? [yes / adjust]
User: تمام
Bot: [creates 5 tasks — iteration inherited, Activity: Testing, assigned] ✅ Done. Next: #12346...
```
