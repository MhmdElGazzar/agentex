# Official ACLI reference

Use this file when choosing an ACLI command family, composing common Jira operations, installing or authenticating ACLI, or diagnosing version-related behavior. Confirm flags with the installed command's `--help` before execution.

## Execution boundary

Use only Atlassian's official `acli jira` command family for Jira operations
performed under this skill. Do not replace an unavailable or failing ACLI
operation with Jira MCP, direct REST, `curl`, browser automation, or a
third-party Jira CLI. Local shell commands may prepare input and inspect ACLI
output, but must not call Jira independently. When live ACLI help does not
expose the required capability, report the limitation.

The full `acli` binary also exposes `admin` (org user management — a
separate, higher-blast-radius surface with its own credential; out of scope
here entirely), `feedback` (sends CLI feedback to Atlassian, not a Jira data
operation), and `rovodev` (an AI pair-programming assistant, unrelated to
Jira). None of the three belong to this skill's `acli jira` boundary.

## Official sources

- Installation: <https://developer.atlassian.com/cloud/acli/guides/install-acli/>
- Getting started and authentication: <https://developer.atlassian.com/cloud/acli/guides/how-to-get-started/>
- Command reference: <https://developer.atlassian.com/cloud/acli/reference/commands/>
- Jira work item commands: <https://developer.atlassian.com/cloud/acli/reference/commands/jira-workitem/>
- Command chaining and output: <https://developer.atlassian.com/cloud/acli/guides/manage-command-chaining-and-output-redirection/>
- Changelog: <https://developer.atlassian.com/cloud/acli/changelog/>
- Troubleshooting: <https://developer.atlassian.com/cloud/acli/guides/troubleshooting-guide/>
- Jira Cloud rate limiting: <https://developer.atlassian.com/cloud/jira/platform/rate-limiting/>

Atlassian supports each ACLI release for a limited period. Prefer a supported version and check the changelog when authentication scopes, available commands, or behavior differ from expectations.

The March 2026 ACLI OAuth permission update requires site administrators to re-authorize connected sites after upgrading to the affected releases. When authentication reports that a site administrator must authorize the app, do not repeat login blindly; consult the current changelog and have the site administrator complete the documented re-authorization.

## Discover commands

Walk down the live command tree:

```text
acli --help
acli jira --help
acli jira workitem --help
acli jira workitem <action> --help
```

Use the same pattern for `project`, `board`, `sprint`, `field`, `filter`, and `dashboard`.

## Authentication patterns

Check status:

```text
acli jira auth status
```

Prefer interactive OAuth:

```text
acli jira auth login --web
```

For API-token authentication, follow Atlassian's current standard-input
instructions. Never put a token in an argument, tracked source file,
transcript, or generated artifact.

## Read patterns

List visible projects:

```text
acli jira project list --limit 50 --json
```

Count a JQL result:

```text
acli jira workitem search --jql 'project = TEAM AND status != Done' --count
```

Search with selected fields:

```text
acli jira workitem search --jql 'project = TEAM ORDER BY updated DESC' --fields 'key,summary,assignee,priority,status' --limit 50 --json
```

Fetch every result only when necessary:

```text
acli jira workitem search --jql 'project = TEAM' --paginate --json
```

Inspect one work item:

```text
acli jira workitem view TEAM-123 --json
```

Resolve sprint-scoped Stories:

```text
acli jira board search --project 'TEAM' --paginate --json
acli jira board list-sprints --id '6' --paginate --json
acli jira sprint list-workitems --board '6' --sprint '42' --jql 'issuetype = Story' --fields 'key,summary,status' --paginate --json
```

Compare sprint-scoped results with project-wide JQL before deriving work
items. A future or active sprint can be empty, and Stories whose summaries
match the sprint goal can still be unassigned.

When creating a sprint, **`--name` must be under 30 characters** (verified) —
a longer name fails with `✗ Sprint name must be shorter than 30 characters.`
Keep the descriptive detail in `--goal`, not the name.

The `board` family on 1.3.22 is wider than the published reference lists —
live help shows `create`, `delete`, `list-projects`, `list-sprints`,
`search`, and a deprecated `get`. `board list-projects --id <boardId>` is
real and useful for mapping a board back to its projects; `create`/`delete`
are board administration and need the same confirm-before-write treatment as
any other mutation.

Use `--csv` for tabular export and `--json` for reliable parsing when the command supports them.

Clone only after inspecting the installed command's exact options and the source work item:

```text
acli jira workitem clone --help
```

## Mutation patterns

Create a work item:

```text
acli jira workitem create --project 'TEAM' --type 'Task' --summary 'Concise summary' --description-file 'description.txt' --json
```

Edit exact keys:

```text
acli jira workitem edit --key 'TEAM-123' --summary 'Updated summary'
```

Transition exact keys:

```text
acli jira workitem transition --key 'TEAM-123' --status 'In Progress'
```

Create a comment:

```text
acli jira workitem comment create --key 'TEAM-123' --body-file 'comment.txt' --json
```

Delete an explicitly authorized exact key only after viewing it:

```text
acli jira workitem view TEAM-123 --json
acli jira workitem delete --key 'TEAM-123' --yes --json
acli jira workitem view TEAM-123 --json
```

Require the delete JSON to identify `TEAM-123` with a successful status. The
final view should fail with a not-found or no-permission response. Because
that response is ambiguous by itself, accept it as deletion evidence only
when the pre-delete view proved access and the delete response proved success.
Do not rely on a JQL count for the deleted key; Jira may reject
`key = TEAM-123` after deletion instead of returning zero.

Generate the installed version's bulk-create schema:

```text
acli jira workitem create-bulk --generate-json
```

Then populate and validate the generated structure before running:

```text
acli jira workitem create-bulk --from-json 'workitems.json'
```

Generate `workitem create --generate-json` and
`workitem create-bulk --generate-json` independently. In ACLI `1.3.22`, the
observed bulk template used an `issues` array with `projectKey`, `issueType`,
and singular `label` properties, while the single-create template used
different names and a different root shape. Treat this as installed-version
behavior and regenerate the templates rather than hard-coding it.

Use deterministic marker labels for repeatable creates. For example, pair a
role label such as `test-case-structure` with a source label such as
`source-team-123`, query those labels before creating, and query them again
afterward. ACLI's bulk command may report only an aggregate success count, so
the read-back query is required to prove one expected result per source.

For Story-derived QA structures:

- Inspect `project view --key <KEY> --json` before choosing a work item type.
- Use `Subtask` plus the Story's immutable Jira ID when a test structure must
  be a child. The single-create template describes `parentIssueId` as
  subtask-only.
- Use `Task` for an independent placeholder and label it explicitly; do not
  describe it as a native Test Case.
- Keep a Bug as `Bug` and link it to the Story with an available ACLI link type
  when the relationship is required. **`--parent` on `workitem create --type
  Bug` is rejected** (confirmed live: `✗ Error: Please select valid parent
  issue.`) — `--parent` only accepts a Subtask's parent; a standard top-level
  type (Bug, Task, Feature) can never use it, even against its own Story.
  Create the Bug with no `--parent`, then run `link create --out <BUG-KEY>
  --in <STORY-KEY> --type Relates` as two separate calls.
- Omit the description property entirely when the requested structure must
  have no description, then select `description` during read-back verification.
- Treat fixed generation and dynamic, acceptance-criteria-driven generation
  as different scopes. Dynamic generation requires complete Story detail and
  can produce multiple structures per Story.

Create a link after checking available link types:

```text
acli jira workitem link type
acli jira workitem link create --out 'TEAM-123' --in 'TEAM-456' --type 'Blocks'
```

`link create` does **not** accept `--json` (confirmed live: `✗ Error: unknown
flag: --json` on 1.3.22, even though it appears in some fetched flag
references) — omit it and parse the plain-text confirmation line instead
(`✓ Link between issues has been successfully created (...)`), or verify the
link afterward with `workitem view <KEY> --fields issuelinks --json`.

`link create` has no `--jql`/`--filter` bulk-targeting flag — unlike `edit`,
`delete`, `transition`, `assign`, `archive`, and `clone`, one invocation
links exactly one pair. For many links at once, use `--from-csv` or
`--from-json` (`--generate-json` writes a starter template) instead of
looping single creates.

Treat these as patterns. Verify exact syntax and available flags using live help.

## Relationship fields are silently omitted unless requested by name

Confirmed live on 1.3.22, and distinct from the already-documented `search
--fields parent` rejection below: a bare `workitem view <KEY> --json` returns
only a small default field set (`assignee`, `description`, `issuetype`,
`status`, `summary`) — **`parent` is absent entirely, not even `null`**, even
on a Subtask that genuinely has one. The same is very likely true of
`issuelinks` and other relationship fields on a bare read.

This reads as "not linked" when it may simply not have been asked for:

```text
acli jira workitem view TEAM-123 --json                       # parent silently missing
acli jira workitem view TEAM-123 --fields parent --json       # parent now present, if set
acli jira workitem view TEAM-123 --fields issuelinks --json   # same pattern for links
```

Never conclude a parent or link is missing from a bare `view`/`search` —
always re-check with the specific relationship field named in `--fields`
before reporting a create/link as failed or verifying it as successful.

Separately, `--fields` on `workitem search --json` does not trim the JSON
payload the way it trims table output — a search with `--fields
'key,summary,status'` still returns every field on the issue (~40 keys, most
`null`). The requested values are present; expect a larger payload than the
flag name implies, and don't parse assuming only the named fields exist.

## Field, filter, and dashboard commands

These three families are administrative/discovery surfaces, not everyday
work-item operations — confirm the exact subcommand with live help since
they're thinner and change less predictably than `workitem`:

The lists below came from live `--help` on 1.3.22 and differ from Atlassian's
published reference pages, which are incomplete for these families. **Trust
live help over the web docs here** — several real subcommands are simply not
published, and some published ones are deprecated in the binary.

- **`field`** — custom-field administration: `create`, `update`, `delete`,
  `restore`, and `cancel-delete` (the latter marked **[DEPRECATED]** in the
  binary — prefer `restore`). Still **no `field list`/`field search`**, so
  you cannot enumerate a project's field catalog through `acli`; use
  `GET /rest/api/3/field` when a catalog read is genuinely needed.
- **`filter`** — saved-filter management, and considerably wider than the
  published reference suggests: `add-favourite`, `change-owner`, `list`
  (requires `--my` or `--favourite`), `list-columns`, `reset-columns`,
  `search`, `update`, `view`, plus `get` and `get-columns` (both marked
  **[DEPRECATED]** — use `view` and `list-columns` instead).
- **`dashboard`** — read-only: `search` (`--name`, `--owner`, `--limit`) is
  the only subcommand. No dashboard create/view/update through `acli`.

```text
acli jira filter list --my --json
acli jira filter search --name 'My QA filter' --json
acli jira filter view --id '10001' --json
acli jira dashboard search --owner 'you@example.com' --json
```

## JQL and bulk-operation checks

Before a mutation selected by JQL or filter:

1. Run `search --count`.
2. Run `search --fields 'key,summary,status' --json`.
3. Confirm that the site, project, count, and keys match the requested scope.
4. Execute without `--yes` when ACLI can prompt.
5. Re-run a narrow search to verify the result.

Avoid unbounded selectors such as a project-only JQL when the request names a smaller scope. Do not replace a rejected selector with a broader one.

## Troubleshooting cues

- Command or flag missing: inspect `acli --version`, live `--help`, the installation guide, and the changelog.
- Not authenticated: run `acli jira auth status`, then use `acli jira auth login --web`.
- Site-admin authorization error: check the latest changelog for OAuth scope or site reauthorization notices.
- Forbidden or field unavailable: verify Jira permissions, project type, work item type, field context, and edit metadata.
- Transition unavailable: inspect the work item's current status and Jira workflow; status names alone do not guarantee an allowed transition.
- JQL rejected: test it with read-only `workitem search` before any mutation and preserve Jira's error details.
- Search field rejected: keep the JQL unchanged, remove only the unsupported
  output field, and use `workitem view` for exact-item detail. A valid Jira
  field is not necessarily accepted by `workitem search --fields`.
- Partial bulk failure: stop unless the user explicitly accepted `--ignore-errors`; report every failed key.
- HTTP 429: honor `Retry-After` and `RateLimit-Reason`, reduce request concurrency, and use bounded exponential backoff with jitter only when the operation is safe to repeat.
- Unknown mutation result: read the intended target before retrying a create, clone, comment, link, or attachment operation.

## Live-run observations to reconfirm

These observations came from ACLI `1.3.22` against a team-managed Jira Cloud
software project. Reconfirm them with the installed binary and target project:

- `project list --paginate --json` returned a top-level JSON array.
- `project view --key <KEY> --json` exposed the project's `issueTypes`, which
  is the reliable preflight before mapping a requested domain artifact to a
  Jira type.
- `workitem search --json` returned each key at `.key` and selected values
  under `.fields`.
- The search command rejected `parent` as an output field even though parent
  is a Jira concept; removing that display field allowed the same JQL to run.
- Omitting `description` from the bulk payload produced a null description,
  which can be verified by selecting `description` in the read-back search.
- Authentication created in one sandbox or elevation context was not visible
  from another. Keep login, status, and live commands in the same execution
  context.
- ACLI `1.3.22` exposed sprint create, delete, list-workitems, update, and view,
  but no explicit add-workitems or move-to-sprint command. Its work-item
  create and edit flags also exposed no sprint flag. Do not promise sprint
  placement without a separately verified ACLI contract.
- The single-create template exposed `additionalAttributes`, but that alone
  did not prove that an undocumented Sprint custom-field payload was valid.
  Do not guess one in a live project.
- Generated Task and Bug structures created without a sprint field remained
  in the backlog. A parent Subtask relationship and an explicit top-level
  sprint assignment are different facts and must be reported separately.
- After an exact-key delete, `workitem view` returned a not-found or
  no-permission response, while JQL for the deleted key was rejected instead
  of returning a zero count. Correlate the pre-delete view, successful delete
  JSON, and failed post-delete view.

The following came from a second live run, ACLI `1.3.22` against a
team-managed Jira Cloud software project, 2026-07-26 — 34 work items
created (17 Test Case Subtasks, 17 Bugs, one pair per Story), each verified
by read-back, no pre-existing data changed:

- `workitem create --type Bug --parent <STORY-KEY>` failed on every attempt
  (`✗ Error: Please select valid parent issue.`) — confirms `--parent` is
  Subtask-only; a standard top-level type rejects it even against its own
  Story. `workitem link create --out <BUG> --in <STORY> --type Relates` as a
  separate call is the only working path.
- `workitem link create --json` failed (`✗ Error: unknown flag: --json`) —
  the flag does not exist on this command in 1.3.22 despite appearing in an
  earlier fetched reference. Parse the plain-text confirmation instead.
- A bare `workitem view <KEY> --json` omitted `parent` entirely (not even
  `null`) on 17/17 Subtasks that had a real, confirmed parent — `--fields
  parent` had to be requested by name to see it. Treat this as distinct from
  the `search --fields parent` rejection above: `view` doesn't reject the
  field, it just doesn't include it by default.
- `workitem search --fields 'key,summary,status' --json` returned the full
  ~40-key raw issue payload regardless — `--fields` narrows table output,
  not the JSON shape.

A third pass walked the complete live `--help` tree on the same binary
(2026-07-26). **Atlassian's published command reference is materially
incomplete** — several real subcommands are unpublished, and some published
ones are deprecated in the binary. Always prefer live `--help`:

- `board` really has `create`, `delete`, `list-projects`, `list-sprints`,
  `search`, and a deprecated `get`. An earlier revision of this file removed
  `list-projects` as "not in the official docs" — that was wrong; the
  command exists.
- `field` really has `create`, `update`, `delete`, `restore`, and a
  deprecated `cancel-delete`. An earlier revision claimed there was no
  `field update` — also wrong.
- `filter` is much wider than published: `add-favourite`, `change-owner`,
  `list`, `list-columns`, `reset-columns`, `search`, `update`, `view`, plus
  deprecated `get`/`get-columns`. `filter view` does exist.
- `workitem list-watchers` exists as a **top-level** subcommand; the
  `watcher` subgroup holds `remove` plus a deprecated `list`. An earlier
  revision removed `list-watchers` from the recommended permissions as
  nonexistent — it is real.
- `sprint` = `create`, `delete`, `list-workitems`, `update`, `view` —
  matching what this file already documented, now confirmed live.
- The `confluence` tree (`auth`, `blog`, `page`, `space`) and every
  subcommand under it matched `confluence-acli`'s capability table exactly,
  including `page` being view-only.
- **`workitem attachment` cannot upload.** The group exposes only `list` and
  `delete`; `upload` and `add` are not subcommands (both fall through to the
  group's generic help). Any workflow that needs to put a screenshot, log, or
  video on an issue — filing a defect from a `browser-testing` run, for
  example — must reference the evidence path in the description and attach
  the file through the Jira UI or REST. Say so explicitly rather than
  silently dropping the evidence.
