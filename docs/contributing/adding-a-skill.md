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
