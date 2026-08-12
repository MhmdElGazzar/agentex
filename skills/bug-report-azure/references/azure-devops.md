# Azure DevOps — az CLI recipes & field schema (reference)

Backing detail for the `bug-report-azure` skill: the **bug-specific** `az` recipes (field schema,
ReproSteps HTML, attachments, test-plan outcomes) that the three scripts wrap. Read this when you
need exact field names or `az` invocations; day-to-day the scripts handle all of it. Everything
here is **product/team agnostic** — substitute the `{{PLACEHOLDERS}}` from your `.env`
(`AZURE_*` keys — see the repo-root `.env.example`).

Almost everything here is the **Azure CLI** (`az devops` / `az boards`, and `az devops invoke` for
routes `az boards` doesn't cover). **Two operations are direct HTTPS**, because `az` cannot make
those calls at all — the binary attachment upload and the post-create JSON Patch. Both are marked
inline below, and SKILL.md's "Tooling" section is the authoritative statement of the exception.

## Connection & auth

Install, PAT auth, and `az devops configure --defaults` are **not repeated here** — they live in
the shared Azure reference (same setup the task-estimation / test-design skills use):

- **`${CLAUDE_PLUGIN_ROOT}/skills/azure-integration/references/azure-devops-cli.md`** — install
  the `azure-devops` extension, authenticate with a PAT, and configure org/project defaults.

The scripts resolve org/project/etc. from `config/project.json`'s `azure` block, then the AgenTeX
`.env` (`AZURE_URL`, `AZURE_PROJECT`, `AZURE_TEAM`, … — the `AZURE_DEVOPS_ORG_URL` /
`AZURE_DEVOPS_DEFAULT_PROJECT` spellings resolve too), then `az` configured defaults.

Auth for every `az` call is whatever `az` already uses: it reads the PAT from
`AZURE_DEVOPS_EXT_PAT` itself. **The two direct-HTTPS calls cannot borrow that**, so for those
requests only, `_lib.js` reads a PAT (`AZURE_DEVOPS_EXT_PAT` → `AZURE_DEVOPS_PAT` → `AZURE_PAT`)
to build an `Authorization: Basic` header. It is never logged, printed, or stored. Set
`PYTHONIOENCODING=utf-8` so non-ASCII fields don't trip cp1252 on Windows.

## Bug field schema (the standard layout)

The layout `create-bug.js` builds for every Bug (a child of a `{{TEAM_NAME}}` User Story). The
configured `{{TEMPLATE_BUG_ID}}` is a **reference bug** showing the same layout already on the
board — it is read-only and nothing is copied from it. Adjust the field reference names below to
your process if it differs from the default Agile Bug.

| Field (reference name) | Value | Notes |
|---|---|---|
| `System.WorkItemType` | `Bug` | created via `az devops invoke` JSON Patch, not `az boards work-item create` — see below |
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

> `Custom.*` fields exist only if your project defines them. `create-bug.js` emits them only when
> the spec provides a value; leave them out of the spec for stock processes.

Parent link (the **only** relation the skill may add):
```bash
az boards work-item relation add --id <bugId> --relation-type parent --target-id <storyId>
```
`--relation-type parent` maps to `System.LinkTypes.Hierarchy-Reverse`. Attachments are added
separately (below).

## Picklists & required fields (read — one call, no process permissions needed)

```bash
# every field on the type, with its allowed values and required flag
az devops invoke --area wit --resource workitemtypesfield \
  --route-parameters project="{{PROJECT_NAME}}" type=Bug \
  --query-parameters '$expand=allowedValues' --api-version 7.1 -o json
```
`list-picklist.js` wraps this. Prefer it over resolving `picklistId` and calling
`/_apis/work/processes/lists/{listId}`: that route is organisation-scoped, `-preview`, needs
process-level read permission an ordinary PAT lacks, and returns the raw list rather than the
values actually allowed on this work item type.

`create-bug.js` runs the create with `validateOnly=true` before writing anything — the same
server-side rule engine, but it creates nothing:

```bash
az devops invoke --area wit --resource workitems \
  --route-parameters project="{{PROJECT_NAME}}" type=Bug \
  --http-method POST --media-type application/json-patch+json \
  --query-parameters validateOnly=true --api-version 7.1 --in-file create.json -o json
```

> **Reading text back:** on Windows `az` re-encodes stdout to cp1252 and discards characters that
> don't fit, so Arabic text, em dashes and curly quotes read back as `?`/`U+FFFD` **even when the
> stored value is fine**. Never diagnose a write from `az` output alone — verify over REST or in
> the browser.

## Reading / validating work items (reads — run freely)

```bash
# validate a parent story exists AND is a User Story
az boards work-item show --id <storyId> \
  --query "{id:id,type:fields.\"System.WorkItemType\",title:fields.\"System.Title\"}" -o json

# idempotency: any existing Bug with this exact title?
# The query goes in a FILE, not on the command line: `az boards query --wiql "<query>"` carried
# the user's title as a shell argument, and cmd.exe expands %NAME% inside a quoted argument with
# no escape available — a title containing one searched for something else and the check
# answered "none found" for a title already on the board. Verified live against a real org:
# this route returns {"workItems":[{"id":...}]} and finds an exact-title match correctly.
cat > wiql.json <<'JSON'
{"query":"SELECT [System.Id] FROM workitems WHERE [System.TeamProject]='{{PROJECT_NAME}}' AND [System.WorkItemType]='Bug' AND [System.Title]='<title>'"}
JSON
az devops invoke --area wit --resource wiql \
  --route-parameters project="{{PROJECT_NAME}}" --http-method POST \
  --api-version 7.1 --in-file wiql.json --org {{ORG_URL}} -o json
```

## Creating the Bug (write — only past explicit confirmation)

Order matters: screenshots upload first (so a failure costs nothing), then the Bug, then the
parent link, then the repro.

```bash
# 1) create with the SHORT fields only. ReproSteps (large HTML) is intentionally NOT passed
#    here — a big repro exceeds the Windows cmd.exe 8191-char command-line limit.
#    NOTE: `az boards work-item create` is NOT used. On processes carrying both
#    Custom.Environment and Custom.BugCategory it rejects the payload with a fabricated
#    "Rule Error" that validateOnly=true accepts cleanly — a defect in that subcommand's own
#    request construction. `az devops invoke` sends the identical JSON Patch and works:
cat > create.json <<'JSON'
[{"op":"add","path":"/fields/System.Title","value":"<title>"},
 {"op":"add","path":"/fields/System.AreaPath","value":"<area>"},
 {"op":"add","path":"/fields/System.IterationPath","value":"<iteration>"},
 {"op":"add","path":"/fields/System.AssignedTo","value":"<email>"},
 {"op":"add","path":"/fields/Microsoft.VSTS.Common.Priority","value":"<1-4>"},
 {"op":"add","path":"/fields/Microsoft.VSTS.Common.Severity","value":"<sev>"},
 {"op":"add","path":"/fields/Microsoft.VSTS.Common.ValueArea","value":"Business"}]
JSON
az devops invoke --area wit --resource workitems \
  --route-parameters project="{{PROJECT_NAME}}" type=Bug \
  --http-method POST --media-type application/json-patch+json \
  --api-version 7.1 --in-file create.json --org {{ORG_URL}} -o json

# 2) parent link
az boards work-item relation add --id <newId> --relation-type parent --target-id <storyId>

# 3) set ReproSteps + attach screenshots in ONE JSON Patch — DIRECT HTTPS, not `az`.
#    Neither az route can carry this: `az devops invoke ... PATCH --route-parameters id=<id>`
#    resolves "workitems" to the CREATE location no matter what route-parameters you pass
#    (its lookup matches on area+resource only) and fails with KeyError: 'type'; and
#    `az boards work-item update --fields "...<html>..."` puts the whole body on the command
#    line, past cmd.exe's 8191-char cap. `_lib.js patchWorkItem` sends it from memory:
curl -sS -X PATCH -u :"$AZURE_DEVOPS_EXT_PAT" \
  -H 'Content-Type: application/json-patch+json' \
  --data @repro.json \
  "{{ORG_URL}}/{{PROJECT_NAME}}/_apis/wit/workitems/<newId>?api-version=7.1"
#    repro.json:
#    [{"op":"add","path":"/fields/Microsoft.VSTS.TCM.ReproSteps","value":"<html>"},
#     {"op":"add","path":"/relations/-","value":{"rel":"AttachedFile","url":"<attUrl>","attributes":{"comment":"<name>"}}}]
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
`create-bug.js` regenerates this exact structure from the spec JSON — you don't hand-write HTML.

## Attachments (direct HTTPS — `az` cannot do either half)

> **Do not try `az devops invoke --in-file <image>` here.** It text-decodes the file (utf-8 →
> ascii → utf-16) before sending, so a PNG dies with `Unable to decode file ... encoding` before
> any network call. There is no `az boards` attachment verb either. This is the documented
> [Attachments - Create](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/attachments)
> binary REST request; `_lib.js uploadAttachmentBinary` is the implementation.

```bash
# 1) upload the file, get back {id, url}. Body is raw bytes → octet-stream, not JSON.
curl -sS -X POST -u :"$AZURE_DEVOPS_EXT_PAT" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @<path/to/name.png> \
  "{{ORG_URL}}/{{PROJECT_NAME}}/_apis/wit/attachments?fileName=<name.png>&api-version=7.1"

# 2) attach it to the bug — same PATCH as step 3 of "Creating the Bug" above. Send the
#    ReproSteps field and every AttachedFile relation in ONE patch, not one call per file;
#    `attributes.comment` is what shows the filename on the Attachments tab.
```
The returned attachment `url` is also embedded as `<img src=…>` inside ReproSteps so the evidence
renders in the bug body. `create-bug.js` does all of this, uploads **before** creating the Bug so
a failed upload costs nothing, and prints each command/request first.

## Test plans / suites / cases (reads via `az devops invoke`)

`az boards` has limited test-plan coverage, so reads go through `az devops invoke --area testplan`:

```bash
# suites in a plan
az devops invoke --area testplan --resource suites \
  --route-parameters project="{{PROJECT_NAME}}" planId=<plan> --api-version 7.1 -o json

# cases in a suite
az devops invoke --area testplan --resource "suite entries" ...   # or resource=TestCase per suite
```
`testplan.js` wraps the exact resource/route names; adjust `--api-version` per your org if a route
404s.

## Creating a NEW test case (only on explicit user choice)

```bash
# 0. PREFLIGHT (read): list the plan's suites and confirm the chosen suite is in that list.
#    The create happens before the suite-add, and the "suite entries" write route takes only
#    suiteId — it never sees planId — so a wrong plan/suite pair would otherwise be discovered
#    only after a Test Case had already been created and orphaned.
az devops invoke --area testplan --resource suites \
  --route-parameters project="{{PROJECT_NAME}}" planId={{TEST_PLAN_ID}} --org {{ORG_URL}} -o json

# 1. create it. Same `az devops invoke` JSON-Patch route as the Bug — NOT
#    `az boards work-item create --title "<title>"`, which put the title on the command line
#    where cmd.exe expands %NAME% with no escape available. Validated live with
#    validateOnly=true against a real org for type="Test Case".
cat > create-tc.json <<'JSON'
[{"op":"add","path":"/fields/System.Title","value":"<title>"},
 {"op":"add","path":"/fields/System.AreaPath","value":"{{AREA_PATH}}"}]
JSON
az devops invoke --area wit --resource workitems \
  --route-parameters project="{{PROJECT_NAME}}" type="Test Case" \
  --http-method POST --media-type application/json-patch+json \
  --api-version 7.1 --in-file create-tc.json --org {{ORG_URL}} -o json
# then add it to the chosen suite (az devops invoke --area testplan --resource "suite entries" ... PATCH),
# and link TestedBy to the bug per the user's instruction.
# If that suite-add fails, the Test Case EXISTS — testplan.js prints its id (TC_ID=) so it can be
# added by hand or deleted; it is never left as a silent orphan.
```

## Failing an existing test case (record a Failed outcome)

A Test Case work item has a **State** (Design/Ready/Closed), not pass/fail — the outcome lives on a
**Test Point** inside a Plan/Suite. `testplan.js fail` (via `az devops invoke --area test`) does:

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
