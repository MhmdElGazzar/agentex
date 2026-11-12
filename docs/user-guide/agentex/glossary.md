# Glossary

← [20. Troubleshooting and FAQ](./20-troubleshooting-and-faq.md) · [Contents](./README.md) · Next: [Cheat sheet →](./cheat-sheet.md)

| Term | Meaning |
|------|---------|
| **Acceptance criteria (ACs)** | The conditions a user story must meet. `/design-test` turns them into test cases. |
| **BLOCKED** | Could not be judged because something is missing or the environment failed. Not a product defect. |
| **Catalog** | `integration/*_api.json` / `*_db.json`: the only API calls and queries tests may run. |
| **Consolidated approval** | The single screen showing every tracker write before anything is written. |
| **Driver** | What executes a step: browser, api, db, kb, ui-check, mobile. |
| **Environment** | `environments/<env>.json`: URL, users and connections for qc / uat / live. |
| **envSecret** | A reference by name to a secret in `.env`; the JSON never holds the value. |
| **Evidence** | Screenshots and logs saved for every scenario, pass or fail. |
| **FLAKY** | A result that failed and then passed on retry. Reported under "Unstable results", never as a bug. |
| **Landmark** | An element only one screen shows (for example only a logged-in page), used as proof you are on it. |
| **Ledger** | The exact list of tracker writes done / not done after a partial failure. |
| **`<plugin-root>`** | The folder where AgenTeX is installed ([3.8](./03-installation.md#38-running-bundled-scripts-yourself-the-plugin-path)). |
| **Scenario** | One numbered test inside a spec (happy path, negative case…). |
| **Sequential / Parallel** | A human-in-the-loop run with pauses / an autonomous run with one subagent per spec file. |
| **Skill** | A packaged AgenTeX ability (a folder with a `SKILL.md`). Commands and requests run skills. |
| **Spec** | A markdown file describing one feature or flow to test: target, acceptance criteria, scenarios. |
| **Stateful chain** | Scenarios that depend on each other and must run in order, in one session. |
| **Subagent** | An independent Claude worker: `qa-executor`, `mobile-qa-executor`, `api-executor`. |
| **Suite** | A folder of specs run together, for example `test/suite1/`. |
| **Suite file (API)** | `*_suite.json`: concrete parameters and expected results for catalog entries. |
| **Verdict** | The CI result: PASS (0), FAIL (1) or BLOCKED (2), plus `verdict.json`. |
