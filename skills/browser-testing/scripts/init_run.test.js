'use strict';
// Tests for init_run.js — the run output tree and the unique session names.
// Run: node skills/browser-testing/scripts/init_run.test.js
// Each case runs the script in its own temp cwd, so nothing touches this repo.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RUNNER = path.join(__dirname, 'init_run.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

function runIn(cwd, args = []) {
  try {
    const out = execFileSync(process.execPath, [RUNNER, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, json: JSON.parse(out.trim().split('\n').pop()) };
  } catch (e) {
    const out = `${e.stdout || ''}`.trim();
    return { code: e.status, json: out ? JSON.parse(out.split('\n').pop()) : null };
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-initrun-'));

test('default run: one session, tree created, name is not "default"', () => {
  const cwd = tmp();
  const { code, json } = runIn(cwd);
  assert.strictEqual(code, 0);
  const names = Object.keys(json.sessions);
  assert.strictEqual(names.length, 1);
  assert.match(names[0], /^run-\d{6}-[0-9a-f]{4}$/);
  assert.notStrictEqual(names[0], 'default');
  for (const key of ['dir', 'logs', 'screenshots']) {
    assert.ok(fs.existsSync(path.join(cwd, json.sessions[names[0]][key])), `${key} created`);
  }
  assert.ok(fs.existsSync(path.join(cwd, json.bugsDir, 'screenshots')));
});

test('the prohibited "default" label is refused, however it is spelled', () => {
  for (const label of ['default', 'DEFAULT', '-default-'] ) {
    const { code, json } = runIn(tmp(), ['--sessions', label]);
    assert.strictEqual(code, 1, `"${label}" must be refused`);
    assert.match(json.error, /prohibited/);
  }
});

// A spec file named in a non-Latin script has no ASCII left after sanitizing. Every
// such label used to collapse to the same "-", so the session name said nothing
// about which spec it belonged to — the dedupe suffix was the only difference.
test('non-Latin spec labels get distinct, traceable session names', () => {
  const cwd = tmp();
  const { code, json } = runIn(cwd, ['--sessions', 'تسجيل-الدخول,البحث-عن-منتج,登录']);
  assert.strictEqual(code, 0);
  const names = Object.keys(json.sessions);
  assert.strictEqual(names.length, 3);
  assert.strictEqual(new Set(names).size, 3, 'names must differ from each other');
  for (const n of names) {
    assert.match(n, /^spec\d-[0-9a-f]{4}-\d{6}-[0-9a-f]{4}$/, `${n} is ASCII and traceable`);
    assert.ok(!/^-/.test(n), 'no bare-dash name');
  }
  // The spec's real name comes back for the report to display.
  assert.deepStrictEqual(
    names.map(n => json.sessions[n].label),
    ['تسجيل-الدخول', 'البحث-عن-منتج', '登录']);
});

test('a non-Latin label keeps the same digest across runs (traceable, not random)', () => {
  const a = runIn(tmp(), ['--sessions', 'تسجيل-الدخول']);
  const b = runIn(tmp(), ['--sessions', 'تسجيل-الدخول']);
  const digestOf = r => Object.keys(r.json.sessions)[0].split('-')[1];
  assert.strictEqual(digestOf(a), digestOf(b));
});

test('a mixed label keeps its ASCII part rather than falling back', () => {
  const { json } = runIn(tmp(), ['--sessions', 'login-تسجيل']);
  const name = Object.keys(json.sessions)[0];
  assert.match(name, /^login-\d{6}-[0-9a-f]{4}$/, 'trailing dash from the stripped part is trimmed');
});

test('ASCII labels are sanitized, deduped and mapped back to themselves', () => {
  const { json } = runIn(tmp(), ['--sessions', 'Login Flow,Login Flow,checkout.md']);
  const names = Object.keys(json.sessions);
  assert.deepStrictEqual(names.map(n => n.replace(/-\d{6}-[0-9a-f]{4}$/, '')),
    ['login-flow', 'login-flow-2', 'checkout.md']);
  assert.deepStrictEqual(names.map(n => json.sessions[n].label),
    ['Login Flow', 'Login Flow', 'checkout.md']);
});

test('a new run never reuses a session name an existing run already used', () => {
  const cwd = tmp();
  const first = runIn(cwd, ['--sessions', 'run']);
  const taken = Object.keys(first.json.sessions)[0];
  // Same label, same second: the collision check must move the tag.
  for (let i = 0; i < 5; i++) {
    const next = runIn(cwd, ['--sessions', 'run']);
    assert.notStrictEqual(Object.keys(next.json.sessions)[0], taken);
  }
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
