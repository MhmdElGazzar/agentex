'use strict';
// Offline tests for list-picklist.js.
// Run: node skills/bug-report-azure/scripts/list-picklist.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'list-picklist.js');
const IS_WIN = process.platform === 'win32';
const dirs = [];
const failures = [];
let passed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-picklist-'));
  dirs.push(dir);
  return dir;
}

function fakeAz(dir) {
  const fields = { value: [
    { name: 'Environment', referenceName: 'Custom.Environment', alwaysRequired: true,
      allowedValues: ['Development', 'Testing', 'UAT'] },
    { name: 'Bug Category', referenceName: 'Custom.BugCategory', alwaysRequired: false,
      allowedValues: ['Functional', 'System Issue'] },
    { name: 'Title', referenceName: 'System.Title', alwaysRequired: true, allowedValues: [] },
    { name: 'Description', referenceName: 'System.Description', alwaysRequired: false,
      allowedValues: [] },
  ] };

  fs.writeFileSync(path.join(dir, 'fake-az.js'), `
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'az-calls.log'), JSON.stringify(a) + '\\n');
if (a.includes('configure') && a.includes('--list')) process.exit(0);
if (process.env.AGENTEX_FAKE_AZ_FAIL === '1') {
  process.stderr.write('TF400813: simulated authorization failure\\n'); process.exit(1);
}

const has = (...words) => words.every((word) => a.includes(word));
if (!has('devops', 'invoke', '--area', 'wit', '--resource', 'workitemtypesfield')) {
  process.stderr.write('fake-az: unexpected command\\n'); process.exit(1);
}
process.stdout.write(${JSON.stringify(JSON.stringify(fields))});
`);

  if (IS_WIN) {
    fs.writeFileSync(path.join(dir, 'az.cmd'), '@echo off\r\nnode "%~dp0fake-az.js" %*\r\n');
  } else {
    const exe = path.join(dir, 'az');
    fs.writeFileSync(exe, '#!/bin/sh\nexec node "$(dirname "$0")/fake-az.js" "$@"\n');
    fs.chmodSync(exe, 0o755);
  }
}

function run(dir, args, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir, encoding: 'utf8',
    env: {
      ...process.env,
      PATH: dir + path.delimiter + process.env.PATH,
      Path: dir + path.delimiter + (process.env.Path || ''),
      AZURE_URL: 'https://example.visualstudio.com', AZURE_PROJECT: 'ExampleProject',
      AZURE_DEVOPS_ORG_URL: '', AZURE_DEVOPS_DEFAULT_PROJECT: '',
      AZURE_ORG: '', AZURE_DEVOPS_ORG: '', AGENTEX_FAKE_AZ_FAIL: '', ...env,
    },
  });
  return { ...result, stdout: result.stdout || '', stderr: result.stderr || '',
    out: (result.stdout || '') + (result.stderr || '') };
}

function calls(dir) {
  const file = path.join(dir, 'az-calls.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

console.log('\nlist-picklist');

test('lists relevant fields through one read-only az call', () => {
  const dir = sandbox(); fakeAz(dir);
  const result = run(dir, []);
  assert.strictEqual(result.status, 0, result.out);
  assert.match(result.stdout, /Environment.*\[REQUIRED\]/);
  assert.match(result.stdout, /Bug Category/);
  assert.match(result.stdout, /Title.*\[REQUIRED\]/);
  assert.doesNotMatch(result.stdout, /Description/);
  const log = calls(dir);
  assert.strictEqual(log.length, 1);
  assert.ok(log[0].includes('workitemtypesfield'));
  assert.ok(!log[0].includes('POST') && !log[0].includes('PATCH'));
});

test('--field accepts a display name and returns JSON', () => {
  const dir = sandbox(); fakeAz(dir);
  const result = run(dir, ['--type', 'Test Case', '--field', 'Environment', '--json']);
  assert.strictEqual(result.status, 0, result.out);
  const json = JSON.parse(result.stdout);
  assert.strictEqual(json.referenceName, 'Custom.Environment');
  assert.deepStrictEqual(json.allowedValues, ['Development', 'Testing', 'UAT']);
  assert.ok(calls(dir)[0].includes('type=Test Case'));
});

test('--required returns only mandatory fields', () => {
  const dir = sandbox(); fakeAz(dir);
  const result = run(dir, ['--required', '--json']);
  assert.strictEqual(result.status, 0, result.out);
  assert.deepStrictEqual(JSON.parse(result.stdout).map((f) => f.referenceName),
    ['Custom.Environment', 'System.Title']);
});

test('an unknown field fails clearly', () => {
  const dir = sandbox(); fakeAz(dir);
  const result = run(dir, ['--field', 'Custom.DoesNotExist']);
  assert.strictEqual(result.status, 1, result.out);
  assert.match(result.stderr, /is not a field on Bug/);
});

test('an az failure is surfaced without retrying', () => {
  const dir = sandbox(); fakeAz(dir);
  const result = run(dir, [], { AGENTEX_FAKE_AZ_FAIL: '1' });
  assert.strictEqual(result.status, 1, result.out);
  assert.match(result.stderr, /simulated authorization failure/);
  assert.strictEqual(calls(dir).length, 1);
});

test('missing org and project blocks the field lookup', () => {
  const dir = sandbox(); fakeAz(dir);
  const result = run(dir, [], { AZURE_URL: '', AZURE_PROJECT: '' });
  assert.strictEqual(result.status, 1, result.out);
  assert.match(result.stderr, /cannot resolve org\/project for the field lookup/);
  assert.ok(!calls(dir).some((call) => call.includes('workitemtypesfield')));
});

try {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) failures.forEach((failure) => console.error(`  - ${failure}`));
} finally {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
process.exit(failures.length ? 1 : 0);
