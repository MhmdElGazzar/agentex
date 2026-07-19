# test/ — your test specs

This is where you keep the test specifications AgenTeX runs. Nothing here is application
code — each file is a plain-language description of what to test.

## How specs are organized

- **One spec = one file.** In **parallel** mode AgenTeX dispatches one `qa-executor`
  subagent (its own isolated browser session) **per file**, so keep each file to a single
  independent feature/flow.
- **Group related specs into a suite folder** — e.g. `test/suite1/`. A suite is just a
  folder of spec files you want to run together.
- **`test/explore_<ProjectName>/` suites are auto-generated** by the `exploratory-testing`
  skill (`/explore-test <url>`) from triaged exploration findings — same file shape as any
  hand-written suite below, so nothing special is needed to run or edit them.
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
- Secrets are never in the catalog — files name env vars; values live in `.env`/your shell.

## Rules the agent already follows

- Never uses real personal data or completes real signup/login/checkout — use disposable
  values like `qa.tester@example.com`.
- Never reads or prints secrets, never modifies your application source.
- Captures a screenshot on every scenario (pass and fail); console errors and failed
  requests count as defects even when the UI looks fine.

## Running

- Sequential (human-in-the-loop, default): `/execute-test https://your-app.example`
- Parallel (autonomous, one session per file): ask for a "parallel regression from the
  specs in `test/suite1/`".

## Azure DevOps (optional)

AgenTeX can also work your ADO backlog — fill the `AZURE_*` keys in `.env` first:

- `/design-test <story-ids>` — analyze a story's ACs and create linked test cases
  (project conventions live in `.agentex/test-template.md`, scaffolded on first run).
- `/estimate-story [ids]` — estimate QA effort and create the 5 `[Testing]` tasks per story.
