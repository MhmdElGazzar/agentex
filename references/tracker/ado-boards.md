# Azure DevOps boards — shared tracker knowledge (REST)

Provider knowledge shared by the **task-estimation** and **test-design** skills. Both flows run
entirely through bundled Node scripts on the tracker layer (`scripts/lib/tracker/` — ADO REST
over built-in fetch); nothing here is an `az` command. Read this when interpreting a script's
JSON, composing a spec file, or explaining a board state to the user. Bug filing's own field
schema lives in `skills/bug-report-azure/references/azure-devops.md`.

## Field reference names

The scripts send and read fields by **reference name**; AC/description values come back as
**HTML** (read the tags to extract design links and translation tables).

| Field | Reference name |
|---|---|
| Title | `System.Title` |
| State | `System.State` |
| Work item type | `System.WorkItemType` |
| Iteration | `System.IterationPath` |
| Area | `System.AreaPath` |
| Assigned to | `System.AssignedTo` |
| Description | `System.Description` |
| Acceptance Criteria | `Microsoft.VSTS.Common.AcceptanceCriteria` |
| Story Points | `Microsoft.VSTS.Scheduling.StoryPoints` |
| Activity | `Microsoft.VSTS.Common.Activity` (tasks; the estimation flow sets `Testing`) |
| Original Estimate | `Microsoft.VSTS.Scheduling.OriginalEstimate` |
| Remaining Work | `Microsoft.VSTS.Scheduling.RemainingWork` |
| Test Case steps | `Microsoft.VSTS.TCM.Steps` (XML — built by `create-cases.js`, never by hand) |

Valid picklist values are project-specific: the scripts validate against the field cache
(`.agentex/cache/tracker-fields-ado.json`) and return the real `allowedValues` on a mismatch.
Ask the user and re-run with the corrected value — corrections are for the run only; the
consumer's config is never rewritten.

## WIQL and the current sprint

WIQL queries go through the adapter's project-scoped `wiql` route; the scripts own the
escaping (single quotes double: `'` → `''`).

The current sprint resolves **dynamically, never hardcoded** —
`create-tasks.js stories --current-sprint` composes via its ADO strategy:

```sql
... WHERE [System.WorkItemType]='User Story'
      AND [System.IterationPath] = @CurrentIteration('[<Project>]\<Team>')
```

> ⚠️ `@CurrentIteration('[<Project>]\<Team>')` needs the **team** name, not just the project —
> e.g. `[My Project]\My Project Team`. No team in `--team` / `azure.team` / `AZURE_TEAM` →
> the script exits 2 naming exactly those keys; ask the user rather than guessing.

Iteration path format is `<Project>\<Sprint Name>`. Child tasks and test cases inherit the
**parent story's** iteration and area — the scripts re-read both fresh from the story on every
run, so a spec cannot get them wrong.

## Relation types and directions

One ADO link always has two views (a `-Forward` and a `-Reverse` side). The scripts pin the
correct side inline on each create, so a reversed or missing link cannot happen; these facts
are for reading board state:

| Relationship | On the story (parent) | On the task / test case |
|---|---|---|
| Parent ⇄ child task | `System.LinkTypes.Hierarchy-Forward` | `System.LinkTypes.Hierarchy-Reverse` |
| Story "Tested By" ⇄ TC "Tests" | `Microsoft.VSTS.Common.TestedBy-Forward` | `Microsoft.VSTS.Common.TestedBy-Reverse` |

- `create-tasks.js` creates each `[Testing]` task with the parent relation
  (`Hierarchy-Reverse → story`) **inside the create** — one atomic write.
- `create-cases.js` creates each Test Case with `TestedBy-Reverse → story` inside the create,
  which renders on the story as **Tested By →** the test case.

## Existing children (before adding tasks)

A story's existing child tasks appear as `Hierarchy-Forward` relations on the story.
`create-tasks.js` scans them and reports `existingTestingTasks` (children titled
`[Testing]…`); the dry run **blocks** on them unless `--allow-existing` is passed after the
user explicitly chooses "add anyway" (choosing "skip" = drop that story from the spec). A
children scan that cannot complete also blocks — fail closed, never create blind.

## Deleting work items

- **Tasks** can be deleted in ADO, but no bundled script deletes anything — deletion is the
  user's action in the portal (Boards → work item → Delete), per the no-cleanup-writes rule.
- **Test Cases cannot be deleted through the work-item APIs** ("You cannot delete or restore
  test work items using this API"); removing one takes elevated Test Management permissions
  most identities don't have. To handle a duplicate/mistaken Test Case, ask the user to delete
  it from the Azure DevOps portal — never retitle, tag, or otherwise write to it as a cleanup.

## Estimation flow (/estimate-story)

The Azure DevOps side of the `task-estimation` skill. The skill body holds the methodology
and the one-gate workflow; these are the ADO mechanics and the ADO-specific rules on top.

**Configuration.** Resolved from the `azure` block of `config/project.json`, with legacy
`AZURE_*` keys in `.env` as the fallback. Never bake an organization, project, team, or
email into anything; a missing value joins the ONE bundled question round.

| Setting | Source |
|---|---|
| Organization / Project | `azure.org` / `azure.project` — the script resolves them itself |
| Team | `azure.team` → `AZURE_TEAM` → ask in the bundled round (needed by `@CurrentIteration`) |
| Default assignee | `azure.assignee` → `AZURE_ASSIGNEE` → ask |
| Auth | `AZURE_PAT` in `.env`. The script reads it itself and sends it only in the Authorization header. **Never** read, print, or pass it. |

A `--team` or corrected value is for the run only — never rewrite the user's config.

**Mechanics (the script owns them):**

- Never run `az` for board operations — `create-tasks.js` talks to ADO REST itself.
- Each `[Testing]` task is an ADO **Task**, created with its parent link
  (`System.LinkTypes.Hierarchy-Reverse` → the story) inline — one atomic create per task.
- The testing-activity marker is the field `Activity=Testing`
  (`Microsoft.VSTS.Common.Activity`).
- The estimated hours go into both `OriginalEstimate` and `RemainingWork`.
- Placement: every task takes the **parent story's** iteration and area — the script
  inherits both fresh from the story, so they cannot be omitted or wrong. Never ask for them
  and never accept spec overrides. The `stories` JSON carries each story's
  `iterationPath`/`areaPath` (the placement facts).
- `--current-sprint` reads the team's `@CurrentIteration` (the WIQL above). No team in
  `--team` / `azure.team` / `AZURE_TEAM` → exit 2 naming exactly those keys; ask the user in
  the bundled round rather than guessing, then pass `--team "<name>"` for the run.
