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

// ---- pristine sample-environment detection ----
// The shape the qa-era scaffold shipped (plugin <= 0.16.x, templates/environments/qa.json).
const QA_ERA_SAMPLE = {
  portalUrl: 'https://example.com',
  defaults: { otp: '0000', password: 'Test@1234' },
  users: {
    valid_user: { phone: '0550000001', role: 'customer' },
    expired_user: { phone: '0550000002', notes: 'for negative login scenarios' },
  },
  db: {
    server: 'localhost', port: 1433, name: 'my-database', user: 'qa_user',
    password: { envSecret: 'SQLCMDPASSWORD' },
  },
  api: { baseUrl: 'https://jsonplaceholder.typicode.com', token: { envSecret: 'API_TOKEN' } },
};

test('isPristineSampleEnv: current template and the historical qa-era shape are pristine', () => {
  assert.strictEqual(scaffold.isPristineSampleEnv(TEMPLATE_ENV, PLUGIN_ROOT), true);
  assert.strictEqual(scaffold.isPristineSampleEnv(QA_ERA_SAMPLE, PLUGIN_ROOT), true);
});

test('isPristineSampleEnv: structural comparison — key order and whitespace do not matter', () => {
  const reordered = JSON.parse(JSON.stringify({
    api: TEMPLATE_ENV.api, db: TEMPLATE_ENV.db, users: TEMPLATE_ENV.users,
    defaults: TEMPLATE_ENV.defaults, portalUrl: TEMPLATE_ENV.portalUrl,
  }));
  assert.strictEqual(scaffold.isPristineSampleEnv(reordered, PLUGIN_ROOT), true);
});

test('isPristineSampleEnv: any user-touched value means NOT pristine', () => {
  const touched = JSON.parse(JSON.stringify(TEMPLATE_ENV));
  touched.portalUrl = 'https://my-real-app.example';
  assert.strictEqual(scaffold.isPristineSampleEnv(touched, PLUGIN_ROOT), false);
  const extraKey = JSON.parse(JSON.stringify(TEMPLATE_ENV));
  extraKey.users.new_user = { phone: '0550000003' };
  assert.strictEqual(scaffold.isPristineSampleEnv(extraKey, PLUGIN_ROOT), false);
  const removedKey = JSON.parse(JSON.stringify(TEMPLATE_ENV));
  delete removedKey.db;
  assert.strictEqual(scaffold.isPristineSampleEnv(removedKey, PLUGIN_ROOT), false);
});

test('isPristineSampleEnv: null / non-object input is never pristine', () => {
  assert.strictEqual(scaffold.isPristineSampleEnv(null, PLUGIN_ROOT), false);
  assert.strictEqual(scaffold.isPristineSampleEnv('a string', PLUGIN_ROOT), false);
  assert.strictEqual(scaffold.isPristineSampleEnv(42, PLUGIN_ROOT), false);
});

test('sampleEnvShapes covers the current template plus every shipped revision', () => {
  const shapes = scaffold.sampleEnvShapes(PLUGIN_ROOT);
  assert.ok(shapes.length >= 1);
  assert.ok(shapes.some(s => { try { assert.deepStrictEqual(s, TEMPLATE_ENV); return true; } catch { return false; } }),
    'current template included');
});

// ---- the QA watchlist (skill-consolidation-foundation R6) ----
// The QA-record files hold user decisions: they are committed, so no scaffolded
// ignore entry may cover them, and they are created lazily by qa-records.js —
// never by the scaffold. The paths come from the one constant.
const { STRUCTURED_DEFAULTS } = require('./project_config.js');
const QA_PATHS = Object.values(STRUCTURED_DEFAULTS.qaRecords);

test('the scaffolded .gitignore covers none of the default QA watchlist paths (git check-ignore)', () => {
  const { spawnSync } = require('node:child_process'); // test-side only
  const dir = proj();
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.ok(gi.includes('.env'), 'the scaffold wrote its ignore block');
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (init.status !== 0) { console.log('    (skipped: git unavailable)'); return; }
  const folder = `${path.posix.dirname(QA_PATHS[0])}/`;
  for (const p of [...QA_PATHS, folder]) {
    const r = spawnSync('git', ['check-ignore', '--no-index', '-v', p], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(r.status, 1, `${p} is ignored by: ${r.stdout.trim()}`);
  }
  for (const e of scaffold.gitignoreMissing(proj())) {
    for (const p of QA_PATHS) assert.ok(!p.startsWith(e.entry.replace(/^\//, '')), `${e.entry} would cover ${p}`);
  }
});

test('the scaffold creates no QA watchlist file or folder (they are created lazily on first append)', () => {
  const dir = proj();
  const actions = scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  for (const p of QA_PATHS) assert.ok(!fs.existsSync(path.join(dir, p)), `${p} must not be scaffolded`);
  assert.ok(!fs.existsSync(path.join(dir, path.dirname(QA_PATHS[0]))), 'nor its folder');
  assert.ok(!actions.some((a) => QA_PATHS.some((p) => a.path.startsWith(path.posix.dirname(p)))));
});

test('the scaffolded config/project.json carries the four plugin blocks, equal to STRUCTURED_DEFAULTS; no provider block', () => {
  const dir = proj();
  scaffold.scaffoldProject(dir, PLUGIN_ROOT);
  const cfg = readJson(dir, 'config/project.json');
  for (const k of ['testingTasks', 'testDesign', 'estimation', 'qaRecords']) {
    assert.deepStrictEqual(cfg[k], STRUCTURED_DEFAULTS[k], `${k} equals the default`);
  }
  assert.ok(!('azure' in cfg) && !('jira' in cfg), 'the template carries no provider block (the wizard writes the chosen one)');
  assert.ok(!('workflow' in cfg) && !('reproSummaryRow' in cfg), 'provider-block keys are never top-level');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
