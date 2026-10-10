'use strict';
// Tests for the mobile init_run.js — the run output tree and its session folder names.
// Run: node skills/mobile-testing/scripts/init_run.test.js
// Each case runs the script in its own temp cwd, so nothing touches this repo.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNNER = path.join(__dirname, 'init_run.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

function runIn(cwd, args = []) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd, encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter(Boolean);
  let json = null;
  try { json = lines.length ? JSON.parse(lines[lines.length - 1]) : null; } catch { /* not JSON */ }
  return { code: r.status, lines, json, stderr: r.stderr };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-mobile-initrun-'));

test('default run: one session "run", tree created under mobile-sessions/', () => {
  const cwd = tmp();
  const { code, json } = runIn(cwd);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(Object.keys(json.sessions), ['run']);
  const s = json.sessions.run;
  assert.ok(s.dir.split(path.sep).includes('mobile-sessions'));
  for (const key of ['dir', 'logs', 'screenshots']) assert.ok(fs.existsSync(path.join(cwd, s[key])), `${key} created`);
  assert.ok(fs.existsSync(path.join(cwd, json.bugsDir, 'screenshots')));
  assert.match(json.runDir, /^executions[\\/]execu_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
});

test('runs in the same second get distinct runDirs (-2, -3 suffix)', () => {
  const cwd = tmp();
  const runs = [runIn(cwd), runIn(cwd), runIn(cwd)];
  for (const r of runs) assert.strictEqual(r.code, 0);
  const dirs = runs.map((r) => r.json.runDir);
  assert.strictEqual(new Set(dirs).size, 3, dirs.join(' '));
  // Launched back to back they mostly share a second; a repeat of a second carries -2 / -3.
  const shape = /execu_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(-\d+)?$/;
  for (const d of dirs) assert.match(d, shape);
  const seconds = dirs.map((d) => d.match(shape)[1]);
  dirs.forEach((d, i) => {
    if (seconds.indexOf(seconds[i]) !== i) assert.match(d.match(shape)[2] || '', /^-[23]$/, d);
  });
});

test('labels are sanitized to safe ASCII folder names and keep the label as given', () => {
  const cwd = tmp();
  const { code, json } = runIn(cwd, ['--sessions', 'Login Flow,Nav/Tabs']);
  assert.strictEqual(code, 1, 'a label containing a path separator is refused');
  assert.match(json.error, /path/);
  const ok = runIn(cwd, ['--sessions', 'Login Flow,Pixel 8 (API 34)']);
  assert.strictEqual(ok.code, 0);
  const names = Object.keys(ok.json.sessions);
  for (const n of names) assert.match(n, /^[a-z0-9._-]+$/);
  assert.deepStrictEqual(names.map((n) => ok.json.sessions[n].label), ['Login Flow', 'Pixel 8 (API 34)']);
});

test('non-Latin labels get distinct, traceable names', () => {
  const { code, json } = runIn(tmp(), ['--sessions', 'تسجيل-الدخول,登录']);
  assert.strictEqual(code, 0);
  const names = Object.keys(json.sessions);
  assert.strictEqual(new Set(names).size, 2);
  for (const n of names) assert.match(n, /^spec\d+-[0-9a-f]{4}$/);
});

test('duplicate labels are de-duplicated, never merged into one folder', () => {
  const { code, json } = runIn(tmp(), ['--sessions', 'login,login,LOGIN']);
  assert.strictEqual(code, 0);
  assert.strictEqual(Object.keys(json.sessions).length, 3);
});

test('the "default" label is refused, however it is spelled', () => {
  for (const label of ['default', 'DEFAULT', '-default-']) {
    const { code, json } = runIn(tmp(), ['--sessions', label]);
    assert.strictEqual(code, 1, `"${label}" must be refused`);
    assert.match(json.error, /default/);
  }
});

test('path traversal is refused and nothing is written outside executions/', () => {
  for (const label of ['../../escape', '..', 'a/../b', '..\\win']) {
    const cwd = tmp();
    const { code, json } = runIn(cwd, ['--sessions', label]);
    assert.strictEqual(code, 1, `"${label}" must be refused`);
    assert.ok(json && json.error, 'one JSON error line');
    assert.ok(!fs.existsSync(path.join(cwd, 'executions')), 'nothing created');
    assert.ok(!fs.existsSync(path.join(path.dirname(cwd), 'escape')), 'no escape folder');
  }
});

test('--sessions with no value -> JSON error, no stack trace', () => {
  const { code, lines, json, stderr } = runIn(tmp(), ['--sessions']);
  assert.strictEqual(code, 1);
  assert.strictEqual(lines.length, 1);
  assert.match(json.error, /--sessions/);
  assert.ok(!/at .*init_run\.js/.test(stderr), 'no stack trace');
});

test('--sessions with only separators -> JSON error', () => {
  const { code, json } = runIn(tmp(), ['--sessions', ' , ,']);
  assert.strictEqual(code, 1);
  assert.ok(json.error);
});

test('an unknown argument -> JSON error', () => {
  const { code, json } = runIn(tmp(), ['--bogus']);
  assert.strictEqual(code, 1);
  assert.match(json.error, /unknown argument/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
