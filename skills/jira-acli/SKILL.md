---
name: jira-acli
description: Operate Jira Cloud through Atlassian's official command-line interface (`acli jira`), including installation and authentication diagnosis, project and field discovery, JQL searches, work item viewing, creation, editing, assignment, transitions, comments, links, attachments, watchers, archive/delete actions, bulk workflows, structured output, and troubleshooting. Use when the user asks to inspect or manage Jira Cloud from a terminal, automate Jira work with ACLI, compose or run `acli jira` commands, or debug ACLI behavior. Do not use for Jira Server/Data Center or unrelated third-party Jira CLIs.
---

# Jira ACLI

Use Atlassian's official `acli jira` command tree to manage Jira Cloud. Treat "issue" and ACLI's current term "work item" as the same Jira entity unless the user's context says otherwise.

If the requested outcome also reads or changes Confluence, use the **jira-confluence-integration** skill (`${CLAUDE_PLUGIN_ROOT}/skills/jira-confluence-integration/SKILL.md`) to orchestrate both product skills instead of embedding Confluence behavior here.

## Enforce the ACLI-only boundary

Perform every Jira authentication, discovery, read, and mutation in this skill
through Atlassian's official `acli jira` commands. Do not substitute a Jira
MCP connector, direct REST request, `curl`, browser automation, or another Jira
CLI when ACLI is missing a command or returns an error. Stop and report the
ACLI limitation instead of silently changing tools.

Use shell features only to locate the verified ACLI executable, protect
credentials, prepare ACLI input files, and parse or validate ACLI output.
ACLI's own `auth login --web` flow is allowed because ACLI initiates and owns
that authentication workflow.

**One exception, and only when the user explicitly asks for it:** the
`jira-confluence-integration` skill needs
`POST /rest/api/3/issue/{key}/remotelink` to create a Confluence backlink,
which no ACLI command exposes. That call is out of scope for this skill — do
not make it here. Route the request to that skill, which owns the decision and
must state that it is stepping outside the ACLI boundary.

## Know these limits before scoping the work

These are hard gaps in ACLI itself, verified live on 1.3.22. Check them at
**step 1**, not after promising an outcome — each one silently breaks a
common QA workflow:

| You may be asked to… | ACLI can? |
|---|---|
| Attach a screenshot, log, or video to an issue | **No.** `workitem attachment` has only `list` and `delete`; there is no `upload`/`add`. Reference the file path in the description and tell the user to attach via the UI or REST. |
| Set story points, original estimate, or any custom field | **No.** `workitem edit` writes only summary, description, type, labels, assignee (confirmed via `--help` and `--generate-json`). Report the estimate or write it into the description instead. |
| Parent a Bug/Task/Feature to a Story | **No.** `--parent` is Subtask-only; a standard type is rejected with `✗ Error: Please select valid parent issue.` Use `link create --type Relates` as a separate call. |
| Create a Confluence backlink on an issue | **No.** See the exception above. |

State the limitation plainly when you hit one. Never substitute a different
tool, and never report a step as done when the tool could not do it.

## Follow the operating workflow

### 1. Establish intent and scope

Classify the request before running commands:

- Treat searches, lists, views, counts, auth status, and `--help` as read-only.
- Treat creates, edits, assignments, transitions, comments, links, watcher changes, and uploads as mutations.
- Treat deletes and broad JQL/filter-based mutations as high-impact operations.
- Keep the operation within the site, project, work item keys, JQL, or filter explicitly placed in scope.
- Prefer exact work item keys over JQL for targeted changes.

Ask only for information that cannot be discovered safely, such as the intended project or an ambiguous target. Do not ask for credentials.

### 2. Preflight ACLI and authentication

Check the executable and active Jira authentication:

```text
acli --version
acli jira auth status
```

If `acli` is not on `PATH` but the user says it is installed, check explicit,
stable user-local install locations before declaring it absent. On Windows,
`%USERPROFILE%\bin\acli.exe` is one possible location. Use the resolved
absolute executable path and report the `PATH` issue; do not run an unverified
lookalike from a temporary directory.

If `acli` is absent, explain that it is not installed and point to Atlassian's official installation guide in [official-acli.md](references/official-acli.md). Install or upgrade it only when the user asks.

If authentication is missing, prefer the interactive OAuth flow:

```text
acli jira auth login --web
```

Let the user complete browser or terminal prompts. Never request, echo, log,
persist, or place an API token in a command line. If OAuth is unsuitable,
direct the user to enter an API token locally through standard input as
documented by Atlassian.

When the user explicitly supplies an existing environment or secret file,
verify that it is excluded from version control, read only the required
variable names, and pipe the token to ACLI through standard input without
printing its value. Do not copy the secret into a generated payload, skill
file, or report. Treat a token pasted into the conversation as exposed and
advise the user to revoke or rotate it after the operation.

Run login, status, and subsequent live operations in the same user, sandbox,
and elevation context. ACLI authentication state can be scoped to that
execution context; a successful login followed by an unauthorized status in a
different context does not prove that login failed.

When multiple sites or accounts exist, inspect the live auth command tree:

```text
acli jira auth --help
acli jira auth status
```

Confirm the active site before any mutation.

### 3. Discover the live command contract

Run `--help` on the exact command before composing a non-trivial operation:

```text
acli jira --help
acli jira workitem --help
acli jira workitem search --help
```

Use live help as the source of truth for command names, flags, required fields, and output modes. ACLI evolves; use [official-acli.md](references/official-acli.md) for durable patterns and official links, not as a substitute for installed-version help.

Before creating a domain-specific artifact, inspect the target project's
available work item types:

```text
acli jira project view --key '<PROJECT>' --json
```

Do not assume that a project provides `Test`, `Test Case`, or another app-owned
type. If the requested type is unavailable, state the intended mapping, such
as `Task`, before creating anything; do not silently substitute it.

ACLI search output accepts a narrower field set than Jira's complete field
catalog in some versions. If `workitem search` rejects an output field, keep
the JQL unchanged, remove only the unsupported display field, and use
`workitem view <KEY> --fields ...` for exact-item detail when needed.

### 4. Plan sprint-aware derived work

When a request derives test structures, bugs, tasks, or other work items from
Stories, resolve the actual source scope before creating anything:

```text
acli jira board search --project '<PROJECT>' --paginate --json
acli jira board list-sprints --id '<BOARD-ID>' --paginate --json
acli jira sprint list-workitems --board '<BOARD-ID>' --sprint '<SPRINT-ID>' --jql 'issuetype = Story' --paginate --json
```

- Distinguish all project Stories from Stories assigned to the named sprints.
  Report empty sprints and unassigned Stories; do not silently combine them.
- Read each source Story's description and acceptance criteria. Treat a Story
  with missing detail as insufficient for dynamic test design.
- Clarify whether the user wants a fixed count, such as one placeholder per
  Story, or a dynamic count derived from branches, validations, states, and
  acceptance criteria when the distinction changes the output materially.
- Do not present a `Task` or `Subtask` as a native Test Case when the project
  does not expose a Test Case work item type.
- Prefer `Subtask` with the immutable parent Story ID when the test structure
  must be a child of the Story. Use `Task` only for an independent structure.
  The generated create template limits `parentIssueId` to subtasks.
- Keep a requested `Bug` as the native top-level Bug type and use a stable
  source label plus an ACLI work-item link, such as `Relates`, when a formal
  relationship is required. Do not pre-create Bug placeholders unless the
  user explicitly requests them because they can distort defect metrics.
- Inspect live create, edit, and sprint help before promising sprint
  placement. If the installed ACLI exposes no supported way to assign the
  created top-level work item to a sprint, report that limitation. Do not
  guess a Sprint custom-field payload or switch tools.

### 5. Preview the target set

Read before writing. For a JQL- or filter-scoped mutation, first obtain the count and a representative or complete key list:

```text
acli jira workitem search --jql '<JQL>' --count
acli jira workitem search --jql '<JQL>' --fields 'key,summary,status,assignee' --limit 20 --json
```

Use `--paginate` only when the complete result set is needed. State when output is sampled or truncated.

Before a bulk change, identify:

- Active Jira site
- Exact selector: keys, JQL, or filter ID
- Number of affected work items
- Requested field, transition, comment, or other change

If the user has explicitly authorized that exact bulk scope and change, proceed after preview. Otherwise, show the preview and request confirmation. Never broaden JQL to make it "work" without telling the user.

For repeatable create workflows, query for an existing stable marker before
creating. Prefer deterministic labels or another declared source identifier
over title-only matching. Verify that each source object has the expected
number and type of generated work items, and treat duplicates as a conflict
rather than creating another set.

### 6. Execute safely

Follow these rules:

- Run read-only operations directly.
- Execute a requested targeted mutation after validating the site and target.
- Require explicit authorization that names the destructive action and target before deleting work items, projects, comments, attachments, fields, filters, or links.
- Do not add `--yes` until the target set has been previewed and authorized. Prefer ACLI's own prompt when practical.
- Do not use `--ignore-errors` unless partial completion is acceptable to the user; otherwise stop on the first failure.
- Generate ACLI's current JSON template before preparing create/edit/bulk payloads with `--generate-json`.
- Generate single-create and bulk-create templates separately. Their property
  names and root shapes can differ; never reuse the single-create schema for
  `create-bulk`.
- Validate generated CSV or JSON input before executing a bulk create.
- Keep run-specific CSV or JSON payloads in the task workspace or a temporary
  directory, not in the installed skill directory, and remove them after the
  verified run unless the user requests the artifact.
- Use `--description-file`, `--body-file`, or `--from-json` for long, multiline, rich-text, or quote-heavy content.
- Preserve user text exactly unless asked to edit it. Do not silently convert plain text to Atlassian Document Format.
- Treat an uncertain create, clone, comment, or upload result as unknown, not failed. Read for the intended result before retrying so a transient response does not create a duplicate.

Use shell-native quoting. In PowerShell, prefer single-quoted JQL and double embedded single quotes. In POSIX shells, prefer single-quoted JQL and escape embedded single quotes safely. Never interpolate untrusted text into a shell command without quoting it.

### 7. Verify and report

Check the exit status and ACLI output. After a mutation, read back the affected work item or rerun a narrow search to verify the intended state.

Treat an aggregate bulk-success message as transport confirmation, not full
semantic verification. Search back by the stable marker and compare the
expected count, source identifiers, issue types, summaries, and any fields
that were intentionally omitted, such as an empty description.

For an exact-key delete, first view the item to establish its identity and the
caller's access. After deletion, require the JSON result to name the same key
with a successful status, then run `workitem view <KEY>` and expect a not-found
or no-permission response. Treat that response as deletion evidence only when
the pre-delete view and successful delete result are both present. Do not use
`key = <DELETED-KEY>` JQL as the primary verification because Jira can reject
the query when the key no longer exists instead of returning a zero count.

Report:

- Active site when relevant
- Created or affected work item keys
- Source Story keys, selected sprint scope, and fixed or dynamic generation
  rule for derived-work workflows
- Chosen type mapping, parent or link relationship, and verified sprint
  membership when the outcome depends on them
- Verified result
- Skipped or failed items and their errors
- Any partial completion caused by permissions, validation, or workflow restrictions

Do not claim success from command construction alone.

## Use common command families

Load [official-acli.md](references/official-acli.md) when selecting commands or troubleshooting. Typical Jira command families include:

- `auth` for login, logout, status, and account/site selection
- `project`, `board`, `sprint`, `field`, `filter`, and `dashboard` for discovery and management
- `workitem search|view|create|create-bulk|clone|edit|assign|transition`
- `workitem comment`, `link`, `attachment`, and `watcher` (subgroups), plus
  the top-level `workitem list-watchers` — note that `watcher list` exists
  but is deprecated in favour of `list-watchers`
- `workitem archive|unarchive|delete`

Inspect the relevant family's `--help` rather than guessing a subcommand.

`acli jira workitem link` manages links between Jira work items. Do not use it
for a Confluence backlink. Route a cross-product request through the
**jira-confluence-integration** skill; do not call a remote-link REST resource
from this Jira ACLI skill.

## Handle failures

On an error:

1. Capture the command's exit code and sanitized error text.
2. Recheck `acli --version`, `acli jira auth status`, the active site, and exact command help.
3. Distinguish syntax, authentication, authorization, field configuration, invalid JQL, and unavailable workflow transitions.
4. Retry only after correcting the identified cause; do not loop blindly.
5. On HTTP `429` or a transient `5xx` with `Retry-After`, retry only an idempotent operation, honor the server delay, apply bounded exponential backoff with jitter, and cap attempts. Do not automatically replay a create or other operation whose outcome is unknown.
6. Consult Atlassian's changelog for current authentication or compatibility notices.

Redact tokens, authorization headers, cookies, and sensitive issue content from diagnostics.
