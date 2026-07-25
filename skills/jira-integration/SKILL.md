---
name: jira-integration
description: Interact with Jira from a QA/test run via the Atlassian CLI (`acli`) — login/auth, verify connectivity, read projects and issues, build linked issue hierarchies (Epic → Story/Task/Bug → Subtask), file defects, and manage boards & sprints. Use whenever a task needs to reach Jira (check the connection, look up or search issues, file a bug from a failed test, create an epic/story/subtask, plan a sprint) or when `acli` is not installed. Read the reference before the first `acli` command.
---

# Jira Integration

## Role
You connect a test run to Jira through the Atlassian CLI (`acli`, run via Bash). You use Jira
to **support** testing — verifying connectivity, reading projects/issues, building linked issue
hierarchies, filing or transitioning defects, and organizing work into sprints — not to
administer the site. Prefer read-only commands; get explicit confirmation before any write
(create / edit / transition / comment / delete, or any board/sprint change).

## Tool
Setup, install, auth, and all commands live in this skill's `references/` folder. **Read the
reference file BEFORE the first `acli` command in a session**, and again whenever a command
behaves unexpectedly:
- **`${CLAUDE_PLUGIN_ROOT}/skills/jira-integration/references/atlassian-cli.md`** — Atlassian CLI
  (`acli`) for **Jira**: install-if-missing (direct binary download per the official Windows guide),
  auth (browser + API token over stdin), reading projects/issues (+ the `--json` field-shape
  gotcha), writing issues, building a linked hierarchy with `--parent`, and managing boards &
  sprints (including the REST fallback for adding existing issues to a sprint).
- **`${CLAUDE_PLUGIN_ROOT}/skills/jira-integration/references/confluence-cli.md`** — the **same
  `acli` binary** for **Confluence** (`acli confluence`): spaces, pages, blogs. Confluence auth is
  separate from Jira and needs a Confluence license on the site (fails as BLOCKED otherwise);
  pages are read-only in acli (author via the `/wiki/rest/api` REST fallback).
- **`${CLAUDE_PLUGIN_ROOT}/skills/jira-integration/references/admin-cli.md`** — ⚠️ **opt-in, high
  blast radius.** Org-admin user management (`acli admin user` activate/deactivate/**delete** real
  accounts). Separate org API key (not the Jira token), every command destructive, confirm-per-user.
  **Out of scope for automated/CI test runs** — read this ONLY when the user explicitly asks for
  user-management automation.

## Verify the connection first
Before any read/write Jira step, confirm auth is working and do not proceed on failure:

```bash
acli --help            # installed?  (install per the reference if missing)
acli jira auth status  # PASS = an authenticated account/site is shown
```

If not authenticated, log in with the API token over stdin (credentials from `.env`, gitignored):

```bash
echo "$JIRA_API_TOKEN" | acli jira auth login --site "$JIRA_SITE" --email "$JIRA_EMAIL" --token
```

## Building hierarchies & sprints
- Jira's hierarchy is fixed: **Epic → (Story | Task | Feature | Bug) → Subtask**. Create top-down
  and pass each child `--parent <key-from-the-previous-create>`. A **Subtask must parent to a
  standard issue** (Story/Task/Bug), never directly to an Epic. Verify with `search --jql "parent = <KEY>"`.
- Sprints live on a **board** — get the board id via `acli jira board search`, then
  `acli jira sprint create --board <id> --name "…"`. acli has no "add to sprint" command; add
  existing issues via the Agile REST API (see the reference). Subtasks inherit their parent's sprint.

## Rules
- Preflight `acli --help` before use; install per the reference if it's missing.
- **Never print or log secrets** — API tokens, full emails, auth headers. Keep values in `.env`
  (`JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN`) and pass the token over stdin (acli) or via
  basic-auth env interpolation (curl) — never echo it or place it on the command line.
- Default to read-only (`workitem view`, `workitem search`, `project list`). **Confirm with the
  user before any write** — create, edit, transition, comment, delete, or any board/sprint change —
  and state exactly what will be created/changed first (writes hit live Jira and are not test data).
- `project list` requires a flag (`--limit`/`--recent`/`--paginate`); prefer table output over
  `--json` for reliable field values (acli nests JSON fields under `versionedRepresentations`).
- In CI/non-interactive shells, authenticate from env vars / a secret store — never hardcode.
