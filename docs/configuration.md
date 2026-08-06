# Configuration

Project data falls into three kinds, each with one home:

| Kind | Examples | Home |
|---|---|---|
| Secrets | PAT, passwords, API tokens | `.env` (**only** these) |
| Project settings | Azure org/project/team, login mode, KB settings | `config/project.json` |
| Environment data | portal URL, DB, API, test users, default OTP | `environments/<env>.json` |

**The JSON files never contain a secret.** A secret-valued field (`password`,
`token`) is either a plain string — acceptable only for team-known throwaway test
credentials like a shared QA password — or `{ "envSecret": "NAME" }` naming the
`.env` variable that holds the real value.

**Legacy projects keep working.** Everything below resolves the new files first and
falls back to the old `.env` variables (`QA_TARGET_URL`, `DB_*`, `AZURE_*`, `KB_*`)
when the files or blocks are missing.

## Walkthrough: setting up your first project

`/init-test` scaffolds all three: `config/project.json`, a sample
`environments/qa.json`, and a secrets-only `.env` (gitignored automatically).
Fill them in:

1. `config/project.json` — your Azure org/project/team (if you use ADO), the KB
   block (if you use `kb:` steps), and `defaultEnvironment`.
2. `environments/qa.json` — your portal URL, test users, defaults, and the `db` /
   `api` blocks if specs use `db:` / `api:` steps. Copy it to `uat.json` / `live.json`
   for more environments.
3. `.env` — the actual secret values.

## `config/project.json`

| Key | Purpose |
|---|---|
| `name` | Project name. |
| `defaultEnvironment` | Environment used when a run doesn't name one. |
| `azure.org` / `.project` / `.team` / `.assignee` | Azure DevOps settings (see [azure-devops.md](./azure-devops.md)); optional extras: `areaPath`, `iterationPath`, `bugTemplateId`, `testPlanId`, `valueArea`, `environment`, `bugCategory`, `apiVersion`. |
| `kb.baseUrl` / `.project` / `.org` | KB Ask settings (see [ask-kb.md](./ask-kb.md)). |
| `login.mode` | `"session"` = reuse saved optimize-login sessions; `"fresh"` = log in every run. |

## `environments/<env>.json`

| Key | Purpose |
|---|---|
| `portalUrl` | The target under test (required). |
| `defaults` | Non-secret static test values: `otp`, `password` (shared test credential), `captcha`, plus any project-specific keys. |
| `users` | Test accounts keyed by a descriptive handle (`valid_user`, `expired_user`, …) that specs refer to ("login as expired_user"). Fields free-form: `phone`, `role`, `idNumber`, `password`, `notes`, … A user without `password` uses `defaults.password`. |
| `db` | `server`, `port`, `name`, `user`, `password` — for cataloged `db:` steps. |
| `api` | `baseUrl`, `token` — for cataloged `api:` steps. |

Selecting the environment at run time: "run on uat" / `env: uat` in a spec →
`environments/uat.json`; otherwise `defaultEnvironment`. Naming an environment
that has no file is an error (available environments are listed) — never a silent
fallback.

## `.env` — secrets only

| Variable | Purpose |
|----------|---------|
| `AZURE_PAT` | Azure DevOps PAT — export as `AZURE_DEVOPS_EXT_PAT` in your shell; never printed or passed. |
| `SQLCMDPASSWORD` | DB password — read natively by `sqlcmd` from the env; never on a command line. |
| `API_TOKEN` | Bearer token for cataloged `api:` requests. |
| `KB_ASK_API_KEY` | KB Ask shared secret (`x-api-key`). |
| *(your own)* | Any variable referenced by an `{ "envSecret": "…" }` field — e.g. `SQLCMDPASSWORD_UAT`, `QA_TESTER_PASSWORD`. |

## Permissions

Plugin manifests can't ship permission rules. Copy the `permissions` block from
[`settings.example.json`](../settings.example.json) into your project's
`.claude/settings.json` (merge with anything already there). This pre-approves the
safe `playwright-cli` (and `az` / `curl` / `sqlcmd`) commands and denies secret
reads / destructive actions.

## Secret-handling rules

- JSON config files and catalog files hold env-var **names**, never secret values.
- Claude may read config keys but must never print or pass secrets.
- DB and PAT secrets are read from the environment (`SQLCMDPASSWORD`,
  `AZURE_DEVOPS_EXT_PAT`), never placed on a command line.
