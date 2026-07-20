# Tool: Atlassian CLI (`acli`)

Atlassian's official command-line tool for Jira (and Confluence/Compass). Read this when a task
needs Jira data (projects, boards, sprints, issues) or when `acli` is missing.

## Preflight & install
- Preflight: `acli --version` (verify it's installed and check the version).
- If missing, install:
  - **Windows (preferred):** `winget install -e --id Atlassian.acli`
    - Or download the binary from https://developer.atlassian.com/cloud/acli/ and add it to PATH.
  - **macOS:** `brew tap atlassian/acli && brew install acli`
  - **Linux (Debian/Ubuntu):** download the `.deb` from the Atlassian CLI releases page and
    `sudo dpkg -i acli_*.deb`
- After install, open a new shell so `acli` is on PATH.
- Upgrade later with the same install command (or `acli update` if supported by your version).

## Auth (never put a token on the command line)
- API token: create one at https://id.atlassian.com/manage-profile/security/api-tokens
- Login (stores credentials in the local config, not passed as flags):
  `acli jira auth login --site "$JIRA_URL" --email "$JIRA_EMAIL"` — prompts for the token, or
  reads it from the `JIRA_API_TOKEN` env var if set.
- Non-interactive / CI: export `JIRA_API_TOKEN` (and `JIRA_EMAIL`, `JIRA_URL`) in the shell —
  never hardcode or print it. Do NOT pass `--token` as a literal flag value in a logged command.
- `acli jira auth status` — verify the current session/site.
- `acli jira auth logout` — clear stored credentials.

## Common usage
- **Config / discovery**
  - `acli jira project list` — list projects
  - `acli jira project view --key <PROJ>` — project details
  - `acli jira board list --project <PROJ>` — boards for a project
  - `acli jira sprint list --board <BOARD_ID>` — sprints on a board (use `--state active` for
    the current sprint)
- **Generic**
  - `acli jira <group> <cmd> --help` — built-in help
  - Add `--json` to most commands for machine-readable output; pipe to a JSON tool to filter.

## Notes
- `acli` is a standalone binary — install via winget/brew/package manager, not `npm install`.
- Treat API tokens and account IDs as sensitive — never print them to logs.
- Issue (work item) read/write mechanics — JQL search, create, link, comment, transition — live
  in the sibling reference `jira-issues-cli.md`.
