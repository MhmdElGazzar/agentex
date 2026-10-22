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
[Adding a Skill](./adding-a-skill.md). For a script whose real dependency is optional and
resolved from the *caller's* project (see
[Adding a Capability](./adding-a-capability.md#checklist) on that pattern),
`skills/mobile-testing/scripts/appium_client.test.js` shows the shape: write a minimal fake
module into a temp `node_modules/` so the `BLOCKED`/argument-validation paths are provable
without the real dependency, a live server, or a device.

**Pros/cons:** + catches regressions in safety rules, no framework overhead — but one more
file to write per script.

**Run it:** `node skills/<name>/scripts/<script>.test.js` for one file; the whole suite with

```
node scripts/run-tests.js                 # every tracked *.test.js, in parallel (CPU count)
node scripts/run-tests.js --filter wizard # only paths containing "wizard"
node scripts/run-tests.js --serial        # one at a time (or --concurrency <n>)
```

It runs each file as `node <file>` from the repo root, prints one line per failure plus
totals and wall time on stderr, and one JSON line on stdout
(`{ok,total,passed,failed:[{file,exit,tail}],durationMs}`); exit 0 all pass · 1 any fail ·
2 usage/IO error. Only **tracked** files are found — `git add` a new test first. Tests run
side by side, so a test must not hold a fixed port or a fixed temp path (take port `0`,
`fs.mkdtempSync`); one that truly cannot goes in the runner's documented `SERIAL_ONLY` list.

To run only the tests a change can reach, see
[Running only what a change affects](#running-only-what-a-change-affects).

**Minimum coverage:** the success path, each `FAIL` mode, each `BLOCKED` precondition, and any
safety rule enforced in code (catalog-only lookup, DDL ban, param sanitization, secret-header
presence/absence).

## Running only what a change affects

**What:** `scripts/dev/affected.js` reads what changed since `main` (commits, uncommitted
edits and untracked files) and lists the script tests and evals that change can affect.

```
node scripts/dev/affected.js            # list what to run
node scripts/dev/affected.js --run      # run the selected script tests
node scripts/dev/affected.js --all --run   # run every script test (releases)
```

Also `--base <ref>` (default `main`), `--files a,b` (skip the git lookup) and `--json`.

**How it picks:**

- **Script tests** — from each test's dependency graph: what it `require()`s, every path it
  builds from `__dirname` (spawned runners, templates, fixture folders), and transitively what
  those files depend on. A changed code or data file that no test reaches selects **every**
  script test, so a missed edge costs time, never coverage.
- **Evals** — from `evals/coverage.json`, which maps each case to the paths it exercises. A
  changed `.js` file also counts for every file that requires or spawns it. A changed
  `description` in any `skills/*/SKILL.md` or `commands/*.md` selects every `trigger-*` and
  `negative-*` case, since triggering depends on all descriptions together. Evals are only
  listed, never started — each `claude plugin eval` run is slow and paid.
- **No impact** — anything outside `skills/`, `scripts/`, `commands/`, `agents/`,
  `templates/`, `hosts/`, `references/`, `evals/`, `test/` and `.claude-plugin/` (docs,
  CHANGELOG).

**When you add an eval case:** add its entry to `evals/coverage.json`;
`scripts/dev/affected.test.js` fails until you do.

**Releases still run everything:** `--all --run` for the script tests, and the full eval suite.

Next: [PR Workflow](./pr-workflow.md).
