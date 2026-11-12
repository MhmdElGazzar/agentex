# references/

Shared knowledge that more than one skill reads. A skill keeps its own detail in its own
`skills/<name>/references/` folder; a file moves up here only when several skills need it.
Claude reads these files only when a task needs them, so they don't use up context otherwise.

## What's here

| File | What it covers | Read by |
|------|----------------|---------|
| [tracker/ado-boards.md](./tracker/ado-boards.md) | Azure DevOps boards over REST: what the bundled scripts' JSON means, how to write a spec file, how to explain a board's state. Bug-filing fields live separately in `skills/bug-report-azure/references/azure-devops.md`. | task-estimation, test-design, bug-report-azure, tracker-ops |
| [tracker/jira-boards.md](./tracker/jira-boards.md) | The same for Jira Cloud over REST v3, including what Jira can't do (no test plans, no "Tested By" link). | task-estimation, test-design, bug-report-azure, tracker-ops |

Both describe the tracker layer in [`scripts/lib/tracker/`](../scripts/lib/tracker/): Node
scripts that call the tracker's REST API directly, so no `az` or `acli` CLI is needed.

## Read next

- [docs/azure-devops.md](../docs/azure-devops.md) and [docs/jira.md](../docs/jira.md): the
  same flows from a user's view.
- [skills/README.md](../skills/README.md): which skill does what.

## Don't

- **Don't copy this content into a skill.** Link to the file here, so there is one copy to
  keep correct.
