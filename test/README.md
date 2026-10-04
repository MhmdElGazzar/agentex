# test/ — your test specs

AgenTeX supports Claude Code, OpenAI Codex, and GitHub Copilot Agent. This spec format is
shared by all three; Azure DevOps is optional for browser testing. See the
[runtime guides](../docs/README.md) for installation and invocation.

This is where you keep the test specifications AgenTeX runs. Nothing here is application
code — each file is a plain-language description of what to test.

## How specs are organized

- **One spec = one file.** In **parallel** mode AgenTeX assigns one isolated browser
  session per file, so keep each file to a single independent feature/flow.
- **Group related specs into a suite folder** — e.g. `test/suite1/`. A suite is just a
  folder of spec files you want to run together.
- **Keep a stateful flow inside one file.** If steps depend on each other (search →
  filter → clear), put them in the same file and mark them as a stateful chain so they run
  in order in one session.

## What a good spec contains

See [`suite1/`](./suite1/) for ready-to-adapt examples. Each spec should have:

- **Target** — the URL/page under test (edit to your app).
- **Acceptance criteria** — what "correct" means, including "no console errors / failed
  network calls."
- **Scenarios** — numbered: happy path, edge cases, and negative cases.
- **Notes** — anything special (stateful order, disposable data to use).

## API & DB steps in specs

Scenario steps can reach beyond the browser using the **`integration/` catalog** at the
project root (scaffolded by `/init-test` with samples):

```
api: sample-api.get-todo(id=1) → expect HTTP 200 and title present
db:  sample-db.todo-by-title(title=qa-test-item) → expect 1 row
```

- Each `<name>.<entry>(params)` must be **defined first** in `integration/*_api.json` /
  `*_db.json` — the agent only executes cataloged entries, never its own SQL/HTTP.
- Secrets are never in the catalog or config files — they name env vars
  (`{ "envSecret": "…" }` / `tokenEnv`); values live in `.env`/your shell. Connection
  details live in `environments/<env>.json`.

## API / DB-only specs

A spec with no browser steps declares its drivers in the header, before the first `##`:

```
Drivers: api, db
```

It then runs with no browser: no `Target:` line and no `portalUrl` needed, locally or in
CI. Without a `Drivers:` line a spec is a browser spec plus the `api:` / `db:` / `kb:` /
`ui-check:` steps it uses (`ui-check:` always needs the browser).

## Rules the agent already follows

- Logging in is part of the job: a step like "login as expired_user" uses that configured
  user from `environments/<env>.json`. Steps with persistent effects need explicit scope
  and approval; use disposable test data, never real personal data. A step needing an
  undefined user is BLOCKED, never improvised.
- Never reads or prints secrets, never modifies your application source.
- Captures a screenshot on every scenario (pass and fail); console errors and failed
  requests count as defects even when the UI looks fine.

## Running

- Claude Code: `/execute-test <target-or-scope>` for sequential execution; explicitly
  ask for a parallel regression when you want one.
- Codex or GitHub Copilot Agent: ask to run a named saved AgenTeX spec, or explicitly
  request a bounded parallel run over named saved specs. Select the target/environment.
- Every run writes reports and evidence under `executions/execu_<timestamp>/`.

## Azure DevOps (optional)

AgenTeX can also work your ADO backlog — fill the `azure` block in `config/project.json` first
(org/project/team/assignee); legacy `AZURE_*` keys in `.env` still work as a fallback. The PAT
always stays in `.env` as `AZURE_PAT`, read by the bundled scripts themselves:

- Design test coverage from a numeric Story ID as read-only advice; creating linked Test
  Cases requires a separate exact-plan approval. Claude's command is `/design-test <ids>`.
- Estimate QA effort as read-only advice; creating `[Testing]` tasks requires a separate
  exact-plan approval. Claude's command is `/estimate-story [ids]`.
