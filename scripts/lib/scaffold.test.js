'use strict';
// Unit tests for the shared scaffold library. Run: node scripts/lib/scaffold.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scaffold = require('./scaffold.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// Fresh throwaway project dir per test, with optional files.
function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-sc-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

const readJson = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
const TEMPLATE_ENV = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'environments', 'qc.json'), 'utf8'));

// ---- hasEnvFiles ----
test('hasEnvFiles: false without environments/, false for non-json content, true for any env json', () => {
  assert.strictEqual(scaffold.hasEnvFiles(proj()), false);
  assert.strictEqual(scaffold.hasEnvFiles(proj({ 'environments/notes.txt': 'x' })), false);
  assert.strictEqual(scaffold.hasEnvFiles(proj({ 'environments/uat.json': {} })), true);
  assert.strictEqual(scaffold.hasEnvFiles(proj({ 'environments/qc.json': {} })), true);
});

// ---- conditional sample copy ----
test('fresh scaffold creates the sample environment under the default name qc', () => {
  const dir = proj();
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  assert.deepStrictEqual(readJson(dir, 'environments/qc.json'), TEMPLATE_ENV);
});

test('sample environment is NOT copied when any environment file already exists', () => {
  const dir = proj({ 'environments/uat.json': { portalUrl: 'https://uat.example' } });
  const actions = scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  assert.ok(!fs.existsSync(path.join(dir, 'environments', 'qc.json')),
    'sample must not be injected next to an existing environment');
  const skip = actions.find(a => a.path === 'environments' && a.kind === 'skipped');
  assert.ok(skip, 'the decision is reported as a skipped action');
});

test('re-run after a wizard save under another name does not re-inject the sample', () => {
  const dir = proj();
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  // wizard saved "uat" and the pristine sample was reconciled away
  fs.writeFileSync(path.join(dir, 'environments', 'uat.json'), '{"portalUrl":"https://uat.example"}');
  fs.unlinkSync(path.join(dir, 'environments', 'qc.json'));
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  assert.ok(!fs.existsSync(path.join(dir, 'environments', 'qc.json')),
    're-scaffold must not resurrect the sample');
});

test('dryRun reports the sample copy without writing anything', () => {
  const dir = proj();
  const actions = scaffold.scaffoldProject(dir, PLUGIN_ROOT, { dryRun: true });
  assert.ok(actions.some(a => a.kind === 'created' && a.path === 'environments/qc.json'));
  assert.ok(!fs.existsSync(path.join(dir, 'environments')), 'dryRun must not write');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
