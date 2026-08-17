'use strict';
// Tests for ui.html's session-store logic. The wizard UI is a single static
// file with no build step, so its <script> runs here under minimal DOM stubs —
// no browser, no dependencies. This pins the multi-environment behaviors the
// HTTP tests cannot see: session isolation, copy-on-create safety, rename/
// delete bookkeeping (deriveRenames / pendingDeletes — the exact site of the
// chained-rename defect), name-entry guards, and the invariant-#11 merges.
// Run: node scripts/wizard/ui.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const html = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

// ── Minimal DOM/browser stubs — just enough for the script to boot ────────
const elStub = () => ({
  innerHTML: '', textContent: '', style: {}, value: '',
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {},
  querySelector() { return elStub(); }, querySelectorAll() { return []; },
  onclick: null, oninput: null, onchange: null, focus() {},
});
global.window = { WIZARD_MODE: 'web', WIZARD_SCHEMA: require('./schema.json'), scrollTo() {} };
global.document = {
  getElementById: () => elStub(),
  createElement: () => elStub(),
  querySelectorAll: () => [],
  body: elStub(),
};
Object.defineProperty(global, 'navigator', {
  value: { clipboard: { writeText: () => Promise.resolve() } }, configurable: true,
});
global.alert = () => {};
global.fetch = () => Promise.reject(new Error('no network in tests'));

// Evaluate the UI script and expose live views of its bindings.
const ui = new Function(script + `
;return {
  get envs(){return envs}, get envOrder(){return envOrder}, get activeEnv(){return activeEnv},
  get answers(){return answers}, get users(){return users}, get pendingDeletes(){return pendingDeletes},
  set existingProjectV(v){existingProject=v},
  createEnv, switchEnv, renameSessionEnv, currentDefaultName, deriveRenames,
  buildEnvConfig, buildUsersObj, buildSecretsPayload, snapshotActiveEnv, envNameProblem,
  markActiveEnvDirty, dirtyEnvNames, envVarSuffix, buildProjectConfig,
  setEnvDisk: (name, diskName) => { envs[name].existsOnDisk = true; envs[name].diskName = diskName; envs[name].dirty = false; },
  setLoadedFrom: (name, v) => { envs[name].loadedFrom = v; },
};`)();

// init() is async (web mode: no network) — assert after it settles.
setTimeout(() => {

  test('web-mode init seeds one fresh environment under the default name', () => {
    assert.strictEqual(ui.activeEnv, 'qc');
    assert.deepStrictEqual(ui.envOrder, ['qc']);
    assert.strictEqual(ui.answers['envName'], 'qc');
  });

  // Working values for the seeded environment.
  ui.answers['portalUrl'] = 'https://qc.example';
  ui.answers['defaults.otp'] = '9999';
  ui.users[0].phone = '0551112223';
  ui.markActiveEnvDirty();

  test('copy-on-create copies SAFE sections only — never a connection target', () => {
    ui.createEnv('uat', { copyFrom: 'qc', copyUsers: true, copyDefaults: true });
    const uat = ui.envs['uat'];
    assert.strictEqual(uat.answers['defaults.otp'], '9999', 'defaults VALUES copied');
    assert.strictEqual(uat.users[0].phone, '0551112223', 'user VALUES copied');
    assert.strictEqual(uat.answers['portalUrl'], undefined, 'portalUrl NEVER copied');
    assert.strictEqual(uat.answers['db.server'], undefined, 'db NEVER copied');
    assert.strictEqual(uat.answers['api.baseUrl'], undefined, 'api NEVER copied');
  });

  test('switching environments isolates and restores the working set', () => {
    ui.switchEnv('uat');
    assert.strictEqual(ui.answers['portalUrl'], undefined, 'new env inherits no connection target');
    assert.strictEqual(ui.answers['envName'], 'uat');
    ui.answers['portalUrl'] = 'https://uat.example';
    ui.markActiveEnvDirty();
    ui.switchEnv('qc');
    assert.strictEqual(ui.answers['portalUrl'], 'https://qc.example', 'switch restores session values');
  });

  test('rename bookkeeping: op derives from diskName, default follows, rename-back cancels', () => {
    ui.setEnvDisk('qc', 'qc');
    ui.existingProjectV = { name: 'p', defaultEnvironment: 'qc' };
    ui.renameSessionEnv('qc', 'prod');
    assert.deepStrictEqual(ui.deriveRenames(), [{ from: 'qc', to: 'prod', confirmed: true }]);
    assert.strictEqual(ui.currentDefaultName(), 'prod', 'default follows the rename');
    assert.strictEqual(ui.buildProjectConfig().defaultEnvironment, 'prod');
    ui.renameSessionEnv('prod', 'qc');
    assert.deepStrictEqual(ui.deriveRenames(), [], 'renaming back cancels the op');
    ui.renameSessionEnv('qc', 'prod');
  });

  test('a disk name vacated by a session rename is BLOCKED for add and rename', () => {
    // prod's file is still on disk as qc.json until the save executes. Adding
    // or renaming another environment to "qc" would chain/overwrite renames —
    // the data-destruction path. envNameProblem must refuse it, in Arabic.
    const problem = ui.envNameProblem('qc');
    assert.ok(problem, 'the vacated disk name must be refused');
    assert.ok(problem.includes('موجود على القرص'), `Arabic entry-time message expected, got: ${problem}`);
    // The one exception: renaming the SAME env back to its own disk name —
    // that cancels its pending rename instead of chaining.
    assert.strictEqual(ui.envNameProblem('qc', { self: 'prod' }), null, 'rename-back stays allowed');
    // A genuinely free name stays allowed.
    assert.strictEqual(ui.envNameProblem('stage'), null);
  });

  test('a name pending deletion is blocked until the save lands', () => {
    ui.pendingDeletes.push('olddisk');
    assert.ok(ui.envNameProblem('olddisk'));
    ui.pendingDeletes.pop();
  });

  test('name validation mirrors design #1 rules', () => {
    assert.ok(ui.envNameProblem('UAT'), 'uppercase rejected');
    assert.ok(ui.envNameProblem('uat'), 'existing session name rejected');
    assert.ok(ui.envNameProblem('../evil'), 'path escape rejected');
  });

  test('buildEnvConfig merges onto the on-disk base — unknown props survive (invariant #11)', () => {
    ui.setLoadedFrom('prod', {
      portalUrl: 'https://old.example', customTop: 'kept',
      defaults: { locale: 'ar' },
      users: { valid_user: { phone: '0', apiKeyRef: 'hand-added' } },
    });
    ui.snapshotActiveEnv();
    const built = ui.buildEnvConfig('prod');
    assert.strictEqual(built.customTop, 'kept', 'env-level unknown keys survive');
    assert.strictEqual(built.defaults.locale, 'ar', 'defaults unknown keys survive');
    assert.strictEqual(built.users.valid_user.apiKeyRef, 'hand-added', 'per-user unknown props survive');
    assert.strictEqual(built.users.valid_user.phone, '0551112223', 'screen wins for managed fields');
    assert.strictEqual(built.portalUrl, 'https://qc.example');
  });

  test('env-scoped secrets keep separate per-environment slots via envKeyFrom', () => {
    ui.envs['prod'].secrets['api.token'] = 'tok-A';
    ui.envs['prod'].answers['api.tokenEnvVar'] = 'API_TOKEN';
    ui.envs['uat'].secrets['api.token'] = 'tok-B';
    ui.envs['uat'].answers['api.tokenEnvVar'] = 'API_TOKEN_UAT';
    const out = ui.buildSecretsPayload();
    assert.strictEqual(out['API_TOKEN'], 'tok-A');
    assert.strictEqual(out['API_TOKEN_UAT'], 'tok-B');
  });

  test('suffix helper produces a valid env-var fragment from any environment name', () => {
    assert.strictEqual(ui.envVarSuffix('my-env'), 'MY_ENV');
    assert.strictEqual(ui.envVarSuffix('uat2'), 'UAT2');
  });

  test('dirty accounting: a renamed-but-unedited on-disk env is NOT rewritten (pure rename)', () => {
    // prod was set clean by setEnvDisk and only renamed since.
    assert.deepStrictEqual([...ui.dirtyEnvNames()].sort(), ['uat'].sort());
    ui.markActiveEnvDirty();   // simulate the input listener
    assert.deepStrictEqual([...ui.dirtyEnvNames()].sort(), ['prod', 'uat']);
  });

  // ── Static copy checks ────────────────────────────────────────────────────
  test('review ops list spells مؤكّدة/مؤكّد correctly (الهمزة على واو بعد ضمة)', () => {
    assert.ok(html.includes('مؤكّدة'), 'إعادة تسمية مؤكّدة');
    assert.ok(html.includes('مؤكّد'), 'حذف مؤكّد');
    assert.ok(!html.includes('مأكّد'), 'the misspelled form must not appear anywhere');
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
}, 50);
