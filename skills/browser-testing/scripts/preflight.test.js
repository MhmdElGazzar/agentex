'use strict';
// Tests for preflight.js — the playwright-cli probe POSTURE (judge by output, not
// exit code alone) and the unchanged external contract (one JSON line, exit 0).
//
// Background (backlog/preflight-probe-false-negative): on Windows + Node v24 a
// working @playwright/cli prints its version and then crashes on its own exit
// path with an upstream libuv assertion (UV_HANDLE_CLOSING). Judging by exit
// code alone reported a healthy tool as broken — gate-closing in CI where no
// human can override. The probe now trusts the version evidence when the crash
// matches that known benign signature, and ONLY then.
//
// Run: node skills/browser-testing/scripts/preflight.test.js
// Fixture-level: no live playwright-cli needed (probe command injected via the
// AGENTEX_PWCLI_PROBE_CMD test seam for the end-to-end contract cases).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'preflight.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const { judgePlaywrightCliProbe } = require('./preflight.js');

// The exact upstream signature observed in all three 0.20.0 live gate runs.
const BENIGN_CRASH = 'Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76';

// ---- posture fixtures (pure judgment, no spawning) --------------------------

test('version output + the known benign exit-crash → usable, version kept, note present', () => {
  const r = judgePlaywrightCliProbe({ status: 134, stdout: '0.1.18\n', stderr: BENIGN_CRASH });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.version, '0.1.18');
  assert.match(r.note, /version confirmed; known benign exit-crash/);
});

test('no plausible version output → still broken with an actionable first-line error (unchanged)', () => {
  const r = judgePlaywrightCliProbe({ status: 1, stdout: '', stderr: 'npm ERR! could not determine executable to run' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && r.error.length > 0, 'error message present');
  assert.strictEqual(r.note, undefined);
});

test('the benign crash WITHOUT version output → broken (the crash text is not version evidence)', () => {
  const r = judgePlaywrightCliProbe({ status: 134, stdout: '', stderr: BENIGN_CRASH });
  assert.strictEqual(r.ok, false);
});

test('version output but a DIFFERENT crash → broken (exception keyed to the known signature only)', () => {
  const r = judgePlaywrightCliProbe({ status: 139, stdout: '0.1.18\n', stderr: 'Segmentation fault (core dumped)' });
  assert.strictEqual(r.ok, false);
});

test('healthy zero exit → ok with version and NO note (existing behavior untouched)', () => {
  const r = judgePlaywrightCliProbe({ status: 0, stdout: 'Version 0.1.18\n', stderr: '' });
  assert.deepStrictEqual(r, { ok: true, version: 'Version 0.1.18' });
});

test('spawn-level error → broken (unchanged)', () => {
  const r = judgePlaywrightCliProbe({ error: new Error('spawn ENOENT'), status: null, stdout: '', stderr: '' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ENOENT/);
});

test('the version line is never taken from the assertion text itself', () => {
  // A crash line that happens to contain digits-dot-digits must not be read as a version.
  const r = judgePlaywrightCliProbe({ status: 134, stdout: '', stderr: 'Assertion failed at 1.2.3 — UV_HANDLE_CLOSING' });
  assert.strictEqual(r.ok, false);
});

// ---- end-to-end contract (fixture probe command, no live tool) --------------

function fixture(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-preflight-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return { dir, cmd: `"${process.execPath}" "${file}"` };
}

test('contract: ONE JSON line, exit 0, posture applied end to end (version + benign crash fixture)', () => {
  const fix = fixture('crashy.js', [
    "process.stdout.write('0.1.18\\n');",
    `process.stderr.write(${JSON.stringify(BENIGN_CRASH)});`,
    'process.exitCode = 134;',
  ].join('\n'));
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: fix.dir, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, AGENTEX_PWCLI_PROBE_CMD: fix.cmd },
  });
  assert.strictEqual(r.status, 0, `preflight is informational and always exits 0 (got ${r.status}): ${r.stderr}`);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.strictEqual(lines.length, 1, `stdout was:\n${r.stdout}`);
  const j = JSON.parse(lines[0]);
  assert.strictEqual(j['playwright-cli'].ok, true, JSON.stringify(j['playwright-cli']));
  assert.strictEqual(j['playwright-cli'].version, '0.1.18');
  assert.match(j['playwright-cli'].note, /benign exit-crash/);
  assert.strictEqual(j.node.ok, true);
});

test('contract: broken tool fixture (no version output) → ok:false end to end, exit still 0', () => {
  const fix = fixture('broken.js', [
    "process.stderr.write('npm ERR! could not determine executable to run\\n');",
    'process.exitCode = 1;',
  ].join('\n'));
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: fix.dir, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, AGENTEX_PWCLI_PROBE_CMD: fix.cmd },
  });
  assert.strictEqual(r.status, 0);
  const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  assert.strictEqual(j['playwright-cli'].ok, false);
  assert.ok(j['playwright-cli'].error);
});

// ---- structural pin (0.20.1 doctrine) ----------------------------------------

test('structural pin: preflight.js contains no process.exit(', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!src.includes('process.exit('), 'preflight.js must not force-exit');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
