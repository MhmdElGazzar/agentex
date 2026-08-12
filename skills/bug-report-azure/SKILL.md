---
name: bug-report-azure
description: After a completed test/regression run where one or more defects were found, file them as Azure DevOps Bugs via the Azure CLI (az devops / az boards), following the team's standard Bug layout. Product/team-agnostic — org, project, area path, reference bug, assignees, and test plan are all placeholders resolved from config, never hardcoded. Human-in-the-loop at every board-changing step: the Bug layout and its field values, parent User Story, related test case / suite, severity + priority (recommended from the run's findings, with alternatives to choose), and screenshot validation — all rolled into ONE consolidated confirmation before any write. Uses the az CLI for every lookup, validation, and write, plus two documented direct REST calls (binary attachment upload, and the post-create JSON Patch); never touches the board beyond what the user explicitly confirms.
---

# Report Azure Bug (Generic)

Turn defects found during a run into Azure DevOps **Bugs** that follow the team's standard Bug
layout and hang off the right User Story — with a human confirming every board-changing step.
This is the closing gate of a test run.

This skill is **decoupled from any specific team or product**. Everything team-specific is a
placeholder resolved at runtime from `config/project.json`'s `azure` block or legacy `AZURE_*` 
keys in `.env` (never hardcoded in the skill):

| Placeholder | Meaning | Resolved from |
|---|---|---|
| `{{ORG_URL}}` | Azure DevOps org URL | `azure.org` (`config/project.json`) → `AZURE_URL` / `AZURE_DEVOPS_ORG_URL` / `AZURE_ORG` → `az` defaults |
| `{{PROJECT_NAME}}` | Project | `azure.project` (`config/project.json`) → `AZURE_PROJECT` / `AZURE_DEVOPS_DEFAULT_PROJECT` → `az` defaults |
| `{{TEAM_NAME}}` | Team | `azure.team` (`config/project.json`) → `AZURE_TEAM` |
| `{{AREA_PATH}}` | Area Path | spec override → **inherited from the parent User Story** → `AZURE_AREA_PATH` → **hard error** (never Azure DevOps' own default — that's the bare project root) |
| `{{ITERATION_PATH}}` | Iteration Path | spec override → **inherited from the parent User Story** → `AZURE_ITERATION_PATH` → left unset so Azure DevOps applies its own default |
| `{{TEMPLATE_BUG_ID}}` | **Reference bug** — an existing Bug to *show* the user what the standard layout looks like on the board. Read-only: nothing is ever copied from it (see step 2) | `azure.bugTemplateId` (`config/project.json`) → `AZURE_BUG_TEMPLATE_ID` (optional) |
| `{{ASSIGNEE_EMAIL}}` | Bug assignee options | `azure.assignee` (`config/project.json`) → `AZURE_ASSIGNEE` (comma-separated) — **always asked** |
| `{{TEST_PLAN_ID}}` / `{{TEST_SUITE_ID}}` | Related test plan / suite | `azure.testPlanId` (`config/project.json`) → `AZURE_TEST_PLAN_ID` — **always asked** |
| `{{ENVIRONMENT}}` / `{{BUG_CATEGORY}}` | Custom fields | `azure.environment` / `azure.bugCategory` (`config/project.json`) → `AZURE_ENVIRONMENT` / `AZURE_BUG_CATEGORY` as a starting recommendation — **always recommended-then-confirmed with the user, never looked up from existing bugs** |

Config lives in `config/project.json`'s `azure` block (primary) or `AZURE_*` keys in `.env`.
Both env naming conventions resolve — AgenTeX's own `AZURE_URL` / `AZURE_PROJECT` (what the setup
wizard and `.env.example` write) and the azure-devops MCP server's `AZURE_DEVOPS_ORG_URL` /
`AZURE_DEVOPS_DEFAULT_PROJECT` — so a project on either set works unchanged. Anything left unset
is **asked**, never inferred — see constraint 8.

## Tooling: az CLI, plus two documented HTTPS calls

- Lookups, validations, links, the Bug create and every test-plan route go through the **Azure
  CLI** (`az devops`, `az boards`, and `az devops invoke` for routes `az boards` doesn't cover).
  **No UI-equivalent actions outside the CLI.**
- **Exactly two calls go over direct HTTPS**, because `az` provably cannot make them. Both are
  in `_lib.js`, both print the request they will send, and both are covered by the same
  `--execute` gate as everything else:
  - **Attachment upload** (`uploadAttachmentBinary`) — `az devops invoke --in-file` text-decodes
    the file before sending, so it can never carry raw binary; a PNG fails with "Unable to decode
    file" before any network call. `az boards` has no attachment verb at all. This is the
    documented [Work Item Attachments - Create](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/attachments)
    binary REST request.
  - **The post-create JSON Patch** (`patchWorkItem`) that sets ReproSteps and adds the
    AttachedFile relations — `az devops invoke ... PATCH --route-parameters id=<id>` mis-routes
    to the work-item *create* location and dies with `KeyError: 'type'`, and the typed
    `az boards work-item update --fields` alternative puts the whole ReproSteps HTML on the
    command line, where **cmd.exe truncates anything past 8191 characters** (a 22-step repro with
    two screenshots measures ~9,000). Sending it over HTTPS from memory removes the ceiling.
- **Auth / secrets.** `az` uses whatever it already has: `az login` + `az devops login` (PAT), or
  `AZURE_DEVOPS_EXT_PAT`. The two HTTPS calls above cannot borrow az's auth, so the skill reads a
  PAT **for those two requests only** — `AZURE_DEVOPS_EXT_PAT`, then `AZURE_DEVOPS_PAT`, then
  `AZURE_PAT` ([PAT auth](https://learn.microsoft.com/en-us/azure/devops/cli/log-in-via-pat)).
  It is never logged or printed (the request preview shows `Basic <PAT, not printed>`) and never
  leaves `_lib.js`. **This is the only place the skill touches a secret** — if that ever changes,
  this section changes with it. Set `PYTHONIOENCODING=utf-8` so non-ASCII fields don't trip
  cp1252 on Windows.
- Two dry-run-by-default helpers wrap all of it so a human sees the plan first:
  - `${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/create-bug.js` — create a Bug + parent link (+ validated attachments).
  - `${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/testplan.js` — `list-suites` / `list-cases` / `find-case` / `create-case` / `fail`.
  - `${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/check-image.js` — structural screenshot validation (Pass 1 of the evidence gate).
  - `${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/list-picklist.js` — read-only: a field's allowed values and whether the process makes it mandatory.

  Both write helpers print the **exact commands and requests they will run** and change nothing
  until `--execute` is passed. The dry run walks the *same* code path as the real run with
  `execute=false`, so the preview cannot drift from what executes. Both modes first ask Azure to
  validate the payload (`validateOnly`, which creates nothing), so field errors surface before
  the user confirms rather than half-way through writing.

### Reading values back: don't trust `az` output for non-ASCII

On Windows, `az` re-encodes its stdout to the console code page (cp1252) and **replaces any
character that doesn't fit** — it even warns: *"Unable to encode the output with cp1252 encoding.
Unsupported characters are discarded."* An Arabic title, an em dash, a curly quote will all read
back as `?` or `U+FFFD` **even though the value stored in Azure DevOps is perfectly intact**.

So: never conclude from `az boards work-item show` that a field was written incorrectly, and never
"repair" a field based on that output — you will overwrite good data with worse. The write paths
themselves preserve Unicode correctly (verified: an em-dash title round-tripped as `U+2014` when
read over HTTPS while the same field read through `az` showed `U+FFFD`). If you genuinely need to
verify stored text, read it over the REST path or check it in the browser.

### Writing values: no user text ever reaches a shell

`cmd.exe` expands `%NAME%` while *parsing* the command line — **before** quoting is considered, so
double quotes do not protect it, and there is no escape sequence for it either (`%%` is a
batch-file rule, not a command-line one). A title carrying a live `%NAME%` would reach Azure
DevOps silently rewritten to that variable's value, and — if the value contains a quote — could
break out of the quoting entirely.

Because it cannot be escaped, the fix is **structural: every payload carrying user text travels
in a file or over HTTPS, never as a shell argument.** That now covers all of them — the Bug
create, the Test Case create, the ReproSteps patch, the duplicate-check WIQL, and every
`testplan.js` write. What is left on a command line is ids, field names and route parameters.

`assertNoShellExpansion` (in `_lib.js`) stays as a **backstop**: if any argument ever does carry a
`%NAME%` matching a real environment variable, the run stops and names it rather than writing
something the user never typed. Only an existing variable triggers it, so ordinary text
(`"Totals wrong for 50% discount"`) passes untouched. If you hit it, reword the text or move that
payload into an `--in-file` — don't try to escape it.

## Hard constraints (never violate — these are the point of the skill)

1. **Write nothing on Azure DevOps beyond what the user explicitly confirmed** — the bug itself,
   the confirmed field values, the confirmed parent User Story link, the confirmed
   test-case/suite action, and the validated screenshot attachment. Nothing else, ever.
2. **All read / lookup / validation via `az` may run freely.** No **write / create / update /
   link / attach** may happen until (a) every human-in-the-loop question below is answered **and**
   (b) the user has given **one final explicit confirmation** of the complete consolidated summary.
3. **Exactly two link types, each in its own place, both via `az boards work-item relation add`:**
   - **Bug parenting — `parent` only:** User Story → (parent) → Bug. This is the only link
     `create-bug.js` ever creates.
   - **Only when the user explicitly chooses to link the failing test case (step 6) — `tested by`:**
     Test Case → (tested by) → Bug, created by `testplan.js fail` as part of recording the Failed
     outcome the user asked for.

   No related / duplicate / predecessor-successor / any other link, ever — and never a `tested by`
   link without that explicit step-6 choice.
4. **Never edit a User Story** except adding that single parent link — no field/state/description
   changes on the story.
5. **Never edit a Test Plan / Suite / Test Case** except the two explicit, user-chosen actions:
   (a) recording a *Failed outcome* on an existing linked test case, or (b) creating a new test
   case when the user explicitly asks. No other modifications.
6. **Log every write `az` command before running it.** The write helpers print the command; show
   it to the user as part of the confirmation. No silent writes.
7. **Idempotency:** before creating a Bug or Test Case, check via `az` whether one with the same
   title already exists. If a potential duplicate is found, surface it and ask the user before
   creating. **A check that fails to run is not a pass** — the scripts refuse to create until the
   user explicitly waives it with `--allow-duplicate`.
8. **Never infer or auto-fill missing required fields** (priority, severity, area path, assignee,
   environment). Ask the user, or use a clearly-marked `{{PLACEHOLDER}}` — never a silent guess.
9. **On any `az` failure, surface the exact error** to the user. Never auto-retry a
   destructive/write action.
10. **Fail closed, never half-file.** Under `--execute`, anything that would produce a silently
    wrong Bug stops the run instead of degrading it. Screenshots upload **before** the Bug is
    created, so a failed upload aborts with nothing written to the board — a Bug missing the
    evidence the user just approved is worse than no Bug. Each stop has its own explicit override
    (`--allow-failed-upload`, `--allow-duplicate`, `--no-screenshots`, `--force`), so continuing
    anyway is always a deliberate, logged choice the user makes — never a silent fallback.

## When to run

At the end of any run/task that surfaced one or more issues. Offer it proactively: "N issues were
found — want to file any as Azure Bugs?" If the user declines, stop. Do nothing on the board.

## Workflow (human-in-the-loop)

Steps 1–6 **collect and validate** (reads only). Nothing is written until the single
confirmation in step 7.

### 1. Which issues to report
List the defects from the run (short title + one-line impact each). Ask the user to pick which to
file. **If none selected → stop, create nothing.**

### 2. Bug layout + field values (ASK — human-in-the-loop)
The Bug's **layout is fixed by `create-bug.js`**: the field set it sends and the ReproSteps HTML it
builds (timestamp + summary / steps / expected / actual + embedded screenshots / test config).
What the user actually chooses here is the **values** that fill it — everything in the spec JSON.

`{{TEMPLATE_BUG_ID}}`, when configured, is a **reference bug**: an existing Bug you can open to
show the user what that layout looks like in practice. It is **read-only** — no script reads
fields off it, nothing is copied from it, and pointing at a different one does not change what
gets created. Validate it exists before showing it:
`az boards work-item show --id {{TEMPLATE_BUG_ID}}`.

Show the layout and the values you intend to fill in, then ask:

> *"This is the standard Bug layout and the values I'd fill in — use these, or change any of them?"*

Offer: **(a)** use them as-is, **(b)** change specific field values (they carry into the spec JSON).
**Do not proceed until the user confirms.** If they want a genuinely different *shape* (different
fields or a different ReproSteps structure), that's a change to `create-bug.js`, not something to
improvise per run — say so instead of silently filing a differently-shaped Bug.

**Environment / Bug Category (RECOMMEND, then ASK — don't front-load a lookup).** These are
picklist fields. Propose a value from the run's own context — Environment from where the defect
was actually observed (e.g. "UAT", "QC"); Bug Category from the defect's nature in plain language
(e.g. "Functional" for a logic/behaviour defect, "System Issue" for a crash/infra failure) — state
the one-line reasoning, and ask the user to confirm or type a different value. Do **not** query
existing bugs to discover allowed values, and don't spend a lookup before the first attempt.

**If Azure rejects the value, you get the real list — use it, don't guess again.**
`create-bug.js` validates every payload server-side before it writes anything (`validateOnly`),
so a bad picklist value surfaces during the dry run, before the user's confirmation. On rejection
it prints the exact `az` error **and that field's actual allowed values**, read from the process.
Show those values to the user and **ask which one applies** — the list is the project's
vocabulary, but which value is correct is a judgement about the run, so it is still never your
call. Never retry with a value the user didn't choose.

To look a field up deliberately (new project setup, "what can Environment even be?"):
```
node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/list-picklist.js --field Custom.Environment
node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/list-picklist.js --required
```
Read-only, one `az` call, cached per run. Note that a process can make these fields
**mandatory** — `--required` shows which ones, and a missing required field is reported the same
way as a bad value.

### 3. Parent User Story link (ASK + validate via CLI)
**Ask the user for the parent User Story ID** to link each selected bug to — never infer or
default it. One question can cover all selected issues if they share a parent. **Validate it
exists and is a User Story before proceeding:**
```
az boards work-item show --id <storyId> --query "{id:id,type:fields.\"System.WorkItemType\",title:fields.\"System.Title\",state:fields.\"System.State\"}" -o json
```
If the ID is not found, or the type is not `User Story`, **report that back and ask again** — do
not guess. `create-bug.js` re-validates this and refuses a non-story parent.

Area Path **inherits from this story by default** (a `spec.areaPath` override or
`AZURE_AREA_PATH` still wins if set). It never silently falls back to Azure DevOps' own
default — that's the bare project root, not the team's area —
so if the parent story itself has no Area Path and nothing else resolves one, `create-bug.js`
**errors out** rather than guessing.

Iteration Path also **inherits from this story by default** (spec override still wins, and a
configured `AZURE_ITERATION_PATH` is the next fallback). If none of the three provides one, it's
left unset and Azure DevOps applies its own default — an acceptable fallback for Iteration
specifically, unlike Area Path.

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
node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/testplan.js find-case --plan <plan> --testcase <tc>
```
(under the hood: `az boards work-item show` + a suite/point lookup via `az devops invoke`). If it
doesn't exist, report back and ask again.

**If no specific test case is provided** — ask whether a **new test case should be created**:
- **If yes** → ask **which test suite** (and plan) it should be added to. Only after confirmation,
  create it and add it to that suite (step 7 executes it):
  ```
  node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/testplan.js create-case --plan <plan> --suite <suite> --title "<title>" [--execute]
  ```
- **If no** → skip the test-case link; the bug is filed on its own.

Either way, take **only** the action the user explicitly picks. Nothing here is written until step 7.

### 7. Screenshots + CONSOLIDATED confirmation + write
A bug should carry evidence. Validate screenshots **before** attaching (two passes):

**Pass 1 — structural (script):**
```
node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/check-image.js --dir <screenshots-folder>
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
node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/create-bug.js --spec <spec>.json
```
The dry run prints the plan, an idempotency (duplicate-title) check, the attachment structural
checks, **and the exact commands and requests** it will run — produced by the same code path the
real run takes, so the two cannot disagree.

Now present **ONE consolidated confirmation** covering everything collected — avoid scattered
confirmations. Include:
- Bug layout + the field values confirmed (step 2)
- Parent User Story (validated, step 3)
- Severity + Priority (chosen, step 4) with the one-line reasoning
- Assignee (step 5)
- Test case / suite decision (validate-existing / create-new / skip, step 6)
- Screenshot validation result — the final ATTACH / REJECT list with reasons (step 7)
- The exact write commands and requests that will run

**Only after the user's single explicit "yes" to this summary**, execute in order:
```
node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/create-bug.js --spec <spec>.json --execute                 # bug + parent link + attachments + repro
node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/testplan.js create-case --plan <plan> --suite <suite> --title "<t>" --execute   # only if chosen
node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/testplan.js fail --plan <plan> --testcase <tc> --bug <bugId> --execute           # only if chosen
```
Report back each new Bug / Test Case ID + URL. If any command fails, show the **exact** error and
stop — do not auto-retry the write.

**If `--execute` refuses (constraint 10)**, do not reach for the matching override flag on your
own. The refusal names exactly what went wrong — a screenshot that didn't upload, a duplicate
check that couldn't run, no valid evidence. Fix the cause if it's fixable, otherwise **go back to
the user**, show them the refusal, and only pass `--allow-failed-upload` / `--allow-duplicate` /
`--no-screenshots` / `--force` if they say so. Each flag drops a guarantee they already agreed to
in the summary above, so re-confirming is not optional.

## Spec JSON shape (for create-bug.js)

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
- `areaPath` override → inherits from the parent story → `AZURE_AREA_PATH` → the script errors
  out rather than falling back to Azure DevOps' own default (the bare project root).
- `iterationPath` override → inherits from the parent story → `AZURE_ITERATION_PATH` → omitted,
  letting Azure DevOps apply its own default (acceptable for Iteration, unlike Area Path).
- `attachments` are validated structurally before anything is uploaded. Invalid entries are
  **skipped, never uploaded** (`--force` waives the abort, not the check), and the evidence gate
  counts what can actually be attached — not what the spec listed.

## Notes
- The scripts need only Node 18+ (built-in modules, incl. `fetch`) + a working, authenticated
  `az` CLI on PATH.
- Tests — two offline suites, 43 checks, no network and no real Azure DevOps (`az` is stubbed on
  PATH). **Run both after any change here.**
  ```
  node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/create-bug.test.js
  node ${CLAUDE_PLUGIN_ROOT}/skills/bug-report-azure/scripts/testplan.test.js
  ```
  `create-bug.test.js` (22): config aliases, dry-run parity, oversized ReproSteps, every
  fail-closed gate, picklist rejection, spec robustness, and that user text reaches the payloads
  unmangled — its one `--execute` case points at the discard port. `testplan.test.js` (21): error
  propagation (a real `az` failure must never read as "no test point"), the `create-case`
  plan/suite preflight, all four writes of `fail` appearing in the dry run, partial-write
  reporting, and the same no-text-on-a-command-line guarantees.
- Keep spec files out of committed state (write them to a temp/execution folder). They carry no
  secrets but are run scratch.
- `az devops invoke` is used where `az boards` has no native verb (the Bug create, test-run
  outcomes). It is still the Azure CLI — every such command is printed before it runs. The two
  calls that bypass `az` entirely are listed in "Tooling" above and nowhere else.
- `--in-file` payloads are written to the OS temp dir immediately before the call and deleted
  right after; the ReproSteps patch never touches disk at all.
