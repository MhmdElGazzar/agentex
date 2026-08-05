# Testing

## Script tests

**What:** a small, self-contained `<script>.test.js` next to any script that needs one — no
shared test framework.

**Why:** proves a runner's `PASS`/`FAIL`/`BLOCKED` behavior, and any safety rule enforced in
code, actually hold.

**When:** the skill has a `scripts/` folder (deterministic/security-sensitive work).

**When not:** pure-judgment skills with no script — e.g. `extent-report` (assembles a static
HTML dashboard from data already produced by a run) has nothing deterministic to unit-test.

**How:** spin up a local `http` server (or DB fixture) as a stand-in, spawn the runner as a
child process, assert on its one JSON line + exit code. No mocking framework, no shared
fixtures file.

**Example:** `skills/ask-kb/scripts/ask_kb.test.js` (happy path, config precedence,
`404`/`401`/`429`, retries, secret headers); the smaller `check_url.test.js` built in
[Adding a Skill](./adding-a-skill.md).

**Pros/cons:** + catches regressions in safety rules, no framework overhead — but one more
file to write per script.

**Run it:** `node skills/<name>/scripts/<script>.test.js` — run every `.test.js` you touched
(no single "run all" command yet).

**Minimum coverage:** the success path, each `FAIL` mode, each `BLOCKED` precondition, and any
safety rule enforced in code (catalog-only lookup, DDL ban, param sanitization, secret-header
presence/absence).

Next: [PR Workflow](./pr-workflow.md).
