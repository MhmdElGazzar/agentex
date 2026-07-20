# Tool: Atlassian CLI issue commands (`acli jira workitem`)

Issue (work item) mechanics for the Atlassian CLI. Read this before the first
`acli jira workitem` command in a session, or when one behaves unexpectedly. For installing/
authenticating `acli` itself, see the sibling reference `jira-cli.md`.

## Preflight
- `acli jira auth status` — confirm you're authenticated against the right site.

## Current sprint (fetch dynamically — never hardcode)
```bash
SPRINT_ID=$(acli jira sprint list --board "$JIRA_BOARD_ID" --state active --json \
  | jq -r '.[0].id')
echo "$SPRINT_ID"
```

## Fetch sprint issues (JQL)
```bash
acli jira workitem search --jql "project = $JIRA_PROJECT AND sprint = $SPRINT_ID AND issuetype = Story ORDER BY key" \
  --json
```
> JQL is the Jira equivalent of ADO's WIQL — filter by `project`, `sprint`, `issuetype`,
> `status`, etc.

## Inspect an issue
```bash
acli jira workitem view --key <PROJ-123> --json     # description + ACs to analyze
```

## Check for existing linked issues (before creating)
```bash
acli jira workitem view --key <PROJ-123> --json | jq '.fields.issuelinks'
```
If linked sub-tasks/issues already exist, tell the user and ask whether to skip or add more.

## Create an issue + link to parent
```bash
NEW_KEY=$(acli jira workitem create --project "$JIRA_PROJECT" --type "Task" \
  --summary "[Testing] Test Creation" \
  --assignee "$JIRA_ASSIGNEE" \
  --json | jq -r '.key')

# Link to parent (subtask) or relate two issues
acli jira workitem link --key "$NEW_KEY" --link-type "relates to" --target-key <PROJ-123>
```
> For a true parent/child (sub-task) relationship, create with `--type "Sub-task" --parent <PROJ-123>`
> instead of a generic link.

## Comment
```bash
acli jira workitem comment add --key <PROJ-123> --body "Verified in build 1.4.2"
```

## Transition (status change)
```bash
acli jira workitem transition list --key <PROJ-123>      # see available transitions
acli jira workitem transition --key <PROJ-123> --status "In Progress"
```

## Delete (destructive — confirm first)
```bash
acli jira workitem delete --key <PROJ-123>
```

## Notes
- Add `--json` to most commands for machine-readable output; pipe to `jq` to filter/extract.
- Mandatory fields at a glance for a new issue: `--project`, `--type`, `--summary`,
  `--assignee` (if the project requires one), plus `--parent` for sub-tasks.
- Issue keys (`PROJ-123`) are the Jira equivalent of ADO work-item IDs.
