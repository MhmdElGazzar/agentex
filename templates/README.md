# templates/

The starter files `/init-test` copies into your test project. They become your project's
`config/project.json` and `environments/qc.json`. A file you already have is never
overwritten.

## What's here

| File | Becomes in your project | What it holds |
|------|-------------------------|---------------|
| [config/project.json](./config/project.json) | `config/project.json` | Project settings: `name`, `defaultEnvironment`, the knowledge base (`kb`), Figma (`figma`), the login mode (`login.mode`), and `userFields` / `defaultsFields`, the fields the setup wizard asks for when you add a test user. |
| [environments/qc.json](./environments/qc.json) | `environments/qc.json` | One environment: the app URL (`portalUrl`), default test values (`defaults`), test users (`users`), and the database (`db`) and API (`api`) connections. |

Secrets never sit in these files. A secret field names an entry in your `.env` instead, for
example `"password": { "envSecret": "DEFAULT_PASSWORD" }`.

The sample API and database catalogs that `/init-test` also writes come from the skills
instead: `skills/api-integration/templates/sample_api.json` and
`skills/db-integration/templates/sample_db.json`.

## Read next

- [docs/configuration.md](../docs/configuration.md): every key in both files, and what goes in `.env`.
- [docs/getting-started.md](../docs/getting-started.md): running `/init-test` for the first time.

## Don't

- **Don't change a template's shape without recording the old one.** `/update-agentex` spots
  an untouched sample by comparing it with every shape ever shipped:
  `HISTORICAL_SAMPLE_ENV_SHAPES` and `HISTORICAL_PROJECT_TEMPLATE_SHAPES` in
  [scripts/lib/scaffold.js](../scripts/lib/scaffold.js). Add the previous shape there, or an
  untouched sample gets treated as the user's own data.
- **Don't put a real value in a secret field.** Use `{ "envSecret": "<NAME>" }`.
