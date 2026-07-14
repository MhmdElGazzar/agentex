# Azure DevOps — az CLI recipes & field schema (reference)

Backing detail for the `report-azure-bug-generic` skill. Everything here is **product/team
agnostic** — substitute the `{{PLACEHOLDERS}}` from your `config.json`. Read this only when you
need exact field names or `az` invocations; day-to-day the three scripts wrap all of it.

All commands use the **Azure CLI** only (`az devops` / `az boards`, and `az devops invoke` for the
few routes `az boards` doesn't cover). No direct REST calls.

## Connection & auth

```bash
# one-time defaults so you can omit --org/--project on every call
az devops configure --defaults \
  organization={{ORG_URL}} \
  project="{{PROJECT_NAME}}"

# auth: interactive, or a PAT via env (never printed by the scripts)
az login                      # or:
export AZURE_DEVOPS_EXT_PAT=<pat>       # PAT with Work Items + Test Management scopes
export PYTHONIOENCODING=utf-8           # keep non-ASCII fields from tripping cp1252
```

The scripts resolve `{{ORG_URL}}` / `{{PROJECT_NAME}}` from `config.json`, then the
`AZURE_DEVOPS_ORG_URL` / `AZURE_DEVOPS_DEFAULT_PROJECT` env vars, then `az` configured defaults —
whichever is found first. They never store a PAT.

## Bug field schema (template mirror)

Mirror of the configured template bug `{{TEMPLATE_BUG_ID}}` (a child of a `{{TEAM_NAME}}`
User Story). Adjust field reference names to your process if it differs from the default Agile Bug.

| Field (reference name) | Value | Notes |
|---|---|---|
| `System.WorkItemType` | `Bug` | `az boards work-item create --type Bug` |
| `System.Title` | short defect statement | idempotency-checked before create |
| `System.AreaPath` | `{{AREA_PATH}}` | inherit from parent story if unset |
| `System.IterationPath` | `{{ITERATION_PATH}}` | inherit from parent story if unset |
| `System.AssignedTo` | email | **ask the user** — from `assignees` config or "other" |
| `Microsoft.VSTS.Common.Priority` | `1`–`4` | **ask the user** (recommended from run impact) — never silent |
| `Microsoft.VSTS.Common.Severity` | `1 - Critical`…`4 - Low` | **ask the user** (recommended from run impact) |
| `Microsoft.VSTS.Common.ValueArea` | `Business` | config default |
| `Custom.Environment` | `{{ENVIRONMENT}}` | match the run's env (omit if your process has no such field) |
| `Custom.BugCategory` | `{{BUG_CATEGORY}}` | e.g. `Functional` / `UI/UX` (omit if not in your process) |
| `Microsoft.VSTS.TCM.ReproSteps` | HTML (see below) | the visible body of the bug |

> `Custom.*` fields exist only if your project defines them. `create-bug.mjs` emits them only when
> the spec provides a value; leave them out of the spec for stock processes.

Parent link (the **only** relation the skill may add):
```bash
az boards work-item relation add --id <bugId> --relation-type parent --target-id <storyId>
```
`--relation-type parent` maps to `System.LinkTypes.Hierarchy-Reverse`. Attachments are added
separately (below).

## Reading / validating work items (reads — run freely)

```bash
# validate a parent story exists AND is a User Story
az boards work-item show --id <storyId> \
  --query "{id:id,type:fields.\"System.WorkItemType\",title:fields.\"System.Title\"}" -o json

# idempotency: any existing Bug with this exact title?  (WIQL via az boards query)
az boards query --wiql \
  "SELECT [System.Id] FROM workitems WHERE [System.TeamProject]='{{PROJECT_NAME}}' \
   AND [System.WorkItemType]='Bug' AND [System.Title]='<title>'" -o json
```

## Creating the Bug (write — only past explicit confirmation)

```bash
az boards work-item create --type Bug --title "<title>" \
  --org {{ORG_URL}} --project "{{PROJECT_NAME}}" \
  --fields \
    "System.AreaPath=<area>" \
    "System.IterationPath=<iteration>" \
    "System.AssignedTo=<email>" \
    "Microsoft.VSTS.Common.Priority=<1-4>" \
    "Microsoft.VSTS.Common.Severity=<sev>" \
    "Microsoft.VSTS.Common.ValueArea=Business" \
    "Microsoft.VSTS.TCM.ReproSteps=<html>" \
  -o json
# then: az boards work-item relation add --id <newId> --relation-type parent --target-id <storyId>
```

## ReproSteps HTML shape

```
[hr] <table>  <b>{timestamp}</b> | {one-line summary}                       </table>
[hr] <table>  <b>Steps:</b>                                                 </table>
     <table>  <ol><li>step 1</li> … </ol>
              <u>Expected Result</u>  {text}
              <u>Actual Result</u>    {text}  <img src={attachment-url}>      </table>
[hr] <table>  <b>Test Configuration:</b> | {testConfig}                      </table>
```
`create-bug.mjs` regenerates this exact structure from the spec JSON — you don't hand-write HTML.

## Attachments (via `az devops invoke` — `az boards` has no native verb)

```bash
# 1) upload the file, get back {id, url}
az devops invoke --area wit --resource attachments \
  --route-parameters project="{{PROJECT_NAME}}" \
  --query-parameters fileName=<name.png> \
  --http-method POST --in-file <path/to/name.png> \
  --api-version 7.1 -o json

# 2) attach it to the bug (relation) — PATCH the work item's relations
az devops invoke --area wit --resource workitems \
  --route-parameters id=<bugId> \
  --http-method PATCH --api-version 7.1 \
  --in-file <patch.json>   # [{"op":"add","path":"/relations/-","value":{"rel":"AttachedFile","url":"<attachmentUrl>","attributes":{"comment":"<name>"}}}]
```
The returned attachment `url` is also embedded as `<img src=…>` inside ReproSteps so the evidence
renders in the bug body. `create-bug.mjs` does all of this and prints each command first.

## Test plans / suites / cases (reads via `az devops invoke`)

`az boards` has limited test-plan coverage, so reads go through `az devops invoke --area testplan`:

```bash
# suites in a plan
az devops invoke --area testplan --resource suites \
  --route-parameters project="{{PROJECT_NAME}}" planId=<plan> --api-version 7.1 -o json

# cases in a suite
az devops invoke --area testplan --resource "suite entries" ...   # or resource=TestCase per suite
```
`testplan.mjs` wraps the exact resource/route names; adjust `--api-version` per your org if a route
404s.

## Creating a NEW test case (only on explicit user choice)

```bash
az boards work-item create --type "Test Case" --title "<title>" \
  --org {{ORG_URL}} --project "{{PROJECT_NAME}}" \
  --fields "System.AreaPath={{AREA_PATH}}" -o json
# then add it to the chosen suite (az devops invoke --area testplan --resource "suite entries" ... PATCH),
# and link TestedBy to the bug per the user's instruction.
```

## Failing an existing test case (record a Failed outcome)

A Test Case work item has a **State** (Design/Ready/Closed), not pass/fail — the outcome lives on a
**Test Point** inside a Plan/Suite. `testplan.mjs fail` (via `az devops invoke --area test`) does:

1. find the test point: iterate the plan's suites → `Suites/{suite}/TestPoint?testCaseId={tc}`.
2. `POST test/runs` `{name, plan:{id}, pointIds:[point], automated:false, state:"InProgress"}`.
3. `GET Runs/{run}/results` → resultId; `PATCH`
   `[{id, outcome:"Failed", state:"Completed", comment, associatedBugs:[{id:bug}]}]`.
4. `PATCH test/runs/{run}` `{state:"Completed"}`.
5. Durable link: add `Microsoft.VSTS.Common.TestedBy-Reverse` on the TC → the bug
   (`az boards work-item relation add --relation-type "tested by" ...`).

Each step is a printed `az devops invoke` command; nothing runs without `--execute`.

## Quick raw read

```bash
export AZURE_DEVOPS_EXT_PAT=<pat>; export PYTHONIOENCODING=utf-8
az boards work-item show --id {{TEMPLATE_BUG_ID}} --expand all -o json
```
