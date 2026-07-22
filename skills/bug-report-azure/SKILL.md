---
name: bug-report-azure
description: After a completed test/regression run where one or more defects were found, file them as Azure DevOps Bugs via the Azure CLI (az devops / az boards), following a configurable bug template. Product/team-agnostic — org, project, area path, template, assignees, and test plan are all placeholders resolved from config, never hardcoded. Human-in-the-loop at every board-changing step: template selection, parent User Story, related test case / suite, severity + priority (recommended from the run's findings, with alternatives to choose), and screenshot validation — all rolled into ONE consolidated confirmation before any write. Uses az CLI for every lookup, validation, and write; never touches the board beyond what the user explicitly confirms.
---

# Report Azure Bug (Generic)

Turn defects found during a run into Azure DevOps **Bugs** that mirror a configurable
team template and hang off the right User Story — with a human confirming every
board-changing step. This is the closing gate of a test run.

This skill is **decoupled from any specific team or product**. Everything team-specific is a
placeholder resolved at runtime from config (never hardcoded in the skill):

| Placeholder | Meaning | Resolved from |
|---|---|---|
| `{{ORG_URL}}` | Azure DevOps org URL | config / `AZURE_DEVOPS_ORG_URL` / `az` defaults |
| `{{PROJECT_NAME}}` | Project | config / `AZURE_DEVOPS_DEFAULT_PROJECT` / `az` defaults |
| `{{TEAM_NAME}}` | Team | config |
| `{{AREA_PATH}}` | Area Path | config or inherited from the parent story |
| `{{ITERATION_PATH}}` | Iteration Path | config or inherited from the parent story |
| `{{TEMPLATE_BUG_ID}}` | Reference bug the template mirrors | config (optional) |
| `{{ASSIGNEE_EMAIL}}` / `{{DEVELOPER_NAME}}` | Bug assignee options | config (`assignees` list) — **always asked** |
| `{{TEST_PLAN_ID}}` / `{{TEST_SUITE_ID}}` | Related test plan / suite | **always asked** |
| `{{ENVIRONMENT}}` / `{{BUG_CATEGORY}}` | Custom fields | config defaults or asked |

Copy `config.example.json` to `config.json` (next to this file, or repo root) and fill in your
values. Anything left unset is **asked**, never inferred — see constraint 8.

## Tooling: az CLI only

- **All** lookups, validations, links, and writes go through the **Azure CLI** (`az devops`,
  `az boards`, and `az devops invoke` for the few routes `az boards` doesn't cover, e.g.
  attachment upload and test-run outcomes). **No direct REST/API calls from the scripts, and no
  UI-equivalent actions outside the CLI.**
- Auth is whatever `az` already uses: `az login` + `az devops login` (PAT), or the
  `AZURE_DEVOPS_EXT_PAT` env var. The scripts never read or print a PAT themselves. Set
  `PYTHONIOENCODING=utf-8` so non-ASCII fields don't trip cp1252 on Windows.
- Two dry-run-by-default helpers wrap the CLI so a human sees the plan first:
  - `scripts/create-bug.mjs` — create a Bug + parent link (+ validated attachments).
  - `scripts/testplan.mjs` — `list-suites` / `list-cases` / `find-case` / `create-case` / `fail`.
  - `scripts/check-image.mjs` — structural screenshot validation (Pass 1 of the evidence gate).

  Both write helpers print the **exact `az` commands they will run** and change nothing until
  `--execute` is passed.

## Hard constraints (never violate — these are the point of the skill)

1. **Write nothing on Azure DevOps beyond what the user explicitly confirmed** — the bug itself,
   the confirmed template, the confirmed parent User Story link, the confirmed test-case/suite
   action, and the validated screenshot attachment. Nothing else, ever.
2. **All read / lookup / validation via `az` may run freely.** No **write / create / update /
   link / attach** may happen until (a) every human-in-the-loop question below is answered **and**
   (b) the user has given **one final explicit confirmation** of the complete consolidated summary.
3. **One link type only:** User Story → (parent) → Bug, via `az boards work-item relation add
   --relation-type parent`. No related / duplicate / predecessor-successor / any other link.
4. **Never edit a User Story** except adding that single parent link — no field/state/description
   changes on the story.
5. **Never edit a Test Plan / Suite / Test Case** except the two explicit, user-chosen actions:
   (a) recording a *Failed outcome* on an existing linked test case, or (b) creating a new test
   case when the user explicitly asks. No other modifications.
6. **Log every write `az` command before running it.** The write helpers print the command; show
   it to the user as part of the confirmation. No silent writes.
7. **Idempotency:** before creating a Bug or Test Case, check via `az` whether one with the same
   title already exists. If a potential duplicate is found, surface it and ask the user before
   creating.
8. **Never infer or auto-fill missing required fields** (priority, severity, area path, assignee,
   environment). Ask the user, or use a clearly-marked `{{PLACEHOLDER}}` — never a silent guess.
9. **On any `az` failure, surface the exact error** to the user. Never auto-retry a
   destructive/write action.

## When to run

At the end of any run/task that surfaced one or more issues. Offer it proactively: "N issues were
found — want to file any as Azure Bugs?" If the user declines, stop. Do nothing on the board.

## Workflow (human-in-the-loop)

Steps 1–6 **collect and validate** (reads only). Nothing is written until the single
confirmation in step 7.

### 1. Which issues to report
List the defects from the run (short title + one-line impact each). Ask the user to pick which to
file. **If none selected → stop, create nothing.**

### 2. Bug template selection (ASK — human-in-the-loop)
Detect/propose a **default template** from context (the configured `{{TEMPLATE_BUG_ID}}`, or the
project's standard Bug layout). Show what it entails (fields, ReproSteps shape). Then ask:

> *"Use the default identified template, or would you like to customize / select a different one?"*

Offer: **(a)** use the default, **(b)** customize specific fields, **(c)** select a different
template. **Do not proceed with any template until the user confirms.** If a specific template bug
is named, validate it exists first: `az boards work-item show --id {{TEMPLATE_BUG_ID}}`.

### 3. Parent User Story link (ASK + validate via CLI)
**Ask the user for the parent User Story ID** to link each selected bug to — never infer or
default it. One question can cover all selected issues if they share a parent. **Validate it
exists and is a User Story before proceeding:**
```
az boards work-item show --id <storyId> --query "{id:id,type:fields.\"System.WorkItemType\",title:fields.\"System.Title\",state:fields.\"System.State\"}" -o json
```
If the ID is not found, or the type is not `User Story`, **report that back and ask again** — do
not guess. `create-bug.mjs` re-validates this and refuses a non-story parent. Area Path / Iteration
are inherited from the story unless config overrides them.

### 4. Severity + Priority (RECOMMEND from the run's findings, then ASK)
Both are **human-in-the-loop**. From the defect's observed impact **in this run**, compute a
**recommended** severity and priority, state the one-line reasoning, and present the recommended
option **first** plus the other options for the user to choose from (use `AskUserQuestion`). Never
silently pick.

Recommendation guide (impact seen in the run → recommendation):

| Observed impact in the run | Recommended Severity | Recommended Priority |
|---|---|---|
| Blocks the flow, no workaround (can't advance / pay / issue) | `1 - Critical` | `1` |
| Wrong/missing data in an issued artifact, or broken core path w/ workaround | `2 - High` | `1` or `2` |
| Localized functional error, visible but non-blocking | `3 - Medium` | `2` or `3` |
| Minor cosmetic / edge polish | `4 - Low` | `3` or `4` |

Present it like: *"Payment couldn't complete and there's no workaround → blocks issuance.
**Recommended: Severity `1 - Critical`, Priority `1`.** Other options: Severity `2 - High` /
`3 - Medium`; Priority `2` / `3`."* The **user's choice wins** — record whatever they pick. If the
user gives no steer and declines to choose, use the recommendation but say so explicitly.

### 5. Assignee (ASK — human-in-the-loop)
Ask who the bug should be assigned to. Offer the configured `assignees` options and an "other":
- `{{ASSIGNEE_EMAIL}}` (one per configured developer, e.g. `{{DEVELOPER_NAME}}`)
- Other (the user types an email)

Do not default silently. One question can cover all selected issues if they share an assignee.

### 6. Related test suite / test case (ASK + validate/create via CLI)
**Ask the user which test case failed and is related to this bug**, and the **Test Plan ID** (Suite
ID too if known).

**If a specific test case is provided** — validate it exists via CLI before linking:
```
node scripts/testplan.mjs find-case --plan <plan> --testcase <tc>
```
(under the hood: `az boards work-item show` + a suite/point lookup via `az devops invoke`). If it
doesn't exist, report back and ask again.

**If no specific test case is provided** — ask whether a **new test case should be created**:
- **If yes** → ask **which test suite** (and plan) it should be added to. Only after confirmation,
  create it and add it to that suite (step 7 executes it):
  ```
  node scripts/testplan.mjs create-case --plan <plan> --suite <suite> --title "<title>" [--execute]
  ```
- **If no** → skip the test-case link; the bug is filed on its own.

Either way, take **only** the action the user explicitly picks. Nothing here is written until step 7.

### 7. Screenshots + CONSOLIDATED confirmation + write
A bug should carry evidence. Validate screenshots **before** attaching (two passes):

**Pass 1 — structural (script):**
```
node scripts/check-image.mjs --dir <screenshots-folder>
```
Drops corrupt / `0×0` / `too-small` / `likely-blank` images.

**Pass 2 — content relevance (your vision):** for each surviving image, **Read the image** and
judge it against this bug's *summary / expected / actual*:
- Does it visibly show the described error / UI state / failure? If it's an unrelated
  screen (landing page, generic logged-in frame) or doesn't support the description →
  **flag it to the user and ask for confirmation or a replacement** before including it. **Never
  silently attach an unrelated screenshot.**

Then build one spec JSON per issue (shape below) and **dry-run** it:
```
node scripts/create-bug.mjs --spec <spec>.json
```
The dry run prints the plan, an idempotency (duplicate-title) check, the attachment structural
checks, **and the exact `az` commands** it will run.

Now present **ONE consolidated confirmation** covering everything collected — avoid scattered
confirmations. Include:
- Template choice (from step 2)
- Parent User Story (validated, step 3)
- Severity + Priority (chosen, step 4) with the one-line reasoning
- Assignee (step 5)
- Test case / suite decision (validate-existing / create-new / skip, step 6)
- Screenshot validation result — the final ATTACH / REJECT list with reasons (step 7)
- The exact `az` write commands that will run

**Only after the user's single explicit "yes" to this summary**, execute in order:
```
node scripts/create-bug.mjs --spec <spec>.json --execute                 # bug + parent link + attachments
node scripts/testplan.mjs create-case --plan <plan> --suite <suite> --title "<t>" --execute   # only if chosen
node scripts/testplan.mjs fail --plan <plan> --testcase <tc> --bug <bugId> --execute           # only if chosen
```
Report back each new Bug / Test Case ID + URL. If any command fails, show the **exact** `az`
error and stop — do not auto-retry the write.

## Spec JSON shape (for create-bug.mjs)

```json
{
  "title": "Concise defect statement",
  "severity": "2 - High",
  "priority": 1,
  "parentStoryId": 0,
  "assignedTo": "{{ASSIGNEE_EMAIL}}",
  "summary": "One-line summary shown in the Repro header",
  "steps": ["Step 1", "Step 2", "Step 3"],
  "expected": "What should happen",
  "actual": "What actually happened",
  "environment": "{{ENVIRONMENT}}",
  "bugCategory": "{{BUG_CATEGORY}}",
  "areaPath": "{{AREA_PATH}}",
  "iterationPath": "{{ITERATION_PATH}}",
  "testConfig": "Windows 11 / Chrome",
  "timestamp": "1/1/2026 3:00 PM",
  "attachments": ["executions/.../screenshots/ERROR.png"]
}
```
- `severity` must be one of `1 - Critical` / `2 - High` / `3 - Medium` / `4 - Low`.
- `priority` must be `1`–`4`. **Both come from the user's step-4 choice — the script does not
  invent them and errors if either is missing.**
- `areaPath` / `iterationPath` default to the parent story's when omitted.

## Notes
- The scripts need only Node (built-in modules) + a working, authenticated `az` CLI on PATH.
- Keep spec files out of committed state (write them to a temp/execution folder). They carry no
  secrets but are run scratch.
- `az devops invoke` is used only where `az boards` has no native verb (attachment upload,
  test-run outcomes). It is still the Azure CLI — every such command is printed before it runs.
