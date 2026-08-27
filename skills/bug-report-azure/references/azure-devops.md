# Azure DevOps — bug field schema & REST routes (reference)

Backing detail for the `bug-report-azure` skill: the Bug field schema, the ReproSteps HTML
shape, and the ADO REST routes the bundled tracker adapter uses. Day-to-day the scripts
handle all of it — read this when you need exact field reference names or want to explain
a route on the consolidated screen. Everything here is **product/team agnostic** —
substitute the `{{PLACEHOLDERS}}` from `config/project.json`'s `azure` block.

**Transport:** every operation goes through the plugin's tracker layer
(`scripts/lib/tracker/` — Node built-in `fetch` against `{{ORG_URL}}/{{PROJECT_NAME}}/_apis/…`).
There is no Azure CLI anywhere in this flow, and the agent never composes REST calls by
hand — the scripts own transport and auth.

## Connection & auth

- Org/project resolve from `azure.org` / `azure.project` (`config/project.json`), legacy
  `AZURE_URL` / `AZURE_PROJECT` in `.env`. `azure.org` accepts a full URL
  (`https://dev.azure.com/<org>`, on-prem collection URLs too) or a bare org name.
- The **PAT** is read by the adapter from `.env` — `AZURE_PAT` first, then legacy
  `AZURE_DEVOPS_EXT_PAT` / `AZURE_DEVOPS_PAT` — and becomes
  `Authorization: Basic base64(":" + PAT)` per request. It is never printed, logged,
  or placed on a command line; dry-run output shows `authorization: <Basic ***, not printed>`.
- `api-version` comes from `azure.apiVersion` (default `7.1`).
- No shell export and no `az` install are needed for bug filing.

## Bug field schema (template mirror)

Mirror of the configured template bug `{{TEMPLATE_BUG_ID}}` (a child of a `{{TEAM_NAME}}`
User Story). Adjust field reference names to your process if it differs from the default
Agile Bug.

| Field (reference name) | Value | Notes |
|---|---|---|
| `System.WorkItemType` | `Bug` | create route `POST …/_apis/wit/workitems/$Bug` |
| `System.Title` | short defect statement | duplicate-checked before create (fails closed) |
| `System.AreaPath` | `{{AREA_PATH}}` | inherit from parent story if unset |
| `System.IterationPath` | `{{ITERATION_PATH}}` | inherit from parent story if unset |
| `System.AssignedTo` | email | from the gate — `assignees` config or "other" |
| `Microsoft.VSTS.Common.Priority` | `1`–`4` | recommended from run impact, approved at the gate |
| `Microsoft.VSTS.Common.Severity` | `1 - Critical`…`4 - Low` | recommended from run impact, approved at the gate |
| `Microsoft.VSTS.Common.ValueArea` | `Business` | sent only when the project's Bug type has the field |
| `Custom.Environment` | `{{ENVIRONMENT}}` | validated against the field cache (omit if not in your process) |
| `Custom.BugCategory` | `{{BUG_CATEGORY}}` | validated against the field cache (omit if not in your process) |
| `Microsoft.VSTS.TCM.ReproSteps` | HTML (see below) | set post-create via json-patch — no size limit applies |

> Severity, priority, and `Custom.*` picklists are validated against the **project's real
> allowedValues** from the field cache (`.agentex/cache/tracker-fields-ado.json`), not a
> hardcoded table. A field the project doesn't define blocks the run instead of being
> emitted blind. Refresh the cache with `--refresh-fields`.

## REST routes the adapter uses

Reads (free, no gating):

| Operation | Route |
|---|---|
| Show work item (story/template validation) | `GET {{ORG_URL}}/{{PROJECT_NAME}}/_apis/wit/workitems/{id}?api-version=7.1[&$expand=all]` |
| Duplicate query (WIQL) | `POST …/_apis/wit/wiql` body `{"query": "SELECT [System.Id] FROM workitems WHERE …"}` |
| Field/picklist metadata (cache builder) | `GET …/_apis/wit/workitemtypes/{type}/fields?$expand=allowedValues` |
| Suites in a plan | `GET …/_apis/testplan/Plans/{plan}/suites` |
| Cases in a suite | `GET …/_apis/testplan/Plans/{plan}/Suites/{suite}/TestCase` |
| Test point for a case | `GET …/_apis/testplan/Plans/{plan}/Suites/{suite}/TestPoint?testCaseId={tc}` (per-suite — the global shortcut 404s on many orgs) |
| Run results | `GET …/_apis/test/Runs/{run}/results` |

Writes (dry-run by default; `--execute` only past the one approval):

| Operation | Route | Body |
|---|---|---|
| Server-side create validation | `POST …/_apis/wit/workitems/$Bug?validateOnly=true` | json-patch field ops |
| Create the Bug | `POST …/_apis/wit/workitems/$Bug` | `application/json-patch+json` — `[{"op":"add","path":"/fields/<ref>","value":…}, …]` |
| Parent link (the ONLY link) | `PATCH …/_apis/wit/workitems/{bugId}` | one relation op: `{"rel":"System.LinkTypes.Hierarchy-Reverse","url":"…/_apis/wit/workItems/{storyId}"}` |
| Upload a screenshot | `POST …/_apis/wit/attachments?fileName={name.png}` | raw bytes, `application/octet-stream` → returns `{id, url}` |
| ReproSteps + evidence relations | `PATCH …/_apis/wit/workitems/{bugId}` | ONE json-patch: the ReproSteps HTML + one `AttachedFile` relation per upload |
| Create a Test Case | `POST …/_apis/wit/workitems/$Test%20Case` | json-patch (`System.Title`, optional `System.AreaPath`) |
| Add TC to a suite | `PATCH …/_apis/testplan/suiteentry/{suiteId}?api-version=7.1-preview.2` | `[{"id": <tcId>}]` |
| Create a test run | `POST …/_apis/test/runs` | `{name, plan:{id}, pointIds:[…], automated:false, state:"InProgress"}` |
| Record the Failed result | `PATCH …/_apis/test/Runs/{run}/results` | `[{id, outcome:"Failed", state:"Completed", comment, associatedBugs:[{id}]}]` |
| Complete the run | `PATCH …/_apis/test/runs/{run}` | `{state:"Completed"}` |
| TC → bug durable link | `PATCH …/_apis/wit/workitems/{tcId}` | relation op `Microsoft.VSTS.Common.TestedBy-Reverse` |

The write sequence for a bug filing is fixed and fail-closed: validate everything → upload
attachments → create Bug → link parent → ReproSteps/evidence patch. The first failure
stops the sequence and every intended write lands in the ledger — done with ID + URL, or
not-done with the reason. Nothing is retried and nothing is cleaned up automatically.

## ReproSteps HTML shape

```
[hr] <table>  <b>{timestamp}</b> | {one-line summary}                       </table>
[hr] <table>  <b>Steps:</b>                                                 </table>
     <table>  <ol><li>step 1</li> … </ol>
              <u>Expected Result</u>  {text}
              <u>Actual Result</u>    {text}  <img src={attachment-url}>      </table>
[hr] <table>  <b>Test Configuration:</b> | {testConfig}                      </table>
```

`create-bug.js` regenerates this exact structure from the spec JSON — you don't hand-write
HTML. It travels as a request body, so a large repro can never hit a command-line length
limit. The returned attachment `url` is embedded as `<img src=…>` inside ReproSteps *and*
added as an `AttachedFile` relation, so the evidence renders in the bug body and lists
under Attachments.

## Failing an existing test case (what `testplan.js fail` does)

A Test Case work item has a **State** (Design/Ready/Closed), not pass/fail — the outcome
lives on a **Test Point** inside a Plan/Suite. `fail` locates the point (iterating the
plan's suites), then runs the fixed plan: create run → record the Failed result (reading
the real result id first — never guessed) → complete the run → tested-by link. A failure
partway names the run left `InProgress` in the ledger; completing or deleting it is the
user's call.

## Related references

- Estimation / test-design flows (same tracker layer, their own scripts):
  `${CLAUDE_PLUGIN_ROOT}/references/tracker/ado-boards.md` — shared boards knowledge, not
  needed by bug filing.
