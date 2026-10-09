'use strict';
// Self-contained test: covers argument-parsing / BLOCKED paths without needing a live Appium
// server, a device, or webdriverio installed. Run: node appium_client.test.js
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const RUNNER = path.join(__dirname, 'appium_client.js');
let passed = 0;

function run(args, cwd) {
  const r = spawnSync('node', [RUNNER, ...args], { encoding: 'utf8', cwd: cwd || __dirname });
  return { code: r.status, json: JSON.parse(r.stdout.trim()) };
}

function test(name, fn) {
  fn();
  passed++;
  console.log('  ok -', name);
}

// A cwd with no node_modules/webdriverio at all, so resolution always fails deterministically
// regardless of whether webdriverio happens to be installed somewhere above this repo.
const bareCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-mobile-test-'));

test('no subcommand -> BLOCKED, exit 2', () => {
  const r = run([], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
});

test('unknown subcommand -> BLOCKED, exit 2', () => {
  const r = run(['not-a-command'], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
});

test('webdriverio not installed -> BLOCKED, exit 2, with install hint', () => {
  const r = run(['create-session', '--caps-file', 'caps.json'], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
  assert.match(r.json.reason, /webdriverio/);
});

// Fake a resolvable "webdriverio" so we can reach the flag-validation branches below it.
const fakeModulesDir = path.join(bareCwd, 'node_modules', 'webdriverio');
fs.mkdirSync(fakeModulesDir, { recursive: true });
fs.writeFileSync(path.join(fakeModulesDir, 'package.json'), JSON.stringify({ name: 'webdriverio', main: 'index.js' }));
fs.writeFileSync(path.join(fakeModulesDir, 'index.js'), 'module.exports = { remote: async () => { throw new Error("no server"); }, attach: async () => { throw new Error("no server"); } };');

test('create-session missing --caps-file -> BLOCKED, exit 2', () => {
  const r = run(['create-session'], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
});

test('create-session with missing caps file path -> BLOCKED, exit 2', () => {
  const r = run(['create-session', '--caps-file', 'does-not-exist.json'], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
  assert.match(r.json.reason, /not found/);
});

test('create-session with invalid JSON caps file -> BLOCKED, exit 2', () => {
  const badCaps = path.join(bareCwd, 'bad-caps.json');
  fs.writeFileSync(badCaps, '{ not valid json');
  const r = run(['create-session', '--caps-file', badCaps], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
  assert.match(r.json.reason, /invalid JSON/);
});

test('find missing --session -> BLOCKED, exit 2', () => {
  const r = run(['find', '--using', 'accessibility id', '--value', 'x'], bareCwd);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.json.result, 'BLOCKED');
});

console.log(`\n${passed} passed`);
fs.rmSync(bareCwd, { recursive: true, force: true });
