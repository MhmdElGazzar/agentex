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

## WIQL gotchas

Four pitfalls that cost real runs, and how `scripts/tracker.js` handles each:

1. **The project clause goes inside the query.** Put `[System.TeamProject] = @project` (or
   the quoted project name) in the WHERE clause. `tracker.js search` injects it when the
   query names no project (and leaves a query that names one alone); hand-written WIQL
   anywhere else must carry it, or it searches every project the token can see.
2. **Results are capped.** The service returns at most 20,000 items per query. Pass
   `--top n` for a smaller page, and read `truncated: true` as "at the cap — more may
   exist; narrow the query", never as "that's all".
3. **Batch the `[Testing]` children by parent.** One `[System.Parent] IN (…)` query plus
   one batch read covers any number of stories (`tracker.js relations --id a,b,c --kind
   child`) — never one read per child.
4. **Never pipe text through a CLI.** Read text-bearing fields (descriptions, acceptance
   criteria, comments) with `--out .agentex/scratch/<name>.json` and Read the file: piping
   can drop non-ASCII characters, and a story in a non-Latin script comes back garbled.

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

## Estimation flow (/estimate-story, /estimate-sprint)

The Azure DevOps side of the `task-estimation` skill. The skill body holds the methodology
and the one-gate workflow; the task set, each task's hour range and the rating factors come
from the project's `config/estimation.json`. These are the ADO mechanics and the
ADO-specific rules on top.

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

**First-run history read** — only while the project has no `config/estimation.json`
(`create-tasks.js estimation --out <file> [--sprints N]`); once the file exists, no run reads
past sprints:

- **Team**: the same resolution as the current sprint (`--team` → `azure.team` →
  `AZURE_TEAM`). None → exit 2 naming those keys, with zero requests; it joins the bundled
  round.
- **Closed sprints**: ONE GET of the team's iterations
  (`{project}/{team}/_apis/work/teamsettings/iterations`), kept where `timeFrame` is `past`,
  newest finish date first, the last N (default 2). Fewer past iterations than N → the ones
  that exist; the screen says how many were read.
- **Stories**: one WIQL for User Stories whose `System.IterationPath` is one of those
  iterations — a story counts in the iteration it sits in now — and their titles through
  `wit/workitemsbatch`.
- **Their tasks**: a WIQL on `[System.Parent] IN (…)` per 200 stories, then
  `wit/workitemsbatch` asking for exactly `System.Id`, `System.Title`, `System.Parent` and
  `Microsoft.VSTS.Scheduling.OriginalEstimate`. Completed and remaining work are never
  requested, and hours are never parsed from any text. Typical cost: five requests.
- Only `[Testing]` children count. A task without an Original Estimate is skipped and
  counted, never replaced.
- **No usable history** → labelled starter defaults, with the reason: `no-closed-sprints`
  (the team has no past iteration), `no-testing-tasks` (those sprints hold no `[Testing]`
  task), or `no-estimates` (none of those `[Testing]` tasks has an Original Estimate).
