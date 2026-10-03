# Jira Cloud boards — shared tracker knowledge (REST v3)

Provider knowledge shared by the **task-estimation**, **test-design**, and **bug-report-azure**
skills (and the ad-hoc **tracker-ops** surface). Every flow runs through bundled Node scripts
on the tracker layer (`scripts/lib/tracker/` — Jira Cloud REST v3 over built-in fetch);
nothing here is a CLI command. Read this when interpreting a script's JSON, composing a spec
file, or explaining a board state to the user. The ADO twin is `ado-boards.md`.

## Configuration and credentials

Non-secret settings live in the `jira` block of the consumer's `config/project.json`:
`site` (bare name → `https://<name>.atlassian.net`, or a full URL used as-is), `project`
(the KEY, e.g. `PROJ`), optional `board`, `assignee` (comma-separated emails), and the
documented overrides `storyType` (default `Story`), `subtaskType`, `bugLinkType`,
`storyPointsField`, `acceptanceCriteriaField`. Credentials are `JIRA_EMAIL` +
`JIRA_API_TOKEN` in `.env` (an API token from id.atlassian.com) — the scripts read them
themselves and send `Basic base64(email:token)` in the Authorization header only. Never
read, print, or pass either value; the email is credential material too.

## Field names and identities

Jira fields are flat ids, not ADO reference names. The scripts send and read:

| Meaning | Jira field |
|---|---|
| Title | `summary` |
| State | `status` (read-only — state CHANGES go through transitions) |
| Type | `issuetype` |
| Description | `description` (ADF on write; read `renderedFields.description` — HTML) |
| Environment (Bug) | `environment` (ADF; only when the Bug screen has it) |
| Assignee | `assignee: { accountId }` — **emails do not work**; the scripts resolve email → accountId via user search once per run and show the result on the consolidated screen |
| Priority | `priority: { name }` — a NAME (`High`), not an ADO-style number; validated against the project's real names |
| Estimates | `timetracking: { originalEstimate: "2h", remainingEstimate: "2h" }` — Jira duration format; only works when time tracking is on the create screen |
| Labels | `labels: ["testing"]` (the estimation flow's Activity=Testing analog) |
| Parent | `parent: { key }` — **sub-task (and epic) mechanics only**; scripts fold it inside the create, atomically |
| Story Points | a site-specific custom field (`customfield_*`) — discovered by display name, pinned via `jira.storyPointsField` once confirmed, never guessed |
| Severity | not a standard Jira field — a severity-like CUSTOM field is used only when the project's Bug screen has one; otherwise severity is omitted and the plan says so |

Valid values are project-specific: the scripts validate against the field cache
(`.agentex/cache/tracker-fields-jira.json`, built from **per-issue-type createmeta** routes)
and return the real `allowedValues` on a mismatch. Corrections are for the run only; the
consumer's config is never rewritten.

## Rich text is ADF — write structured, read rendered

Jira v3 bodies (description, environment, comments) are Atlassian Document Format. The
scripts own all composition (`scripts/lib/tracker/adf.js`): plain strings map
deterministically (blank line = new paragraph, single newline = hard break, no markdown),
and structured bodies (bug repro, test-artifact step lists) are built from spec data.
**Never hand-compose ADF JSON.** On reads, every `getWorkItem` requests
`expand=renderedFields`: interpret `renderedFields.<field>` (server-rendered HTML — the
same shape ADO reads have) instead of parsing raw ADF.

## JQL and the current sprint

JQL search runs through `POST /rest/api/3/search/jql` (the legacy `/search` endpoint is
**removed** — 410) with adapter-owned pagination. Escaping is adapter-owned too: values are
always double-quoted with `\` and `"` escaped — never concatenate raw values into JQL.

The current sprint resolves dynamically via the pinned composition in `create-tasks.js`:

```
project = "<KEY>" AND issuetype = "<storyType>" AND sprint in openSprints() ORDER BY key
```

> ⚠️ `openSprints()` can span several sprints (multi-board projects). The script then
> blocks with the real sprint names — ask the user which sprint in the ONE bundled round
> and re-run with `--sprint "<name>"`, or set `jira.board` in `config/project.json` so the
> agile API (board → active sprint) steers it. Never pick silently.

There is no iteration/area on Jira: sub-tasks ride their parent story's sprint — the plan
states this explicitly.

## Links, parents, and directions

- **Sub-task → parent** is `fields.parent` inside the create/update — the only relation the
  issue body can express. The scripts fold `rel: 'parent'` into it atomically.
- **Everything else is an issue link** (`POST /rest/api/3/issueLink`), a separate write that
  is planned and ledgered on its own. Link types are per-site — read them live
  (`issueLinkType`), recommend `Relates`, and let the user choose (`jira.bugLinkType` pins
  the bug→story choice once made). The acting item is the OUTWARD side by default; an
  explicit `direction: inward` option flips it — never guess a direction.
- **There is no Tested-By link** (`relations.testedBy: false`) — test artifacts link back to
  their story with the chosen issue link type, explicitly, never as a silent substitute.

## Attachments (write order inverts)

Jira attaches files to an **existing** issue (`POST /rest/api/3/issue/{key}/attachments`) —
there is no unparented upload. Bug filing therefore writes **create → attach ×N → link**
(ADO uploads first, then relates); the inversion is visible in the plan the user approves,
and a partial failure still names the created key and exactly which attachments landed.
The scripts own the multipart mechanics (built-in FormData/Blob, `X-Atlassian-Token:
no-check`, no manual Content-Type) — never compose an upload by hand.

## Existing children (before adding sub-tasks)

A story's sub-tasks come back inline on the story read (`fields.subtasks`, summaries
included — no per-child reads). `create-tasks.js` reports `existingTestingTasks`
(sub-tasks titled `[Testing]…`); the dry run **blocks** on them unless `--allow-existing`
is passed after the user explicitly chooses "add anyway". A read without a subtasks list
blocks too — fail closed, never create blind.

## Transitions (state changes)

Jira state changes are **transitions**, not field updates: the scripts read the REAL
available transitions for the issue and match the asked-for target by id or
case-insensitive name — no match fails closed listing what actually exists. (On ADO the
honest equivalent of a "transition" ask is a `System.State` field update.)

## Project prerequisites

A fresh Jira project often lacks what a flow needs. The scripts discover each gap at
run time — before any write — and block with the fix. Relay that fix to the user; never
work around it (no guessed sprint, no hours dropped, no substitute issue type).

| Flow needs | Discovered by | Blocked reason | Fix on Jira (admin) |
|---|---|---|---|
| An **open sprint** holding the stories (`/estimate-story` on the current sprint) | the `openSprints()` read comes back empty; a kanban/simple board also answers `400 The board does not support sprints` on the agile sprint route | `no-open-sprint` | Team-managed: **Project settings → Features → Sprints** on, then create and **start** a sprint holding the stories. Company-managed: use a **Scrum** board. Or skip sprints: `--ids <KEY,KEY>` estimates named stories |
| **Time tracking** on the sub-task type (hours → `timetracking`) | the sub-task's per-issue-type createmeta has no `timetracking` field | `field-not-on-type` (`field: timetracking`) | Site-wide: **Settings → Work items (Issues) → Time tracking** must be on. Team-managed: **Project settings → Work types → \<sub-task type\>** → add the **Time tracking** field. Company-managed: add **Time tracking** to the sub-task's create screen. Re-run with `--refresh-fields` after the change |
| A **Bug** issue type (bug filing) | createmeta lists the project's real types | `no-bug-type`, listing the real types | Team-managed: **Project settings → Work types → Add work type → Bug**. Company-managed: add Bug to the project's issue type scheme |

Menu names drift across Jira Cloud UI versions ("Issues" ↔ "Work items", "Issue types" ↔
"Work types"); the fix is the same.

## Known limitations (capability flags — the honest gaps)

| Flag | Jira | What the flows do about it |
|---|---|---|
| `testPlans` / `testRuns` | `false` — no test-plan/suite/run APIs | `testplan.js` refuses upfront (exit 2, one line); bug filing offers only what exists: skip (default) or link an existing `/design-test` artifact — explicitly chosen (Q11) |
| `relations.testedBy` | `false` | artifacts link via a chosen issue link type, on the screen |
| `validateOnly` | `false` — no server-side create dry-run | the createmeta cache + required-field checks carry pre-gate validation; the plan notes `validateOnly: 'unsupported-on-jira'` |
| `deleteWorkItem` | `false` — Jira Cloud's only issue delete is **permanent** | never offered; a delete ask gets the upfront "not supported on this tracker" answer (portal cleanup is the user's call) |
| native Test Case type | none | `/design-test` informs the user and asks what to create (Q11) before writing anything |
