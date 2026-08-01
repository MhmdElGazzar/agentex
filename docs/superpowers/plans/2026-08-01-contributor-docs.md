# Contributor Docs Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a `docs/contributing/` track that teaches a newcomer with no prior Claude Code
plugin knowledge everything needed to understand AgenTeX's architecture and add a new skill
correctly, then point the root README at it.

**Architecture:** Six new markdown pages under `docs/contributing/` (101 → architecture →
worked example → conventions → testing → PR workflow) plus an index `README.md`, mirroring the
existing `docs/` folder's index-table pattern. The worked example builds a toy `url-healthcheck`
skill purely as markdown content (no real files under `skills/`), using code already verified to
run correctly (see below). Root `README.md`'s Contributing section is trimmed to point here.

**Tech Stack:** Markdown only. The one piece of "code" in this plan (`check_url.js` /
`check_url.test.js`) already ran successfully in a scratch folder — this plan embeds that
verified output; it does not ask the implementer to write it from scratch.

## Global Constraints

- Never include real employer/organization/project names, work-item IDs, work emails, or vendor
  names in any new doc — this repo is a published, generic plugin (spec: no-employer-data rule).
- This is documentation only — no changes to any file under `skills/`, `commands/`, or `agents/`.
- Follow the existing `docs/README.md` index-table style for the new `docs/contributing/README.md`.
- Commit each task directly to `main` (solo-maintainer workflow already in use on this repo) —
  no feature branch.
- Every internal link between new pages must resolve to a file created in this plan (verify with
  a grep-based check per task, not just by eye).

---

### Task 1: `docs/contributing/claude-code-101.md`

**Files:**
- Create: `docs/contributing/claude-code-101.md`

**Interfaces:**
- Produces: the anchor `#command` (referenced by Task 3) and a link target
  `./claude-code-101.md` (referenced by Tasks 2, 3, 4, 6, 7).

- [ ] **Step 1: Write the file**

```markdown
# Claude Code 101 — Concepts From Zero

This page explains the Claude Code building blocks AgenTeX is built from, with no AgenTeX
specifics yet. If you already know what a plugin/skill/command/subagent is, skip ahead to
[Architecture](./architecture.md).

## Plugin

A **plugin** is an installable bundle of capabilities for Claude Code: skills, commands, and
subagents packaged together, described by a `.claude-plugin/plugin.json` manifest (name,
version, author, description). Users install it from a **marketplace** — a git repo that lists
available plugins — with `/plugin marketplace add <repo>` then
`/plugin install <name>@<marketplace>`. AgenTeX itself is one such plugin.

## Skill

A **skill** is a folder under `skills/<name>/` containing a `SKILL.md` file. `SKILL.md` has two
parts:

- **YAML frontmatter** — `name` and a `description` written for Claude to decide *when* to use
  this skill. The description is matched against the user's request; write it like a trigger
  condition, not a summary.
- **Body** — instructions Claude follows once the skill is in play: role, rules, workflow steps.

Claude reads a skill's `SKILL.md` when its description matches the current task, then follows
its instructions for the rest of that work. A skill folder can also hold `references/` (details
read on demand, not upfront), `scripts/` (code the skill runs via Bash), and `templates/`
(starter files the skill scaffolds into the user's project).

## Command

A **command** is a file under `commands/<name>.md`. It becomes a slash command
(`commands/execute-test.md` → `/execute-test`). Its frontmatter holds a `description` (shown in
`/help` and used for usage hints); its body is the instructions Claude follows when invoked,
with `$ARGUMENTS` standing in for whatever text the user typed after the command name. Commands
are meant to be **thin** — a few steps that parse `$ARGUMENTS` and hand off to a skill, not
where the real logic lives.

## Subagent

A **subagent** is a separate Claude instance with its own context window, defined by a file
under `agents/<name>.md` (role, tools it's allowed to use, instructions). The main agent
*dispatches* work to a subagent — e.g. to run something in isolation, to parallelize independent
work, or to keep a long-running task's output from bloating the main conversation. The subagent
runs its task and returns a result to whoever dispatched it.

## How a request flows through these

1. User types a request (natural language, or a `/command`).
2. If it's a command, Claude reads `commands/<name>.md`, substitutes `$ARGUMENTS`, and follows
   its steps.
3. Those steps (or the user's plain request directly) trigger a **skill** whose `description`
   matches — Claude reads that `SKILL.md` and follows it.
4. The skill's instructions may dispatch one or more **subagents** to do isolated or parallel
   work, and may run **scripts** via Bash for deterministic, mechanical steps.
5. Results flow back up: subagent → skill → command → user.

Next: [Architecture](./architecture.md) — how AgenTeX puts these pieces together.
```

- [ ] **Step 2: Verify no placeholders and the folder exists correctly**

Run: `grep -n "TBD\|TODO" docs/contributing/claude-code-101.md`
Expected: no output (no matches).

- [ ] **Step 3: Commit**

```bash
git add docs/contributing/claude-code-101.md
git commit -m "docs: add Claude Code 101 contributor doc"
```

---

### Task 2: `docs/contributing/architecture.md`

**Files:**
- Create: `docs/contributing/architecture.md`

**Interfaces:**
- Consumes: link target `./claude-code-101.md` (Task 1).
- Produces: anchor `#deterministic-scripts-do-the-mechanical-work` (referenced by Task 3) and
  link target `./architecture.md` (referenced by Tasks 1, 3, 4, 5).

- [ ] **Step 1: Write the file**

Note: this file's own content contains nested ```text fences, so the wrapper below uses 4
backticks precisely so those inner fences don't prematurely close it — write only what's
between the 4-backtick markers, not the markers themselves.

````markdown
# Architecture — How AgenTeX Composes Claude Code

Builds on [Claude Code 101](./claude-code-101.md). This page is AgenTeX-specific: how its
skills, commands, and subagent are put together, and the conventions that make that composition
predictable.

## Repo map

```text
skills/       one folder per capability (SKILL.md + references/ + scripts/ + templates/)
commands/     thin slash-command entrypoints ($ARGUMENTS -> skill)
agents/       subagent definitions (currently: qa-executor.md)
docs/         user-facing feature docs (this contributing/ subfolder is the exception)
test/         sample specs scaffolded by /init-test
executions/   NOT shipped in the plugin — output folder created in the consumer's project
```

## SKILL.md = judgment, references/ = mechanics

Every skill splits into two layers:

- **`SKILL.md`** holds *judgment*: when to act, which mode to pick, what to check before
  proceeding, how to report results. It's what Claude reads every time the skill is in play.
- **`references/*.md`** holds *mechanics*: exact CLI flags, API request/response shapes,
  gotchas. These are read on demand — "before the first use of that tool in a session" — not
  loaded upfront, so `SKILL.md` stays short and skimmable.

Example: `skills/browser-testing/SKILL.md` says to read `references/playwright-cli.md` before
driving a browser for the first time, rather than inlining every `playwright-cli` flag into the
main skill file.

## Deterministic scripts do the mechanical work

Where a step is mechanical, security-sensitive, or easy to get subtly wrong if an agent
improvised it, AgenTeX moves that step into a small Node script instead of leaving it to agent
reasoning:

- `skills/api-integration/scripts/run_api.js` — executes one cataloged API request: catalog
  lookup, param validation, env resolution, the HTTP call, evidence logging, assertions.
- `skills/db-integration/scripts/run_db.js` — the same shape for SQL Server queries, with a DDL
  ban and parameter sanitization enforced in code (not something an agent is trusted to
  self-police).
- `skills/optimize-login/scripts/session.js` — verifies/saves/resumes a browser `storageState`.
- `skills/browser-testing/scripts/{preflight,init_run,merge_run}.js` — tool checks, execution
  tree scaffolding, bug-evidence merging.

**The pattern:** the agent decides *what* to run and reports the result; the script decides
*whether it's allowed to run* and executes it exactly the same way every time. Every runner
prints exactly one JSON line — `{"result":"PASS|FAIL|BLOCKED", ...}` — and sets its exit code
(0/1/2) to match, so the calling skill can branch on it without parsing prose.

## Execution output layout

Every test run writes into one timestamped folder inside the **consumer's** project (never
inside the plugin itself):

```text
executions/execu_<YYYY-MM-DD_HH-MM-SS>/
├── report.md
├── browser-sessions/<session>/{logs,screenshots}/
└── bugs/{bug-list.md, screenshots/}
```

`skills/browser-testing/scripts/init_run.js` creates this tree in one call rather than a chain
of `mkdir`s — see [testing.md](./testing.md) for how scripts like this get tested.

## Dispatching the qa-executor subagent

`agents/qa-executor.md` defines a subagent whose job is to execute **one** test spec file in its
own `playwright-cli` session, never touching application code. `skills/browser-testing/SKILL.md`
dispatches it two ways:

- **Sequential mode** (default): a single `default` session, human approves each checkpoint.
- **Parallel mode**: one `qa-executor` per spec file, all dispatched in a single batch so they
  run concurrently (queued automatically past ~6–8 concurrent sessions), each writing only into
  its own `browser-sessions/<session>/` folder. The main agent then merges their reports into
  one `report.md` and `bugs/`.

This is the concrete case of "dispatch a subagent for isolated/parallel work" from
[Claude Code 101](./claude-code-101.md).

## Where to go next

- [Conventions](./conventions.md) — naming, the no-employer-data rule, secrets, the
  catalog-only principle.
- [Adding a Skill](./adding-a-skill.md) — build a toy skill end to end using everything above.
````

- [ ] **Step 2: Verify no placeholders**

Run: `grep -n "TBD\|TODO" docs/contributing/architecture.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/contributing/architecture.md
git commit -m "docs: add architecture contributor doc"
```

---

### Task 3: `docs/contributing/adding-a-skill.md`

**Files:**
- Create: `docs/contributing/adding-a-skill.md`

**Interfaces:**
- Consumes: `./claude-code-101.md#command` (Task 1),
  `./architecture.md#deterministic-scripts-do-the-mechanical-work` (Task 2).
- Produces: link target `./adding-a-skill.md` and anchor `#8-wire-it-up` (both referenced by
  Tasks 5, 6, 7).

The `check_url.js` / `check_url.test.js` content below already ran successfully in a scratch
folder (`node check_url.test.js` → `3 passed`, all of PASS/FAIL/BLOCKED verified) before this
plan was written. Embed it verbatim — do not modify the logic.

- [ ] **Step 1: Write the file**

Note: this file's own content contains nested `~~~markdown` blocks (each of which itself
contains a plain 3-backtick fence) and plain 3-backtick `javascript` fences, so the wrapper
below uses 4 backticks precisely so none of that inner content prematurely closes it — write
only what's between the 4-backtick markers, not the markers themselves.

````markdown
# Adding a Skill — Worked Example: `url-healthcheck`

This walks through building one small skill end to end: **`url-healthcheck`**, which checks
whether a URL responds with HTTP 200. It's illustrative only — it is not a real AgenTeX
feature, and nothing here gets merged into `skills/`. Follow along by creating these files in a
scratch folder if you want to run it yourself.

Builds on [Claude Code 101](./claude-code-101.md) and [Architecture](./architecture.md).

## 1. Name it

Skills are named noun-style (`browser-testing`, `ask-kb`, `optimize-login`) —
`url-healthcheck` describes *what it is*, not an action. Its command counterpart will be
verb-style: `/check-url`.

## 2. Decide: does it need a script?

The actual HTTP check is mechanical — same request, same status check, every time — exactly
the kind of step
[Architecture](./architecture.md#deterministic-scripts-do-the-mechanical-work) says belongs in
a script, not agent reasoning. So this skill gets a `scripts/` folder.

## 3. `skills/url-healthcheck/SKILL.md` — the judgment

~~~markdown
---
name: url-healthcheck
description: >
  Check whether a URL responds with HTTP 200. Use when a test step or request asks to verify
  a page or endpoint is reachable before continuing (e.g. "make sure the site is up first").
---

# URL Health Check

## Role
Confirm a URL is reachable before other steps depend on it. This is a precondition check, not
a full test — a 200 means "reachable", nothing about the page's content.

## Running the check
Execute the bundled runner (deterministic — always the same request, same status check):

```
node ${CLAUDE_PLUGIN_ROOT}/skills/url-healthcheck/scripts/check_url.js --url <url>
```

Prints one JSON line: `{"result":"PASS|FAIL|BLOCKED", ...}` (exit 0/1/2). For flags and
response shape, read
`${CLAUDE_PLUGIN_ROOT}/skills/url-healthcheck/references/mechanics.md`.

## Reporting
- `PASS` → continue with the dependent steps.
- `FAIL` → report the URL and status/reason; do not continue steps that assume it's reachable.
- `BLOCKED` → the runner was called without a required argument; report the reason.
~~~

## 4. `skills/url-healthcheck/references/mechanics.md` — the mechanics

~~~markdown
# check_url.js — mechanics

```
node check_url.js --url <url> [--timeout-ms 5000]
```

- Sends a `GET` request to `<url>` with a 5000ms default timeout (`--timeout-ms` overrides it).
- `PASS` — status is exactly 200: `{"result":"PASS","status":200}`, exit 0.
- `FAIL` — request completes with a non-200 status, or the request itself fails (timeout, DNS,
  connection refused): `{"result":"FAIL","status":<code>,"reason":"..."}`, exit 1.
- `BLOCKED` — called without `--url`: `{"result":"BLOCKED","reason":"..."}`, exit 2.

No retries, no redirects followed beyond what `fetch` does by default, no auth support — this
is a minimal reachability check, not a general HTTP client.
~~~

## 5. `skills/url-healthcheck/scripts/check_url.js` — the runner

```javascript
// Toy example runner — checks whether a URL responds with HTTP 200.
//
// Usage:
//   node check_url.js --url <url> [--timeout-ms 5000]
//
// Prints ONE JSON line: {"result":"PASS|FAIL|BLOCKED", ...}. Exit: 0 PASS, 1 FAIL, 2 BLOCKED.
function out(obj, code) { console.log(JSON.stringify(obj)); process.exitCode = code; }
function blocked(reason) { console.log(JSON.stringify({ result: 'BLOCKED', reason })); process.exit(2); }

const args = process.argv.slice(2);
let url, timeoutMs = 5000;
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i];
  if (a === '--url') url = v();
  else if (a === '--timeout-ms') timeoutMs = parseInt(v(), 10);
}
if (!url) blocked('usage: --url <url> required');

(async () => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: 'GET', signal: ctl.signal });
  } catch (e) {
    out({ result: 'FAIL', reason: `request failed: ${e.message}` }, 1);
    return;
  } finally { clearTimeout(t); }

  if (res.status !== 200) { out({ result: 'FAIL', status: res.status, reason: `expected 200, got ${res.status}` }, 1); return; }
  out({ result: 'PASS', status: res.status }, 0);
})();
```

## 6. `skills/url-healthcheck/scripts/check_url.test.js` — proving it works

```javascript
'use strict';
// Self-contained test: spins up local http servers, runs check_url.js against them,
// asserts the single JSON line and exit code. Run: node check_url.test.js
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const RUNNER = path.join(__dirname, 'check_url.js');
let passed = 0;

function server(handler) {
  const srv = http.createServer(handler);
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function run(args) {
  return new Promise((resolve) => {
    const p = spawn('node', [RUNNER, ...args]);
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('close', code => resolve({ code, json: JSON.parse(out.trim()) }));
  });
}

async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ok -', name);
}

(async () => {
  await test('200 response -> PASS, exit 0', async () => {
    const srv = await server((req, res) => { res.writeHead(200); res.end('ok'); });
    const port = srv.address().port;
    const r = await run(['--url', `http://127.0.0.1:${port}/`]);
    srv.close();
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.json.result, 'PASS');
    assert.strictEqual(r.json.status, 200);
  });

  await test('500 response -> FAIL, exit 1', async () => {
    const srv = await server((req, res) => { res.writeHead(500); res.end('boom'); });
    const port = srv.address().port;
    const r = await run(['--url', `http://127.0.0.1:${port}/`]);
    srv.close();
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.json.result, 'FAIL');
    assert.strictEqual(r.json.status, 500);
  });

  await test('missing --url -> BLOCKED, exit 2', async () => {
    const r = await run([]);
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.json.result, 'BLOCKED');
  });

  console.log(`\n${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
```

Run it: `node check_url.test.js` →

```
  ok - 200 response -> PASS, exit 0
  ok - 500 response -> FAIL, exit 1
  ok - missing --url -> BLOCKED, exit 2

3 passed
```

(see [testing.md](./testing.md) for why script tests are self-contained like this).

## 7. `commands/check-url.md` — the thin entrypoint

~~~markdown
---
description: Check whether a URL responds with HTTP 200. Usage: /check-url <url>
---

Check the reachability of a URL using the **url-healthcheck** skill's runner.

URL: $ARGUMENTS

Do this:
1. If `$ARGUMENTS` is empty, ask the user for a URL and stop.
2. Run:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/skills/url-healthcheck/scripts/check_url.js --url $ARGUMENTS
   ```
3. Report the one-line JSON result per `SKILL.md`'s Reporting section.
~~~

Notice how thin this is — no logic beyond parsing `$ARGUMENTS` and calling the skill's runner,
per the convention in [Claude Code 101](./claude-code-101.md#command).

## 8. Wire it up

If this were a real skill (it isn't — it's this guide's running example), the last steps would
be:

- Add a row to `docs/README.md`'s feature table and the root `README.md` feature table.
- Add a `CHANGELOG.md` entry under `[Unreleased]`:
  ```markdown
  ### Added
  - `url-healthcheck` skill: `/check-url <url>` confirms a URL returns HTTP 200 before
    dependent steps run.
  ```
- Run every script test in the repo, including the new one, before opening a PR — see
  [testing.md](./testing.md).

## Recap

| File | Layer |
|------|-------|
| `SKILL.md` | judgment — when/why to check |
| `references/mechanics.md` | mechanics — exact flags and output shape |
| `scripts/check_url.js` | the deterministic runner |
| `scripts/check_url.test.js` | proves the runner behaves as documented |
| `commands/check-url.md` | thin entrypoint |

Next: [Conventions](./conventions.md) for the naming/security rules this example already
followed, or [Testing](./testing.md) for how to run and write script tests like the one above.
````

- [ ] **Step 2: Verify the embedded code still matches the verified version**

Run (from repo root, comparing against the scratch copy used to author this plan — adjust the
scratch path to wherever you saved it while writing/reviewing this plan, or skip this diff and
instead just re-run Step 3 below, which is the authoritative check):

```bash
node -e "
const fs = require('fs');
const content = fs.readFileSync('docs/contributing/adding-a-skill.md', 'utf8');
if (!content.includes('function blocked(reason)')) { console.error('check_url.js snippet missing/altered'); process.exit(1); }
if (!content.includes(\"await test('missing --url -> BLOCKED, exit 2'\")) { console.error('check_url.test.js snippet missing/altered'); process.exit(1); }
console.log('embedded code present');
"
```

Expected: `embedded code present`.

- [ ] **Step 3: Extract and actually run the embedded scripts to prove they still work**

```bash
mkdir -p /tmp/url-healthcheck-verify
node -e "
const fs = require('fs');
const md = fs.readFileSync('docs/contributing/adding-a-skill.md', 'utf8');
const blocks = [...md.matchAll(/\`\`\`javascript\n([\s\S]*?)\n\`\`\`/g)].map(m => m[1]);
fs.writeFileSync('/tmp/url-healthcheck-verify/check_url.js', blocks[0]);
fs.writeFileSync('/tmp/url-healthcheck-verify/check_url.test.js', blocks[1]);
"
node /tmp/url-healthcheck-verify/check_url.test.js
```

Expected output ends with:
```
  ok - 200 response -> PASS, exit 0
  ok - 500 response -> FAIL, exit 1
  ok - missing --url -> BLOCKED, exit 2

3 passed
```

If it doesn't match, the markdown code fences were miscounted or the embedded code was altered
in transcription — fix Step 1 and re-run this step.

- [ ] **Step 4: Commit**

```bash
git add docs/contributing/adding-a-skill.md
git commit -m "docs: add worked adding-a-skill example (url-healthcheck)"
```

---

### Task 4: `docs/contributing/conventions.md`

**Files:**
- Create: `docs/contributing/conventions.md`

**Interfaces:**
- Consumes: `./architecture.md` (Task 2).
- Produces: link target `./conventions.md` and anchor
  `#never-ship-employerproject-specific-data` (referenced by Tasks 3, 5, 6, 7).

- [ ] **Step 1: Write the file**

```markdown
# Conventions

Rules established across AgenTeX's build-out. Follow these for any new skill, script, or doc.

## Naming

- Skills are **noun-style**: `browser-testing`, `ask-kb`, `optimize-login` — what the
  capability *is*.
- Commands are **verb-style**: `/execute-test`, `/estimate-story`, `/design-test` — what the
  user is asking to *do*.

## Never ship employer/project-specific data

The plugin is published and installed by strangers — it must stay fully generic. Never commit,
even "as an example":

- Real organization, project, or team names
- Real work-item/story IDs
- Real work email addresses
- Real vendor/integration names
- Real sprint naming or cadences

Config that varies per install resolves from `AZURE_*` / `KB_*` keys in `.env`, or is asked for
once per session — never hardcoded. Project-specific conventions (like a team's test-case
naming scheme) live in the **consumer's own project**, e.g. `.agentex/test-template.md`,
scaffolded from a template the plugin ships — the template is generic, the filled-in copy is
the user's own and never leaves their project.

## Secrets stay in the environment

Catalog files (`integration/*_api.json`, `*_db.json`) and skill code hold **env-var names**
only (e.g. `tokenEnv: "MY_SERVICE_TOKEN"`), never values. Values live in `.env` (gitignored in
the consumer's project) or the shell environment, and are never printed or logged by any runner
script.

## Catalog-only execution

`api:` / `db:` test steps execute **only** requests/queries the user has defined ahead of time
in their project's `integration/` catalog. An agent never composes its own SQL or HTTP request
for these steps — a step naming an undefined entry is `BLOCKED`, not improvised. This is
enforced in the runner scripts (`run_api.js`, `run_db.js`), not left to agent discipline.

## Shared-reference rule

Don't centralize a reference file "just in case." Move it into a shared location only when a
**second consumer** actually appears — e.g. `azure-devops-cli.md` moved into
`azure-integration/references/` once a second skill needed it, making `azure-integration` the
shared "Azure toolbox."

## Deterministic scripts print one JSON line

Any script a skill dispatches via Bash should print exactly one JSON line —
`{"result":"PASS|FAIL|BLOCKED", ...}` — and exit 0/1/2 to match, so the calling skill can branch
on structured output instead of parsing prose. See [architecture.md](./architecture.md) and the
worked example in [adding-a-skill.md](./adding-a-skill.md).

Next: [Testing](./testing.md) or [PR Workflow](./pr-workflow.md).
```

- [ ] **Step 2: Verify no placeholders**

Run: `grep -n "TBD\|TODO" docs/contributing/conventions.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/contributing/conventions.md
git commit -m "docs: add conventions contributor doc"
```

---

### Task 5: `docs/contributing/testing.md`

**Files:**
- Create: `docs/contributing/testing.md`

**Interfaces:**
- Consumes: `./adding-a-skill.md#8-wire-it-up` (Task 3).
- Produces: link target `./testing.md` (referenced by Tasks 2, 3, 4, 6, 7).

- [ ] **Step 1: Write the file**

Note: this file's own content contains a nested plain 3-backtick fence, so the wrapper below
uses 4 backticks so it doesn't prematurely close — write only what's between the 4-backtick
markers, not the markers themselves.

````markdown
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
````

- [ ] **Step 2: Verify no placeholders and the referenced real file exists**

Run:
```bash
grep -n "TBD\|TODO" docs/contributing/testing.md
test -f skills/ask-kb/scripts/ask_kb.test.js && echo "reference target exists"
```
Expected: first command has no output; second prints `reference target exists`.

- [ ] **Step 3: Commit**

```bash
git add docs/contributing/testing.md
git commit -m "docs: add testing contributor doc"
```

---

### Task 6: `docs/contributing/pr-workflow.md`

**Files:**
- Create: `docs/contributing/pr-workflow.md`

**Interfaces:**
- Consumes: `./conventions.md#never-ship-employerproject-specific-data` (Task 4),
  `./adding-a-skill.md#8-wire-it-up` (Task 3), `./testing.md` (Task 5).
- Produces: link target `./pr-workflow.md` (referenced by Tasks 4, 5, 7).

- [ ] **Step 1: Write the file**

```markdown
# Contributing a Pull Request

## Before you start

Read [Conventions](./conventions.md) — the no-employer-data rule especially; it's the most
common reason a PR needs a revision.

## Workflow

1. **Fork** `MhmdElGazzar/agentex` and branch off `main`.
2. **Build your change** following the patterns in [Architecture](./architecture.md) and the
   worked example in [Adding a Skill](./adding-a-skill.md).
3. **Run script tests** for anything you touched or added — see [Testing](./testing.md).
4. **Update docs** — a new skill needs a row in `docs/README.md`'s table (and the root
   `README.md` feature table if it's user-facing).
5. **Add a `CHANGELOG.md` entry** under `[Unreleased]` (`### Added` / `### Changed` /
   `### Fixed` as appropriate) — see the example in
   [Adding a Skill](./adding-a-skill.md#8-wire-it-up).
6. **Open the PR** against `main`, describing what changed and why.

## What gets checked on review

- No employer/project-specific data leaked in anywhere (see
  [Conventions](./conventions.md#never-ship-employerproject-specific-data))
- Secrets stay env-only, never hardcoded or logged
- New scripts have a passing `.test.js` covering success/`FAIL`/`BLOCKED`
- `SKILL.md` stays judgment-only; mechanics belong in `references/`
- Naming follows the noun-skill / verb-command convention
- Docs and `CHANGELOG.md` are updated

## After merge

The maintainer commits releases straight to `main` and bumps the version in
`.claude-plugin/plugin.json` + `CHANGELOG.md`; the `elgazzar-plugins` marketplace listing is
re-synced on each release. You don't need to do either of these in your PR.
```

- [ ] **Step 2: Verify no placeholders**

Run: `grep -n "TBD\|TODO" docs/contributing/pr-workflow.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/contributing/pr-workflow.md
git commit -m "docs: add PR workflow contributor doc"
```

---

### Task 7: `docs/contributing/README.md` (index) + root `README.md` update

**Files:**
- Create: `docs/contributing/README.md`
- Modify: `README.md` (the "## Contributing" section — currently a single paragraph)

**Interfaces:**
- Consumes: link targets from Tasks 1–6 (`claude-code-101.md`, `architecture.md`,
  `adding-a-skill.md`, `conventions.md`, `testing.md`, `pr-workflow.md`).

- [ ] **Step 1: Write `docs/contributing/README.md`**

```markdown
# Contributing to AgenTeX

Documentation for anyone building or extending the plugin itself — as opposed to
[docs/](../README.md), which covers *using* it.

| Doc | What it covers |
|-----|----------------|
| [Claude Code 101](./claude-code-101.md) | Plugins, skills, commands, subagents — from zero. |
| [Architecture](./architecture.md) | How AgenTeX composes those primitives: SKILL.md/references split, deterministic scripts, execution output, the qa-executor subagent. |
| [Adding a Skill](./adding-a-skill.md) | Full worked example — build a toy skill end to end. |
| [Conventions](./conventions.md) | Naming, the no-employer-data rule, secrets, catalog-only execution. |
| [Testing](./testing.md) | Running and writing script tests. |
| [PR Workflow](./pr-workflow.md) | Fork → branch → PR, what's checked on review. |

New to Claude Code plugins entirely? Start at [Claude Code 101](./claude-code-101.md). Already
comfortable with plugins/skills/commands and just want to add something? Jump straight to
[Adding a Skill](./adding-a-skill.md).

Ready to open a PR? See [PR Workflow](./pr-workflow.md).
```

- [ ] **Step 2: Read the current root `README.md` Contributing section**

Read `README.md` and locate the `## Contributing` section (currently the paragraph starting
"Contributions are welcome..." and ending "...before submitting.", immediately followed by the
`## Contributors` section listing names).

- [ ] **Step 3: Replace it**

Replace the existing `## Contributing` paragraph with:

```markdown
## Contributing

New to the codebase? **[docs/contributing/](./docs/contributing/README.md)** teaches Claude
Code concepts from zero, AgenTeX's architecture, and walks through adding a skill end to end.
Open issues and PRs on the [GitHub repository](https://github.com/MhmdElGazzar/agentex).
```

Note this also fixes the existing link target: the current paragraph links "GitHub repository"
to `MhmdElGazzar/elgazzar-plugins` (the marketplace listing repo), but this plugin's own repo —
where PRs actually get opened, per `git remote -v` — is `MhmdElGazzar/agentex`. Leave the
`## Contributors` section immediately below untouched.

- [ ] **Step 4: Verify all internal links resolve**

Run:
```bash
node -e "
const fs = require('fs');
const path = require('path');
const files = [
  'README.md',
  'docs/README.md',
  'docs/contributing/README.md',
  'docs/contributing/claude-code-101.md',
  'docs/contributing/architecture.md',
  'docs/contributing/adding-a-skill.md',
  'docs/contributing/conventions.md',
  'docs/contributing/testing.md',
  'docs/contributing/pr-workflow.md',
];
let ok = true;
for (const f of files) {
  const dir = path.dirname(f);
  const content = fs.readFileSync(f, 'utf8');
  const links = [...content.matchAll(/\]\((\.\/[^)#]+|\.\.\/[^)#]+)/g)].map(m => m[1]);
  for (const l of links) {
    const target = path.join(dir, l);
    if (!fs.existsSync(target)) { console.error(\`BROKEN LINK in \${f}: \${l} -> \${target}\`); ok = false; }
  }
}
console.log(ok ? 'all links resolve' : 'broken links found');
"
```
Expected: `all links resolve`.

- [ ] **Step 5: Commit**

```bash
git add docs/contributing/README.md README.md
git commit -m "docs: add contributing index, point root README at it"
```

---

## Post-plan check

After all 7 tasks: re-run the Task 7 Step 4 link-check script once more (it covers every file
this plan created) and re-run `node /tmp/url-healthcheck-verify/check_url.test.js` (from Task 3
Step 3) to reconfirm the embedded example still works. Both should pass with no further changes
needed.
