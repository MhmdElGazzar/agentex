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
node scripts/run-tests.js --require-e2e   # browser tests may not skip (see "Browser tests")
```

It runs each file as `node <file>` from the repo root, prints one line per failure and per skip
plus totals (passed, failed, skipped) and wall time on stderr, and one JSON line on stdout
(`{ok,total,passed,failed:[{file,exit,tail}],skipped:[{file,reason}],durationMs}`); exit 0 all
pass · 1 any fail · 2 usage/IO error. Only **tracked** files are found — `git add` a new test first. Tests run
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
node scripts/dev/affected.js --run      # run the selected script tests, in parallel
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
  `negative-*` case, since triggering depends on all descriptions together. A coverage pattern
  that names a **folder** (no file extension, such as `skills/bug-report-azure`) covers the
  prompts, references and data below it but never its scripts: a changed script, directly or
  through a file that requires it, selects a case only when a pattern names that script or a file
  that requires it (a `*.test.js` still counts like any other file). Evals are only listed, never
  started — each `claude plugin eval` run is slow and paid.
- **No impact** — anything outside `skills/`, `scripts/`, `commands/`, `agents/`,
  `templates/`, `hosts/`, `references/`, `evals/`, `test/` and `.claude-plugin/` (docs,
  CHANGELOG).

**When you add an eval case:** add its entry to `evals/coverage.json`;
`scripts/dev/affected.test.js` fails until you do.

**Releases still run everything:** `node scripts/run-tests.js` for the script tests, and the full
eval suite. `--run` reuses that runner's parallel pool, and also picks up untracked new tests.

## Browser tests (`*.e2e.test.js`)

**What:** a test that drives a real headless Chromium on `127.0.0.1` against a fixture app or
against the plugin's own local pages (the studio, the setup wizard). It lives next to the code
it covers and is named `<script>.e2e.test.js`, so `git ls-files '*.test.js'` already finds it:
no separate runner, no new glob. Shared code (harness, fixture app) lives in `scripts/dev/e2e/`,
which is maintainer tooling and never shipped.

**Why:** a unit test runs a fake the repo wrote. A browser test proves what only the real thing
shows: the real `@playwright/cli` and its error wording, an HttpOnly cookie round trip, the HTML
tokenizer on `</script>`, computed CSS.

**Skip protocol.** The machine running the suite may not have Playwright or Chromium, and a
missing browser is not a defect. So an `*.e2e.test.js` file that exits **77** and prints a line
`SKIP: <reason>` counts as **skipped**:

- `run-tests.js` lists it in the JSON as `skipped:[{file,reason}]` (`passed` excludes it), prints
  `N passed, F failed, K skipped` and one `SKIP <file>: <reason>` line each on stderr, and still
  exits 0.
- Exit 77 from any other file, or from an `.e2e.test.js` without the `SKIP:` line, is a
  **failure**. A runner that does not know the protocol also reads 77 as a failure, so a skip
  can never pass silently.
- `affected.js --run` uses the same verdict function (`classify` in `run-tests.js`): skips are
  listed, never failed.

**Forbidding skips.** `node scripts/run-tests.js --require-e2e` (also accepted by
`affected.js --run`) sets `AGENTEX_E2E_REQUIRE=1` for every child and counts any skip as a
failure (`e2e skipped under --require-e2e: <reason>`). The harness reads the variable itself: when
set, it exits 1 with `FAIL: e2e required: <reason>` instead of 77. A plain `node <file>`, `run-tests`
and `affected` therefore behave the same. Use it when a result must be proof (a release, an AC
that only a browser test covers); a skipped run is never evidence.

**Harness contract** (what the file must do, so the runners can trust it):

- Find a `node_modules` holding `playwright` and `@playwright/cli`: `AGENTEX_E2E_NODE_MODULES`
  (when set, the only place looked at), then the repo root and its parents, then the newest
  `~/.npm/_npx/*/node_modules` holding both. It never installs anything.
- If the library, the CLI or the Chromium executable is missing, print `SKIP: <what is missing and
  the fix>` and exit 77 (or fail under `AGENTEX_E2E_REQUIRE=1`).
- Bind only `127.0.0.1` on ephemeral ports, and use its own `TMPDIR` per file, so the files run
  in the parallel pool next to everything else.
- Watchdog of 120 s, and cleanup in `finally` and on exit: CLI sessions, browsers, servers and
  temp dirs are released after a pass, a failed assertion and a timeout.
- Never retry a failing case (a retry hides a defect), and never print a cookie, token or
  storage value.

**Impact.** `affected.js` selects an `.e2e.test.js` through the same dependency graph as any test
(a change to the script it spawns selects it). A changed `*.e2e.test.js` or `scripts/dev/e2e/**`
selects **no eval**: they test the plugin, they are not something an eval exercises.

**Time.** Expect the default suite to grow from about 25 s to about 40-45 s on a 12-core machine
when the browser is found (the saved-login file waits 15 s on its stale-session case); a skip
costs under 1 s per file. Measured per-file times: filled in by the harness change.

Next: [PR Workflow](./pr-workflow.md).
