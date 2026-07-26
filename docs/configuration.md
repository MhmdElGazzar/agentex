# Configuration

Copy [`.env.example`](../.env.example) to `.env` (gitignored — never commit secrets) and fill in
only what your flows use. Catalog files reference these **by name**; values live here or in your shell.

```bash
cp .env.example .env
```

## Environment variables

### Target under test

| Variable | Purpose |
|----------|---------|
| `QA_TARGET_URL` | Default target under test. |

### Integrations (`integration/` catalog)

| Variable | Purpose |
|----------|---------|
| `API_BASE_URL` | Base URL for cataloged `api:` requests. |
| `API_TOKEN` | Auth token for cataloged API requests. |
| `DB_SERVER` | SQL Server host for cataloged `db:` queries. |
| `DB_PORT` | DB port — leave empty for the default `1433`. |
| `DB_NAME` | Database name. |
| `DB_USER` | Database user. |
| `SQLCMDPASSWORD` | DB password — read natively by `sqlcmd` from the env; **never** passed on the command line. Export in your shell. |

### Azure DevOps

| Variable | Purpose |
|----------|---------|
| `AZURE_URL` | Org URL, e.g. `https://dev.azure.com/your-org`. |
| `AZURE_PROJECT` | Project name. |
| `AZURE_TEAM` | Team name. |
| `AZURE_ASSIGNEE` | Default assignee for created tasks. |
| `AZURE_DEVOPS_EXT_PAT` | PAT for non-interactive auth — export in your shell; the agent never prints or passes it. |

### KB Ask API

| Variable | Purpose |
|----------|---------|
| `KB_ASK_BASE_URL` | KB Ask API host (host only). |
| `KB_PROJECT` | Default project id; a `kb:<project>:` step overrides it. |
| `KB_ASK_API_KEY` | Shared secret sent as `x-api-key` (required when the server has it set). |

## Permissions

Plugin manifests can't ship permission rules. Copy the `permissions` block from
[`settings.example.json`](../settings.example.json) into your project's `.claude/settings.json`
(merge with anything already there). This pre-approves the safe `playwright-cli` (and `az` / `curl` /
`sqlcmd`) commands and denies secret reads / destructive actions.

## Secret-handling rules

- Catalog files (`integration/*.json`) hold only env-var **names**, never values.
- The agent may read config keys but must never print or pass secrets.
- DB and PAT secrets are read from the environment (`SQLCMDPASSWORD`, `AZURE_DEVOPS_EXT_PAT`), never
  placed on a command line.
