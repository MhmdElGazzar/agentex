# Project config files — split configuration out of `.env`

**Date:** 2026-08-06
**Status:** Approved (design), pending implementation plan

## Problem

Today an AgenTeX project keeps *everything* in `.env`: real secrets (`AZURE_PAT`,
`SQLCMDPASSWORD`, `API_TOKEN`) mixed with plain project configuration
(`AZURE_PROJECT`, `QA_TARGET_URL`, `DB_SERVER`, `DB_NAME`) and environment facts.
Consequences:

- Switching the environment under test (QA → UAT → Live) means hand-editing `.env`,
  and it is easy to end up testing one environment's portal against another
  environment's database.
- There is no place for structured test data the upcoming "New Project" wizard
  collects: per-environment portal URLs with defaults (OTP, captcha), test users
  (name, phone, role), login setup.
- `.env` cannot express structure (lists of users, per-environment blocks).

## Principle

Project data falls into three kinds, each with one home:

| Kind | Examples | Home |
|---|---|---|
| Secrets | PAT, passwords, API tokens | `.env` (and **only** these) |
| Project settings | Azure org/project/team, login mode, KB project | `config/project.json` |
| Environment data | portal URL, DB, API, test users, default OTP | `environments/<env>.json` |

**Golden rule: the new JSON files never contain a secret.** A secret-valued field
holds a reference object naming the `.env` variable —
`"password": { "envSecret": "SQLCMDPASSWORD" }` — never the value itself; the same
spirit as the `integration/` catalog's `*Env` keys.

## Project layout

```
workspace/<project>/
├── .env                      # secrets only
├── config/
│   └── project.json          # project identity + cross-environment settings
├── environments/
│   ├── qa.json
│   ├── uat.json
│   └── live.json             # one file per real environment of the project
├── integration/              # unchanged (allowed queries/requests catalog)
├── test/                     # unchanged (specs)
└── executions/               # unchanged (run artifacts)
```

## `config/project.json`

Identity and settings shared by all environments:

```json
{
  "name": "domestic",
  "defaultEnvironment": "qa",
  "azure": {
    "org": "https://dev.azure.com/tameeni",
    "project": "Domestic",
    "team": "QC",
    "assignee": "qa.engineer@example.com",
    "areaPath": "",
    "iterationPath": "",
    "bugTemplateId": null,
    "testPlanId": null
  },
  "kb": {
    "baseUrl": "http://localhost:3000",
    "project": "acme-store",
    "org": ""
  },
  "login": { "mode": "session" }
}
```

- Absorbs every non-secret `AZURE_*` variable (the PAT stays in `.env` as
  `AZURE_PAT`), and the non-secret KB variables (`KB_ASK_BASE_URL`, `KB_PROJECT`,
  `KB_ORG`; `KB_ASK_API_KEY` stays in `.env`).
- `defaultEnvironment` names the environment a run targets when none is specified.
- All blocks are optional: a project with no Azure integration simply has no
  `azure` block.
- `login.mode` values: `"session"` (reuse a saved optimize-login session,
  re-login when expired) or `"fresh"` (log in every run).

## `environments/<env>.json`

An environment is one self-consistent unit — portal, DB, API, users move together:

```json
{
  "portalUrl": "https://uat.tameeni.com",
  "defaults": {
    "otp": "0000",
    "password": "Test@1234",
    "captcha": "disabled"
  },
  "users": {
    "valid_user": {
      "phone": "0550000001",
      "role": "customer",
      "idNumber": "1234567890",
      "password": { "envSecret": "QA_TESTER_PASSWORD" },
      "notes": "sponsor with active contract policies"
    },
    "expired_user": {
      "phone": "0550000002",
      "notes": "subscription expired — for negative login scenarios"
    }
  },
  "db": {
    "server": "uat-db02.tis.local",
    "port": 1434,
    "name": "TameeniDomesticQC",
    "user": "eslam.fawzy",
    "password": { "envSecret": "SQLCMDPASSWORD" }
  },
  "api": {
    "baseUrl": "https://uat-api.tameeni.com",
    "token": { "envSecret": "API_TOKEN" }
  }
}
```

- Every field except `portalUrl` is optional. An environment without DB checks has
  no `db` block (this encodes the wizard's "need API? / need DB?" answers).
- `defaults` are non-secret static test-environment values (fixed OTP, shared
  default password, captcha bypass flag) written as plain values. Free-form: keys
  beyond `otp`/`password`/`captcha` are allowed and passed through to the executor
  as-is.
- **Secret references:** a secret-valued field (`password`, `token`) takes one of
  two shapes. A plain string is the literal value — acceptable only for team-known
  throwaway test credentials (like a shared QA default password). An object
  `{ "envSecret": "NAME" }` names the `.env` variable holding the real value. Two
  environments with different DB passwords simply name different variables
  (`SQLCMDPASSWORD_UAT`, `SQLCMDPASSWORD_LIVE`); omit the field entirely when no
  secret is needed.
- `defaults.password` is the environment's shared test credential: a user without
  their own `password` logs in with it. If the default credential is actually
  sensitive, write it as `{ "envSecret": "..." }` instead of a plain value.
- `users` is an object keyed by a descriptive handle (`valid_user`, `expired_user`,
  `no_policy_user`, …). The key is how test specs and skills refer to the user
  ("login as expired_user"). Each user's fields are free-form (`phone`, `role`,
  `idNumber`, `notes`, project-specific extras) and passed through to the executor.

## Environment selection at run time

1. Explicit request ("run on uat", or `env: uat` in a spec) → `environments/uat.json`.
2. Otherwise → `defaultEnvironment` from `config/project.json`.
3. The chosen environment name is recorded in the execution report.
4. Naming an environment that has no file is an error (fail fast, list available
   environments) — never silently fall back to another environment.

## Skill changes (all with `.env` fallback)

Resolution order everywhere: **new files first, `.env` fallback second** — so
existing projects keep working untouched.

| Skill / command | Change |
|---|---|
| `browser-testing` / `execute-test` | Target from active environment's `portalUrl` (was `QA_TARGET_URL`); expose `defaults` and `users` to executors |
| `db-integration` | Connection from active environment's `db` block (was `DB_*` in `.env`); catalog `connection.*Env` keys remain the fallback |
| `api-integration` | Base URL/token from active environment's `api` block (was `API_BASE_URL`/`API_TOKEN`) |
| `task-estimation` / `test-design` / `bug-report-azure` | Azure settings from `config/project.json` `azure` block (was `AZURE_*`) |
| `ask-kb` | KB settings from `config/project.json` `kb` block (was `KB_*`) |
| `optimize-login` | Users from active environment; mode from `project.json` `login.mode`; saved sessions keyed per environment |
| `init-test` (`scripts/init.js`) | Scaffold the new layout: `config/project.json`, sample `environments/qa.json`, secrets-only `.env` |

Documentation updated in the same change: `docs/configuration.md` (rewrite around
the three-kinds principle), `.env.example` (secrets only), `docs/getting-started.md`
and skill `SKILL.md`s where they mention moved variables.

## New `.env` (secrets only)

```
AZURE_PAT=
SQLCMDPASSWORD=
API_TOKEN=
KB_ASK_API_KEY=
QA_TESTER_PASSWORD=          # referenced from JSON via { "envSecret": ... }
```

## Out of scope

- **The New Project wizard** (sandbox dashboard screens: Azure org/project
  dropdowns, PAT entry, pull/push test cases from/to Azure DevOps, first quick
  run). Separate project. These files are its **contract**: the wizard's final
  step writes `config/project.json`, `environments/*.json`, and `.env` — no skill
  changes will be needed when it lands, and until it lands the files are simply
  written by hand.
- **Automatic migration of existing projects.** The `.env` fallback keeps old
  projects working; converting one by hand takes minutes and there are only a
  handful. Revisit only if a real need appears.
