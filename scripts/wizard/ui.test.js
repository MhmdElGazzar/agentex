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
  get userFieldsV(){return userFieldsSession}, get defaultsFieldsV(){return defaultsFieldsSession},
  get removedUserFieldsV(){return removedUserFields}, get removedDefaultsFieldsV(){return removedDefaultsFields},
  set existingProjectV(v){existingProject=v},
  createEnv, switchEnv, renameSessionEnv, currentDefaultName, deriveRenames,
  buildEnvConfig, buildUsersObj, buildSecretsPayload, snapshotActiveEnv, envNameProblem,
  markActiveEnvDirty, dirtyEnvNames, envVarSuffix, buildProjectConfig,
  addField, renameField, removeField, toggleFieldSecret, fieldKeyProblem,
  deriveUserFieldRenames, deriveDefaultsFieldRenames, userFieldDropKeys, defaultsFieldDropKeys,
  userFieldBlastRadius, defaultsFieldBlastRadius, envScopedKeys,
  fieldAddShapeConflict, renameOntoConflicts, renameFieldAdopting,
  get overwrittenUserKeysV(){return overwrittenUserKeys}, get overwrittenDefaultsKeysV(){return overwrittenDefaultsKeys},
  get builtinUserFields(){return BUILTIN_USER_FIELDS}, get builtinDefaultsFields(){return BUILTIN_DEFAULTS_FIELDS},
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

  // ── Consumer-owned field schema (wizard design #4) ────────────────────────
  test('the field schema boots from the built-ins when the project carries none', () => {
    assert.deepStrictEqual(ui.userFieldsV.map(f => f.key), ['phone', 'email', 'role', 'notes']);
    assert.deepStrictEqual(ui.defaultsFieldsV.map(f => f.key), ['password', 'otp']);
    assert.ok(ui.userFieldsV.every(f => f._orig === f.key), 'built-ins count as on-disk keys for rename bookkeeping');
  });

  test('fieldKeyProblem mirrors the engine rules, in Arabic', () => {
    assert.ok(ui.fieldKeyProblem('user', '1bad'), 'bad pattern rejected');
    assert.ok(ui.fieldKeyProblem('user', 'handle').includes('محجوز'), 'handle is reserved');
    assert.ok(ui.fieldKeyProblem('user', 'role'), 'duplicate key rejected');
    assert.strictEqual(ui.fieldKeyProblem('user', 'national_id'), null, 'a free valid key is allowed');
    assert.strictEqual(ui.fieldKeyProblem('user', 'role', 'role'), null, 'a rename onto its own key is a no-op, not a duplicate');
  });

  test('secret user field: JSON carries { envSecret }, the value goes only to the secrets payload', () => {
    ui.addField('user', { key: 'apiKey', label: 'API Key', secret: true });
    ui.users[0].apiKey = 'USER_VALID_USER_APIKEY_P';           // env-var NAME slot
    ui.users[0]._secrets = { apiKey: 'tok-user-secret-9' };    // typed VALUE (session only)
    ui.markActiveEnvDirty();
    ui.snapshotActiveEnv();
    const built = ui.buildEnvConfig('prod');
    assert.deepStrictEqual(built.users.valid_user.apiKey, { envSecret: 'USER_VALID_USER_APIKEY_P' });
    assert.ok(!JSON.stringify(built).includes('tok-user-secret-9'), 'the value never lands in the JSON');
    const payload = ui.buildSecretsPayload();
    assert.strictEqual(payload['USER_VALID_USER_APIKEY_P'], 'tok-user-secret-9');
  });

  test('secret user field without a typed name falls back to the USER_<HANDLE>_<KEY> prefill', () => {
    ui.envs['uat'].users[0]._secrets = { apiKey: 'tok-uat-7' };   // name slot left empty
    const payload = ui.buildSecretsPayload();
    assert.strictEqual(payload['USER_VALID_USER_APIKEY'], 'tok-uat-7',
      'the owner-confirmed prefill convention names the .env key');
    delete ui.envs['uat'].users[0]._secrets;
  });

  test('renaming a field migrates the key in EVERY session environment and dirties them all', () => {
    assert.strictEqual(ui.envs['uat'].users[0].phone, '0551112223', 'value sits under the old key before');
    ui.renameField('user', 'phone', 'userId', 'User ID');
    assert.deepStrictEqual(ui.deriveUserFieldRenames(), [{ from: 'phone', to: 'userId' }]);
    assert.ok(ui.userFieldDropKeys().includes('phone'), 'the old key is dropped from every on-disk base');
    for (const n of ['prod', 'uat']) {
      assert.strictEqual(ui.envs[n].users[0].userId, '0551112223', `${n}: value migrated to the new key`);
      assert.ok(!('phone' in ui.envs[n].users[0]), `${n}: old key gone from the session`);
    }
    assert.deepStrictEqual([...ui.dirtyEnvNames()].sort(), ['prod', 'uat'],
      'a rename rides the save-all path — every environment file is rewritten');
    const built = ui.buildEnvConfig('prod');
    assert.strictEqual(built.users.valid_user.userId, '0551112223');
    assert.ok(!('phone' in built.users.valid_user),
      'the renamed-away key leaves the file — the ONE exception to unknown-prop preservation');
    assert.strictEqual(built.users.valid_user.apiKeyRef, 'hand-added', 'other unknown props still survive (invariant #11)');
  });

  test('removing a field records its blast radius and clears its values (consented op)', () => {
    ui.users[0].email = 'x@y.example';
    ui.markActiveEnvDirty();
    assert.deepStrictEqual(ui.userFieldBlastRadius('email'), ['prod'], 'blast radius names the affected environments');
    ui.removeField('user', 'email');
    assert.ok(!ui.userFieldsV.some(f => f.key === 'email'));
    assert.deepStrictEqual(ui.removedUserFieldsV.map(x => ({ key: x.key, envs: x.envs })),
      [{ key: 'email', envs: ['prod'] }]);
    assert.ok(ui.userFieldDropKeys().includes('email'));
    assert.ok(!('email' in ui.users[0]), 'session values under the removed field are gone');
  });

  test('defaults field rename migrates the per-environment answer keys and the base key', () => {
    ui.setLoadedFrom('prod', {
      portalUrl: 'https://old.example', customTop: 'kept',
      defaults: { locale: 'ar', otp: '0000' },
      users: { valid_user: { userId: '0', apiKeyRef: 'hand-added' } },
    });
    ui.renameField('defaults', 'otp', 'pin', 'PIN');
    assert.deepStrictEqual(ui.deriveDefaultsFieldRenames(), [{ from: 'otp', to: 'pin' }]);
    assert.strictEqual(ui.answers['defaults.pin'], '9999', 'active environment answer key migrated');
    assert.strictEqual(ui.envs['uat'].answers['defaults.pin'], '9999', 'every environment migrated');
    ui.snapshotActiveEnv();
    const built = ui.buildEnvConfig('prod');
    assert.strictEqual(built.defaults.pin, '9999');
    assert.ok(!('otp' in built.defaults), 'the renamed-away defaults key leaves the file');
    assert.strictEqual(built.defaults.locale, 'ar', 'unknown defaults keys still survive');
  });

  test('buildProjectConfig always writes the effective arrays, stripped of session bookkeeping', () => {
    const proj = ui.buildProjectConfig();
    assert.deepStrictEqual(proj.userFields.map(f => f.key), ['userId', 'role', 'notes', 'apiKey']);
    assert.deepStrictEqual(proj.defaultsFields.map(f => f.key), ['password', 'pin']);
    assert.ok(proj.userFields.every(f => !('_orig' in f)), 'session bookkeeping never reaches the file');
  });

  test('envScopedKeys follows the defaults schema (a custom key is snapshot/restore-scoped)', () => {
    assert.ok(ui.envScopedKeys().includes('defaults.pin'));
    assert.ok(!ui.envScopedKeys().includes('defaults.otp'), 'the renamed-away key is no longer scoped');
  });

  // ── Collision adoption (re-gate defect 1, invariant #11) ──────────────────
  // The flagship first-run journey: a team that hand-edited environment files
  // adopts those keys into the schema — the wizard must adopt the values, and
  // silent loss must be impossible on every collision path.
  test('ADD-collision adopts hand-added user values from disk (national_id probe)', () => {
    ui.setLoadedFrom('prod', {
      portalUrl: 'https://old.example', customTop: 'kept',
      defaults: { locale: 'ar' },
      users: {
        valid_user: { userId: '0', apiKeyRef: 'hand-added', national_id: '1234567890' },
        expired_user: {},
      },
    });
    const adopted = ui.addField('user', { key: 'national_id', label: 'الرقم القومي' });
    assert.strictEqual(adopted, true, 'addField reports the adoption');
    assert.strictEqual(ui.users[0].national_id, '1234567890', 'the active form prefills from the disk value');
    assert.strictEqual(ui.envs['prod'].users[0].national_id, '1234567890');
    assert.ok(!ui.envs['uat'].users[0].national_id, 'no disk value elsewhere — that slot stays empty');
    ui.snapshotActiveEnv();
    assert.strictEqual(ui.buildEnvConfig('prod').users.valid_user.national_id, '1234567890',
      'the hand-added value survives the save instead of being screen-wins deleted');
  });

  test('ADD-collision adopts hand-added defaults values from disk (locale probe)', () => {
    const adopted = ui.addField('defaults', { key: 'locale', label: 'اللغة' });
    assert.strictEqual(adopted, true);
    assert.strictEqual(ui.answers['defaults.locale'], 'ar', 'the active form prefills from the disk value');
    assert.strictEqual(ui.envs['prod'].answers['defaults.locale'], 'ar');
    ui.snapshotActiveEnv();
    assert.strictEqual(ui.buildEnvConfig('prod').defaults.locale, 'ar', 'now managed AND preserved');
  });

  test('ADD-collision with a shape mismatch is refused with guidance — never silent loss', () => {
    ui.setLoadedFrom('prod', {
      portalUrl: 'https://old.example', customTop: 'kept',
      defaults: { locale: 'ar' },
      users: {
        valid_user: { userId: '0', apiKeyRef: 'hand-added', national_id: '1234567890',
                      secretRef: { envSecret: 'X_REF' }, meta: { nested: true } },
        expired_user: { legacy_id: 'OLD-EXP' },
      },
    });
    assert.ok(ui.fieldAddShapeConflict('user', 'secretRef', false),
      'a plaintext field over an envSecret-shaped prop is refused (the ref must not silently die)');
    assert.ok(ui.fieldAddShapeConflict('user', 'meta', false),
      'an object prop cannot become a field — refused, hands off');
    assert.ok(ui.fieldAddShapeConflict('user', 'legacy_id', true),
      'a secret field over plaintext values is refused (values must not silently die)');
    assert.strictEqual(ui.fieldAddShapeConflict('user', 'secretRef', true), null,
      'secret over envSecret-shaped is the matching shape — adoptable');
    const adopted = ui.addField('user', { key: 'secretRef', label: 'S', secret: true });
    assert.strictEqual(adopted, true);
    assert.strictEqual(ui.envs['prod'].users[0].secretRef, 'X_REF', 'the env-var NAME is adopted into the name slot');
    ui.snapshotActiveEnv();
    assert.deepStrictEqual(ui.buildEnvConfig('prod').users.valid_user.secretRef, { envSecret: 'X_REF' });
  });

  test('RENAME-onto a hand-added key with a DIFFERING value needs consent; empty slots adopt', () => {
    ui.setLoadedFrom('prod', {
      portalUrl: 'https://old.example', customTop: 'kept',
      defaults: { locale: 'ar' },
      users: {
        valid_user: { userId: '0', apiKeyRef: 'hand-added', legacy_id: 'OLD-9' },
        expired_user: { legacy_id: 'OLD-EXP' },
      },
    });
    assert.deepStrictEqual(ui.renameOntoConflicts('user', 'userId', 'legacy_id'), ['prod'],
      'the differing hand-added value is a conflict — the silent path is closed');
    // The consent dialog's confirm action:
    ui.renameFieldAdopting('user', 'userId', 'legacy_id', 'Legacy ID');
    assert.deepStrictEqual(ui.overwrittenUserKeysV, [{ key: 'legacy_id', envs: ['prod'] }],
      'the consented overwrite is recorded for the review ops list');
    assert.strictEqual(ui.envs['prod'].users[0].legacy_id, '0551112223', 'screen value wins after consent');
    assert.strictEqual(ui.envs['prod'].users[1].legacy_id, 'OLD-EXP',
      'an EMPTY migrated slot adopts the hand-added value instead of deleting it');
    ui.snapshotActiveEnv();
    const built = ui.buildEnvConfig('prod');
    assert.strictEqual(built.users.valid_user.legacy_id, '0551112223');
    assert.strictEqual(built.users.expired_user.legacy_id, 'OLD-EXP');
    assert.deepStrictEqual(ui.deriveUserFieldRenames(), [{ from: 'phone', to: 'legacy_id' }],
      'rename bookkeeping still chains from the original disk key');
  });

  test('re-adding a removed key cancels its pending removal and re-adopts', () => {
    assert.deepStrictEqual(ui.removedUserFieldsV.map(x => x.key), ['email'], 'email removal pending');
    ui.addField('user', { key: 'email', label: 'Email', type: 'email' });
    assert.deepStrictEqual(ui.removedUserFieldsV, [], 'the pending removal is cancelled');
    assert.ok(!ui.userFieldDropKeys().includes('email'), 'the base key is no longer dropped');
  });

  test('the ui built-in field arrays are deep-equal to the engine ones (labels/hints included)', () => {
    const engine = require('./engine.js');
    assert.deepStrictEqual(ui.builtinUserFields, engine.BUILTIN_USER_FIELDS,
      'key-list equality is not enough — labels/hints/placeholders must not drift');
    assert.deepStrictEqual(ui.builtinDefaultsFields, engine.BUILTIN_DEFAULTS_FIELDS);
  });

  // ── Static copy checks ────────────────────────────────────────────────────
  test('review ops list spells مؤكّدة/مؤكّد correctly (الهمزة على واو بعد ضمة)', () => {
    assert.ok(html.includes('مؤكّدة'), 'إعادة تسمية مؤكّدة');
    assert.ok(html.includes('مؤكّد'), 'حذف مؤكّد');
    assert.ok(!html.includes('مأكّد'), 'the misspelled form must not appear anywhere');
  });

  test('field editor copy: the affordance exists and teaches the shared-schema model', () => {
    assert.ok(html.includes('تعديل الحقول'), 'the field-set editor affordance is present');
    assert.ok(html.includes('مشتركة بين كل البيئات'), 'the copy says the schema is shared across environments');
    assert.ok(!html.includes('هتتقري') && !html.includes('بتتقري'), 'المبني للمجهول من "قرا" آخره ألف');
  });

  test('tanween sits on the pre-alif letter — the flagged wrong forms are gone', () => {
    assert.ok(!html.includes('سراً') && !html.includes('حقيقياً'),
      'ليست سرًّا حقيقيًا — التنوين على الحرف قبل الألف، مش على الألف');
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
}, 50);
