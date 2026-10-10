'use strict';
// Tests for the mobile merge_run.js — copies flagged bug evidence into <runDir>/bugs/screenshots/.
// Run: node skills/mobile-testing/scripts/merge_run.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNNER = path.join(__dirname, 'merge_run.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
function runIn(cwd, args) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd, encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { code: r.status, lines, json: lines.length ? JSON.parse(lines[lines.length - 1]) : null };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-mobile-merge-'));

function seedRun(cwd) {
  const runDir = path.join('executions', 'execu_2026-10-10_10-00-00');
  for (const s of ['login', 'nav']) {
    const shots = path.join(cwd, runDir, 'mobile-sessions', s, 'screenshots');
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, 's1-fail.png'), `png-${s}`);
  }
  return runDir;
}

test('no --run-dir -> usage error, exit 2, one JSON line', () => {
  const r = runIn(tmp(), ['some.png']);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.lines.length, 1);
  assert.match(r.json.error, /--run-dir/);
});

test('--run-dir with no value -> usage error, exit 2 (no stack trace)', () => {
  const r = runIn(tmp(), ['--run-dir']);
  assert.strictEqual(r.code, 2);
  assert.match(r.json.error, /usage/);
});

test('same-named shots from two sessions are prefixed with the session, never overwritten', () => {
  const cwd = tmp();
  const runDir = seedRun(cwd);
  const ev = ['login', 'nav'].map((s) => path.join(runDir, 'mobile-sessions', s, 'screenshots', 's1-fail.png'));
  const r = runIn(cwd, ['--run-dir', runDir, ...ev]);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.json.missing, []);
  assert.strictEqual(r.json.copied.length, 2);
  const dest = path.join(cwd, runDir, 'bugs', 'screenshots');
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['login-s1-fail.png', 'nav-s1-fail.png']);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'nav-s1-fail.png'), 'utf8'), 'png-nav');
});

test('a missing evidence path is reported in "missing", the rest still copied', () => {
  const cwd = tmp();
  const runDir = seedRun(cwd);
  const good = path.join(runDir, 'mobile-sessions', 'login', 'screenshots', 's1-fail.png');
  const r = runIn(cwd, ['--run-dir', runDir, good, 'nope/does-not-exist.png']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.json.missing, ['nope/does-not-exist.png']);
  assert.strictEqual(r.json.copied.length, 1);
});

test('creates bugs/screenshots/ when the run has none yet', () => {
  const cwd = tmp();
  const runDir = seedRun(cwd);
  const r = runIn(cwd, ['--run-dir', runDir]);
  assert.strictEqual(r.code, 0);
  assert.ok(fs.existsSync(path.join(cwd, runDir, 'bugs', 'screenshots')));
  assert.deepStrictEqual(r.json, { copied: [], missing: [] });
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
