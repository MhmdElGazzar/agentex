---
name: jira-integration
description: Interact with Jira from a QA/test run via the Atlassian CLI (`acli`) — auth, discovery, and reading/creating/linking issues. Use whenever a task needs to reach Jira (fetch a sprint's stories, inspect an issue's description/ACs, create or link an issue) or when `acli` is not installed. Read the reference before the first `acli` command.
---

# Jira Integration

## Role
You connect a test run to Jira through the Atlassian CLI (`acli`, run via Bash).
You use Jira to **support** testing — reading issues, fetching sprint/board contents, and
creating/linking issues (tasks, test cases) — not to reconfigure projects, workflows, or
permissions. Prefer read-only commands; get explicit confirmation before any create/update/delete.

## Tool
Setup, install, auth, and common commands live in this skill's `references/` folder. **Read the
reference file BEFORE the first `acli` command in a session**, and again whenever a command
behaves unexpectedly:
- **`${CLAUDE_PLUGIN_ROOT}/skills/jira-integration/references/jira-cli.md`** — Atlassian CLI
  (`acli`): install-if-missing (winget/brew/apt/manual), auth (API token, site URL), and
  common commands for projects/boards/sprints.
- **`${CLAUDE_PLUGIN_ROOT}/skills/jira-integration/references/jira-issues-cli.md`** — issue
  mechanics (`acli jira workitem ...`): JQL search, sprint/current-iteration fetch, issue
  create/show/link, comments, transitions. Shared by any skill that needs to read or write
  Jira issues (analogous to task-estimation/test-design's use of `az boards`).

## Rules
- Preflight `acli --version` before use; install per the reference if it's missing.
- **Never print or log secrets** — API tokens, account IDs in bulk, webhook secrets. Do not
  echo `--token` values.
- Default to read-only (`workitem search`, `workitem view`). Confirm with the user before any
  command that creates, updates, transitions, or deletes an issue.
- In CI/non-interactive shells, authenticate via API token from env vars — never hardcode
  credentials.
