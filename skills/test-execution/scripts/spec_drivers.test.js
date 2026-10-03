'use strict';
// Tests for spec_drivers.js — which drivers a set of specs needs.
// Run: node skills/test-execution/scripts/spec_drivers.test.js
// Each case writes specs into its own temp dir, so nothing touches this repo.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { specDrivers, driversOfText } = require('./spec_drivers.js');

const SCRIPT = path.join(__dirname, 'spec_drivers.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
const dirs = [];
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-specdrv-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test('a spec with no header and no prefixes is a browser spec (every existing spec keeps working)', () => {
  assert.deepStrictEqual(driversOfText('# Spec\nTarget: https://x\n## Scenarios\n1. Open the page\n2. Click search\n'), ['browser']);
});

test('without a header, step prefixes add their drivers on top of browser, in every step shape', () => {
  const t = '# Spec\n## Scenarios\n1. Open the page\n2. api: shop.get-item(id=1) → 200\nStep 4: db: shop.item(id=1) → 1 row\n- kb: how does checkout work?\n';
  assert.deepStrictEqual(driversOfText(t), ['api', 'browser', 'db', 'kb']);
  assert.deepStrictEqual(driversOfText('## S\n6. db:  sample-db.todo(title=x) → 1 row\n'), ['browser', 'db']);
});

test('a Drivers: header is authoritative — an API-only spec needs no browser', () => {
  const t = '# Spec\nDrivers: api, db\n## Scenarios\n1. api: shop.get-item(id=1) → 200\n2. Check the response lists 3 items\n';
  assert.deepStrictEqual(driversOfText(t), ['api', 'db']);
});

test('a Drivers: line after the first ## heading is not a header', () => {
  assert.deepStrictEqual(driversOfText('# Spec\n## Notes\nDrivers: api\n'), ['browser']);
});

test('ui-check always adds browser, header or not', () => {
  assert.deepStrictEqual(driversOfText('# S\nDrivers: ui-check\n## Scenarios\n'), ['browser', 'ui-check']);
  assert.deepStrictEqual(driversOfText('## S\n3. ui-check: figma login-frame — mode: layout\n'), ['browser', 'ui-check']);
});

test('prefixes inside HTML comments or code fences are ignored (the shipped samples comment theirs out)', () => {
  const t = '## Scenarios\n1. Open\n<!-- Steps can also reach beyond the browser:\n5. api: sample-api.get-todo(id=1)\n6. db:  sample-db.todo(title=x)\n-->\n```\napi: not.a.step()\n```\n';
  assert.deepStrictEqual(driversOfText(t), ['browser']);
});

test('prose that merely mentions "api:" mid-sentence is not a step', () => {
  assert.deepStrictEqual(driversOfText('## S\n1. Confirm the page shows the api: label\n'), ['browser']);
});

test('folders are walked recursively; README.md and .auth/ are skipped', () => {
  const dir = project({
    'test/suite1/a.md': '# A\nDrivers: api\n## S\n',
    'test/suite1/nested/b.md': '# B\n## S\n1. Open\n',
    'test/README.md': '## Steps\n2. db: example.query() → 1 row\n',
    'test/.auth/state.md': 'Drivers: db',
  });
  const r = specDrivers(['test'], dir);
  assert.deepStrictEqual(Object.keys(r.perSpec).sort(), ['test/suite1/a.md', 'test/suite1/nested/b.md']);
  assert.deepStrictEqual(r.drivers, ['api', 'browser']);
});

test('an unreadable spec resolves to browser and is listed', () => {
  const dir = project({ 'test/ok.md': '# ok\nDrivers: api\n## S\n' });
  fs.mkdirSync(path.join(dir, 'test', 'weird.md')); // a directory named like a spec
  fs.writeFileSync(path.join(dir, 'test', 'weird.md', 'inner.md'), '# inner\nDrivers: db\n## S\n');
  const locked = path.join(dir, 'test', 'locked.md');
  fs.writeFileSync(locked, '# locked\nDrivers: api\n## S\n');
  fs.chmodSync(locked, 0o000);
  const r = specDrivers(['test'], dir);
  fs.chmodSync(locked, 0o644);
  if (process.getuid && process.getuid() !== 0) {
    assert.deepStrictEqual(r.perSpec['test/locked.md'], ['browser']);
    assert.ok(r.unreadable.includes('test/locked.md'));
  }
  assert.deepStrictEqual(r.perSpec['test/weird.md/inner.md'], ['db']);
});

test('unknown driver names are reported, not silently dropped', () => {
  const r = specDrivers(['s.md'], project({ 's.md': '# s\nDrivers: api, mobile\n## S\n' }));
  assert.deepStrictEqual(r.drivers, ['api', 'mobile']);
  assert.deepStrictEqual(r.unknown, ['mobile']);
});

test('CLI: one JSON line, exit 0; --all reads test/; usage errors exit 2', () => {
  const dir = project({ 'test/a.md': '# A\nDrivers: db\n## S\n' });
  let p = spawnSync(process.execPath, [SCRIPT, '--all'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(p.status, 0, p.stdout + p.stderr);
  assert.strictEqual(p.stdout.trim().split('\n').length, 1);
  assert.deepStrictEqual(JSON.parse(p.stdout).drivers, ['db']);
  p = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(p.status, 2);
  p = spawnSync(process.execPath, [SCRIPT, 'test/nope.md'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(p.status, 2);
  assert.match(JSON.parse(p.stdout).error, /not found/);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
