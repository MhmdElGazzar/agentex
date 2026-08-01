# Testing

AgenTeX has no shared test framework — each script that needs one ships a small,
self-contained `<script>.test.js` next to it.

## Running tests

Run a single skill's script test:

```
node skills/ask-kb/scripts/ask_kb.test.js
```

There's no single "run everything" command yet — run each `*.test.js` under
`skills/*/scripts/` you've touched, plus any others if you're not sure what your change
affects.

## What a script test looks like

Self-contained: it spins up a local `http` server (or SQL Server fixture, for DB scripts) as a
stand-in for the real dependency, spawns the runner script as a child process with test
arguments, and asserts on its single JSON line and exit code. No mocking framework, no shared
fixtures file — everything the test needs is in that one file. See
`skills/ask-kb/scripts/ask_kb.test.js` for a full example (happy path, config precedence,
`404`/`401`/`429` handling, retries, secret-header handling), or the smaller
`check_url.test.js` built in [Adding a Skill](./adding-a-skill.md).

## What to assert

At minimum, cover:

- The success path (`PASS`/`OK` result, correct fields, exit 0)
- Each failure mode your runner maps to `FAIL` (exit 1)
- Each precondition your runner maps to `BLOCKED` (exit 2) — missing args, missing env, etc.
- Any safety rule enforced in code (catalog-only lookup, DDL ban, param sanitization,
  secret-header presence/absence) — these are exactly the things a test should catch if a
  future edit accidentally weakens them.

## When a skill doesn't need a script test

Skills that are pure judgment/workflow with no script — e.g. `extent-report`, which assembles a
static HTML dashboard from data already produced by a run rather than calling out to anything
external — have nothing deterministic to unit-test. If your skill has no `scripts/` folder, it
doesn't need a `.test.js`.

Next: [PR Workflow](./pr-workflow.md).
