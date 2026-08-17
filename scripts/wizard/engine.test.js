'use strict';
// Tests for the wizard engine — extraction, validation, config building.
// Run: node scripts/wizard/engine.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { extractFromText, validateConfigs, buildConfigs, mergeExtracted, validate, DEFAULT_ENV_NAME,
        planSave, buildEnvUsers } = require('./engine.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// ── DEFAULT_ENV_NAME: one shared default, consistent on every surface ─────
test('DEFAULT_ENV_NAME is "qc" and every declared default agrees with it', () => {
  assert.strictEqual(DEFAULT_ENV_NAME, 'qc');
  // engine fallback
  assert.strictEqual(buildConfigs({ name: 'd' }, []).envName, DEFAULT_ENV_NAME);
  // wizard schema default + placeholder
  const schema = require('./schema.json');
  const field = schema.steps.flatMap(s => s.fields || []).find(f => f.key === 'envName');
  assert.strictEqual(field.default, DEFAULT_ENV_NAME, 'schema default');
  assert.strictEqual(field.placeholder, DEFAULT_ENV_NAME, 'schema placeholder');
  // shipped templates: project default + the sample file's own name
  const projTemplate = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'templates', 'config', 'project.json'), 'utf8'));
  assert.strictEqual(projTemplate.defaultEnvironment, DEFAULT_ENV_NAME, 'project template default');
  assert.ok(fs.existsSync(
    path.join(__dirname, '..', '..', 'templates', 'environments', `${DEFAULT_ENV_NAME}.json`)),
    'sample environment template carries the default name');
});

// ── extractFromText: .env source ──────────────────────────────────────────
test('extracts an old .env into answer keys', () => {
  const r = extractFromText([
    '# AgenTeX — environment configuration',
    'QA_TARGET_URL=https://travel-qc.example.com/ar',
    'AZURE_URL=https://dev.azure.com/acme/',
    'AZURE_PROJECT=Travel Insurance',
    "DB_SERVER='uat-db02.local'",
    'DB_PORT=1434',
    'DB_NAME=TravelQC',
    'DB_USER=qa.runner',
    'API_BASE_URL=https://api-qc.example.com',
    'KB_PROJECT=travel-kb',
    'AZURE_PAT=super-secret-value',
    'SQLCMDPASSWORD=another-secret',
  ].join('\n'));
  assert.strictEqual(r.portalUrl, 'https://travel-qc.example.com/ar');
  assert.strictEqual(r['azure.org'], 'https://dev.azure.com/acme/');
  assert.strictEqual(r['azure.project'], 'Travel Insurance');
  assert.strictEqual(r['db.server'], 'uat-db02.local');   // quotes stripped
  assert.strictEqual(r['db.port'], '1434');
  assert.strictEqual(r['db.name'], 'TravelQC');
  assert.strictEqual(r['db.user'], 'qa.runner');
  assert.strictEqual(r['api.baseUrl'], 'https://api-qc.example.com');
  assert.strictEqual(r['kb.project'], 'travel-kb');
});

test('never extracts secrets', () => {
  const r = extractFromText('AZURE_PAT=pat-123\nSQLCMDPASSWORD=pw-123\nAPI_TOKEN=tok-123\nPASSWORD=hunter2');
  const values = JSON.stringify(r);
  for (const secret of ['pat-123', 'pw-123', 'tok-123', 'hunter2']) {
    assert.ok(!values.includes(secret), `secret ${secret} must not be extracted`);
  }
});

// ── extractFromText: prose source (Arabic + English) ──────────────────────
test('extracts Arabic prose with grouped lines', () => {
  const r = extractFromText([
    'اسم المشروع: shop-portal',
    'الرابط: https://qa.shop-portal.local',
    'Azure Org: https://dev.azure.com/shopco, Project: ShopPortal',
    'مستخدمون: valid_user (0551110001), expired_user (0551110002)',
    'DB: server=shop-db.local, name=ShopQC, user=shop_qa',
    'API: https://qa-api.shop-portal.local',
  ].join('\n'));
  assert.strictEqual(r.name, 'shop-portal');
  assert.strictEqual(r.portalUrl, 'https://qa.shop-portal.local');
  assert.strictEqual(r['azure.org'], 'https://dev.azure.com/shopco');
  assert.strictEqual(r['azure.project'], 'ShopPortal');
  assert.strictEqual(r['db.server'], 'shop-db.local');
  assert.strictEqual(r['db.name'], 'ShopQC');
  assert.strictEqual(r['db.user'], 'shop_qa');
  assert.strictEqual(r['api.baseUrl'], 'https://qa-api.shop-portal.local');
  assert.deepStrictEqual(r.users, [
    { handle: 'valid_user', phone: '0551110001' },
    { handle: 'expired_user', phone: '0551110002' },
  ]);
});

test('extracts users written with emails, ignores non-user parentheses', () => {
  const r = extractFromText('admin_user (qa.admin@example.com)\nthe portal (very fast) is live');
  assert.deepStrictEqual(r.users, [{ handle: 'admin_user', email: 'qa.admin@example.com' }]);
});

test('empty or unrecognised text yields no invented values', () => {
  assert.deepStrictEqual(extractFromText(''), {});
  assert.deepStrictEqual(extractFromText('just some prose with no settings at all'), {});
});

test('validate enforces field patterns, and the schema declares them where it matters', () => {
  const steps = [{ id: 's', fields: [
    { key: 'envName', label: 'env', pattern: '^[a-z0-9][a-z0-9_-]{0,30}$' },
  ]}];
  assert.deepStrictEqual(validate({ envName: 'qa' }, steps), []);
  assert.match(validate({ envName: 'QA App!!' }, steps).join(), /env/);

  const schema = require('./schema.json');
  const fields = schema.steps.flatMap(s => s.fields || []);
  for (const key of ['envName', 'db.passwordEnvVar', 'api.tokenEnvVar']) {
    const f = fields.find(x => x.key === key);
    assert.ok(f && f.pattern, `${key} must declare a pattern (garbage was only rejected at save, in English)`);
    assert.ok(f.patternMsg, `${key} must carry a localized pattern message`);
  }
});

// ── mergeExtracted ────────────────────────────────────────────────────────
test('mergeExtracted merges users by handle — never replaces the list', () => {
  const answers = { users: [
    { handle: 'valid_user', phone: '0550000001' },
    { handle: 'admin_user', role: 'admin' },
  ]};
  const merged = mergeExtracted(answers, { users: [
    { handle: 'admin_user', phone: '0559990009', role: 'super' },
    { handle: 'import_user', phone: '0559990001' },
  ]});
  assert.deepStrictEqual(merged.users, [
    { handle: 'valid_user', phone: '0550000001' },
    { handle: 'admin_user', role: 'admin', phone: '0559990009' },  // empty field filled, existing kept
    { handle: 'import_user', phone: '0559990001' },
  ]);
});

test('mergeExtracted takes extracted users when there are none yet, and fills empty scalars only', () => {
  const merged = mergeExtracted({ name: 'kept' }, {
    name: 'ignored', portalUrl: 'https://x.example',
    users: [{ handle: 'import_user', phone: '0559990001' }],
  });
  assert.strictEqual(merged.name, 'kept');
  assert.strictEqual(merged.portalUrl, 'https://x.example');
  assert.deepStrictEqual(merged.users, [{ handle: 'import_user', phone: '0559990001' }]);
});

// ── schema shape: pages map one-to-one to config files, grouped by file ───
test('schema has 10 numbered steps and no ai-import step', () => {
  const schema = require('./schema.json');
  assert.strictEqual(schema.steps.length, 10);
  assert.ok(!schema.steps.some(s => s.id === 'ai-import'), 'ai-import must not be a numbered step');
  assert.ok(!schema.steps.some(s => s.type === 'ai-extract'), 'no ai-extract step type in the flow');
  assert.strictEqual(schema.steps[schema.steps.length - 1].type, 'review', 'review stays last');
  const figma = schema.steps.find(s => s.id === 'figma');
  assert.ok(figma && figma.optional, 'figma step exists and is optional');
  const tokenField = figma.fields.find(f => f.key === 'figma.token');
  assert.ok(tokenField.secret && tokenField.envKey === 'FIGMA_TOKEN' && tokenField.envKeyFrom === 'figma.tokenEnvVar',
    'figma token is a secret field wired to FIGMA_TOKEN');
});

test('every content page declares exactly one target file, and same-file pages are consecutive', () => {
  const schema = require('./schema.json');
  const content = schema.steps.filter(s => s.type !== 'review');
  for (const s of content) {
    assert.ok(s.group === 'project' || s.group === 'environment', `step ${s.id} must belong to a group`);
    // The environments manager (E0) writes no file itself — it manages which
    // files exist; every other content page declares its ONE target file.
    if (s.type === 'env-manager') continue;
    assert.ok(typeof s.target === 'string' && s.target, `step ${s.id} must declare its one target file`);
    const expected = s.group === 'project' ? 'config/project.json' : 'environments/{envName}.json';
    assert.strictEqual(s.target, expected, `step ${s.id}: group and target must agree`);
  }
  // Contiguity: once the environment group starts, no project page follows.
  const groups = content.map(s => s.group);
  const firstEnv = groups.indexOf('environment');
  assert.ok(firstEnv > 0, 'project pages come first');
  assert.ok(!groups.slice(firstEnv).includes('project'),
    `project and environment pages must not interleave (got: ${groups.join(' → ')})`);
  // The steps-track group labels are schema-driven.
  assert.ok(schema.groups && schema.groups.project && schema.groups.project.label, 'project group label');
  assert.ok(schema.groups.environment && schema.groups.environment.label, 'environment group label');
});

test('the environments manager opens the environment group; the name field is read-only', () => {
  const schema = require('./schema.json');
  const idx = schema.steps.findIndex(s => s.id === 'environments');
  assert.ok(idx > 0, 'environments manager step exists');
  const mgr = schema.steps[idx];
  assert.strictEqual(mgr.type, 'env-manager');
  assert.strictEqual(mgr.group, 'environment');
  const firstEnvIdx = schema.steps.findIndex(s => s.group === 'environment');
  assert.strictEqual(idx, firstEnvIdx, 'the manager is the environment group opener (E0)');
  assert.strictEqual(schema.steps[idx + 1].id, 'environment', 'environment details follow the manager');
  const envName = schema.steps[idx + 1].fields.find(f => f.key === 'envName');
  assert.strictEqual(envName.readonly, true,
    'typing a new name must no longer fork a fresh environment — rename is an explicit, confirmed op');
});

test('the first page is pure project settings — the environment name lives on the environment page', () => {
  const schema = require('./schema.json');
  const first = schema.steps[0];
  assert.strictEqual(first.target, 'config/project.json', 'first page writes project.json only');
  assert.ok(!(first.fields || []).some(f => f.key === 'envName' || f.key === 'defaultEnvironment'),
    'no environment-name field among project settings');
  assert.ok(!schema.steps.flatMap(s => s.fields || []).some(f => f.key === 'defaultEnvironment'),
    'defaultEnvironment is derived output only — never a page input');
  const envStep = schema.steps.find(s => s.id === 'environment');
  assert.strictEqual(envStep.group, 'environment');
  assert.strictEqual((envStep.fields || [])[0].key, 'envName',
    'naming the file is the first act of environment configuration');
});

test('the KB page exists in the project group with the fixed KB_ASK_API_KEY secret', () => {
  const schema = require('./schema.json');
  const kb = schema.steps.find(s => s.id === 'knowledge-base');
  assert.ok(kb && kb.optional, 'knowledge-base step exists and is optional');
  assert.strictEqual(kb.group, 'project');
  assert.strictEqual(kb.target, 'config/project.json');
  const keys = kb.fields.map(f => f.key);
  assert.ok(keys.includes('kb.baseUrl') && keys.includes('kb.project'), 'kb.baseUrl + kb.project inputs');
  const keyField = kb.fields.find(f => f.key === 'kb.key');
  assert.ok(keyField && keyField.secret && keyField.envKey === 'KB_ASK_API_KEY',
    'KB key is a secret bound to the fixed KB_ASK_API_KEY env var (ask_kb.js reads that name)');
  assert.ok(!keyField.envKeyFrom, 'KB env var name is fixed — no envKeyFrom (matches azure.pat, not figma)');
});

test('review outputs are file-keyed and template on {envName}', () => {
  const schema = require('./schema.json');
  const review = schema.steps[schema.steps.length - 1];
  assert.deepStrictEqual(review.outputs, [
    { file: 'config/project.json', key: 'projectConfig' },
    { file: 'environments/{envName}.json', key: 'envConfig' },
  ]);
});

test('ui.html speaks envName — no stale defaultEnvironment answer key', () => {
  const ui = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
  assert.ok(!ui.includes("answers['defaultEnvironment']"),
    'the answer-key rename must be total: one mapping, no drift');
});

test('ui.html: the fork affordance is gone; manager, pending ops, and consent markers are in', () => {
  const ui = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
  assert.ok(!ui.includes('onEnvironmentNameChanged'),
    'typing a name must no longer silently fork a fresh environment');
  assert.ok(ui.includes('env-manager'), 'the E0 environments manager is rendered');
  assert.ok(ui.includes('pendingDeletes'), 'deletes are recorded as pending ops, executed only by the save');
  assert.ok(ui.includes('confirmed: true'), 'ops go to the server explicitly consented');
  assert.ok(ui.includes('openAddEnvDialog') && ui.includes('openRenameDialog') && ui.includes('openDeleteDialog'),
    'add/rename/delete all route through explicit dialogs');
  assert.ok(ui.includes('base[u.handle]'),
    'per-user unknown-prop preservation (mirror of engine buildEnvUsers) is wired in');
});

// ── validateConfigs ───────────────────────────────────────────────────────
test('validateConfigs accepts a well-formed payload', () => {
  const errs = validateConfigs(
    { name: 'demo' },
    { portalUrl: 'https://ok.example', users: { valid_user: { phone: '1' } } },
    'qa',
  );
  assert.deepStrictEqual(errs, []);
});

test('validateConfigs rejects an empty or missing users object (minItems: 1)', () => {
  const proj = { name: 'd' };
  assert.match(validateConfigs(proj, { portalUrl: 'https://ok.example', users: {} }, 'qa').join(), /user/i);
  assert.match(validateConfigs(proj, { portalUrl: 'https://ok.example' }, 'qa').join(), /user/i);
});

test('validateConfigs rejects bad url, bad env name, missing name', () => {
  assert.match(validateConfigs({ name: 'd' }, { portalUrl: 'nope' }, 'qa').join(), /portalUrl/);
  assert.match(validateConfigs({ name: 'd' }, { portalUrl: 'https://ok.example' }, '../evil').join(), /envName/);
  assert.match(validateConfigs({}, { portalUrl: 'https://ok.example' }, 'qa').join(), /name/);
  assert.match(
    validateConfigs({ name: 'd' }, { portalUrl: 'https://ok.example', users: { u: {} }, api: { baseUrl: 'bad' } }, 'qa').join(),
    /api\.baseUrl/,
  );
});

// ── buildConfigs ──────────────────────────────────────────────────────────
test('buildConfigs maps answers to the file contract', () => {
  const { projectConfig, envConfig, envName } = buildConfigs({
    name: 'demo', envName: 'uat', portalUrl: 'https://uat.example',
    'db.server': 'db.local', 'api.baseUrl': 'https://api.example',
    users: [{ handle: 'valid_user', phone: '0550000001' }],
  }, []);
  assert.strictEqual(envName, 'uat');
  assert.strictEqual(projectConfig.defaultEnvironment, 'uat',
    'first-configured claims the default — derived, not an input');
  assert.strictEqual(projectConfig.name, 'demo');
  assert.deepStrictEqual(Object.keys(envConfig.users), ['valid_user']);
  assert.deepStrictEqual(envConfig.db.password, { envSecret: 'SQLCMDPASSWORD' });
  assert.deepStrictEqual(envConfig.api.token, { envSecret: 'API_TOKEN' });
  assert.ok(!('azure' in projectConfig), 'empty azure block is stripped');
});

test('extractFromText maps environment-name labels to envName', () => {
  assert.strictEqual(extractFromText('البيئة: uat').envName, 'uat');
  assert.strictEqual(extractFromText('environment: staging').envName, 'staging');
  const r = extractFromText('default environment: qc2');
  assert.strictEqual(r.envName, 'qc2');
  assert.ok(!('defaultEnvironment' in r), 'the old answer key is never emitted');
});

test('buildConfigs: kb block from kb answers, key material never in JSON', () => {
  const r = buildConfigs({ name: 'd', 'kb.baseUrl': 'http://localhost:3000', 'kb.project': 'travel-kb' }, []);
  assert.deepStrictEqual(r.projectConfig.kb, { baseUrl: 'http://localhost:3000', project: 'travel-kb' });
  const none = buildConfigs({ name: 'd' }, []);
  assert.ok(!('kb' in none.projectConfig), 'empty kb block is stripped');
});

test('buildConfigs: figma block only when a file key is provided', () => {
  const withKey = buildConfigs({ name: 'd', 'figma.fileKey': 'KEY1' }, []);
  assert.deepStrictEqual(withKey.projectConfig.figma, { fileKey: 'KEY1', token: { envSecret: 'FIGMA_TOKEN' } });
  const custom = buildConfigs({ name: 'd', 'figma.fileKey': 'K2', 'figma.tokenEnvVar': 'MY_FIGMA_TOKEN' }, []);
  assert.deepStrictEqual(custom.projectConfig.figma.token, { envSecret: 'MY_FIGMA_TOKEN' });
  const none = buildConfigs({ name: 'd' }, []);
  assert.ok(!('figma' in none.projectConfig), 'no figma block without a file key');
});

// ── planSave: the multi-environment batch save plan (wizard design #3) ────
// Pure plan validation + arithmetic: disk state comes in as data, so every
// rejection path — the wizard's FIRST destructive capability — is testable
// without IO. The server executes only what a clean plan allows.
const disk = (envNames = [], pristineNames = []) => ({ envNames, pristineNames });
const cfgOk = (url = 'https://ok.example') => ({ portalUrl: url, users: { u1: { phone: '1' } } });
const op = (o) => ({ confirmed: true, ...o });

test('planSave accepts a multi-env write and reports the final environment set', () => {
  const plan = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'qa' },
    environments: { qa: cfgOk(), uat: cfgOk('https://uat.example') },
    ops: { renames: [], deletes: [] },
  }, disk(['qa']));
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual([...plan.finalEnvNames].sort(), ['qa', 'uat']);
  assert.deepStrictEqual(plan.reconcile, []);
});

test('planSave validates every environment, naming the file in the error', () => {
  const plan = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'qa' },
    environments: { qa: cfgOk(), uat: { portalUrl: 'nope', users: { u: {} } } },
    ops: {},
  }, disk(['qa']));
  assert.match(plan.errors.join(), /uat/);
  assert.match(plan.errors.join(), /portalUrl/);
});

test('planSave refuses an un-consented rename or delete (invariant #11 double consent)', () => {
  const base = { projectConfig: { name: 'd', defaultEnvironment: 'qa' }, environments: { qa: cfgOk() } };
  const r1 = planSave({ ...base, ops: { renames: [{ from: 'old', to: 'new2' }], deletes: [] } }, disk(['qa', 'old']));
  assert.match(r1.errors.join(), /consent/i);
  const r2 = planSave({ ...base, ops: { renames: [], deletes: [{ name: 'old' }] } }, disk(['qa', 'old']));
  assert.match(r2.errors.join(), /consent/i);
  const r3 = planSave({ ...base, ops: { renames: [], deletes: [{ name: 'old', confirmed: true }] } }, disk(['qa', 'old']));
  assert.deepStrictEqual(r3.errors, [], 'the same op with explicit consent passes');
});

test('planSave refuses ops on files it did not enumerate', () => {
  const base = { projectConfig: { name: 'd', defaultEnvironment: 'qa' }, environments: { qa: cfgOk() } };
  const r1 = planSave({ ...base, ops: { renames: [op({ from: 'ghost', to: 'new2' })], deletes: [] } }, disk(['qa']));
  assert.match(r1.errors.join(), /ghost/);
  const r2 = planSave({ ...base, ops: { renames: [], deletes: [op({ name: 'ghost' })] } }, disk(['qa']));
  assert.match(r2.errors.join(), /ghost/);
});

test('planSave refuses a save that would leave zero environments', () => {
  const plan = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'qa' },
    environments: {},
    ops: { renames: [], deletes: [op({ name: 'qa' })] },
  }, disk(['qa']));
  assert.match(plan.errors.join(), /at least one environment/i);
  // Reconciliation alone must not zero the project either: a lone pristine
  // sample with nothing written stays where it is (the save is refused).
  const r2 = planSave({ projectConfig: { name: 'd', defaultEnvironment: 'qc' }, environments: {}, ops: {} },
    disk(['qc'], ['qc']));
  assert.match(r2.errors.join(), /at least one environment/i);
});

test('planSave: rename arithmetic — the default follows a rename; a ghost default is refused', () => {
  const good = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'b' },
    environments: {},
    ops: { renames: [op({ from: 'a', to: 'b' })], deletes: [] },
  }, disk(['a']));
  assert.deepStrictEqual(good.errors, []);
  assert.deepStrictEqual(good.finalEnvNames, ['b']);
  const bad = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'a' },
    environments: {},
    ops: { renames: [op({ from: 'a', to: 'b' })], deletes: [] },
  }, disk(['a']));
  assert.match(bad.errors.join(), /defaultEnvironment/);
});

test('planSave: deleting the default without re-designating is a ghost default — refused', () => {
  const plan = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'qa' },
    environments: { uat: cfgOk() },
    ops: { renames: [], deletes: [op({ name: 'qa' })] },
  }, disk(['qa', 'uat']));
  assert.match(plan.errors.join(), /defaultEnvironment/);
  const fixed = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'uat' },
    environments: { uat: cfgOk() },
    ops: { renames: [], deletes: [op({ name: 'qa' })] },
  }, disk(['qa', 'uat']));
  assert.deepStrictEqual(fixed.errors, []);
});

test('planSave refuses colliding or path-escaping op names', () => {
  const proj = { name: 'd', defaultEnvironment: 'qa' };
  // rename target collides with a surviving file
  assert.match(planSave({ projectConfig: proj, environments: {},
    ops: { renames: [op({ from: 'a', to: 'qa' })], deletes: [] } }, disk(['qa', 'a'])).errors.join(), /collid/i);
  // two renames onto the same target
  assert.match(planSave({ projectConfig: proj, environments: { qa: cfgOk() },
    ops: { renames: [op({ from: 'a', to: 'x' }), op({ from: 'b', to: 'x' })], deletes: [] } },
    disk(['qa', 'a', 'b'])).errors.join(), /collid/i);
  // deleting a file this save also writes (delete runs last — it would kill the fresh write)
  assert.match(planSave({ projectConfig: proj, environments: { qa: cfgOk() },
    ops: { renames: [], deletes: [op({ name: 'qa' })] } }, disk(['qa'])).errors.join(), /collid/i);
  // deleting a rename target (same ordering hazard)
  assert.match(planSave({ projectConfig: proj, environments: { qa: cfgOk() },
    ops: { renames: [op({ from: 'a', to: 'b' })], deletes: [op({ name: 'b' })] } },
    disk(['qa', 'a', 'b'])).errors.join(), /collid/i);
  // rename from === to is not a rename
  assert.match(planSave({ projectConfig: proj, environments: { qa: cfgOk() },
    ops: { renames: [op({ from: 'a', to: 'a' })], deletes: [] } }, disk(['qa', 'a'])).errors.join(), /rename/i);
  // path traversal in an op name
  assert.match(planSave({ projectConfig: proj, environments: { qa: cfgOk() },
    ops: { renames: [], deletes: [op({ name: '../evil' })] } }, disk(['qa'])).errors.join(), /name/i);
});

test('planSave: renamed-and-edited — written under the new name, the old file removed by the op', () => {
  const plan = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'b' },
    environments: { b: cfgOk() },
    ops: { renames: [op({ from: 'a', to: 'b' })], deletes: [] },
  }, disk(['a']));
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(plan.finalEnvNames, ['b']);
});

test('planSave refuses chained or swapped renames — a target that is another rename source', () => {
  // In-order renameSync would silently overwrite the second rename's
  // still-on-disk source: a→b lands ON b.json, then b→c moves a's content —
  // b's data destroyed with an HTTP 200. Refused whole instead.
  const chain = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'c' },
    environments: {},
    ops: { renames: [op({ from: 'a', to: 'b' }), op({ from: 'b', to: 'c' })], deletes: [] },
  }, disk(['a', 'b']));
  assert.match(chain.errors.join(), /another rename/i, 'chain a→b, b→c must be refused');
  const swap = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'a' },
    environments: {},
    ops: { renames: [op({ from: 'a', to: 'b' }), op({ from: 'b', to: 'a' })], deletes: [] },
  }, disk(['a', 'b']));
  assert.match(swap.errors.join(), /another rename/i, 'swap a↔b must be refused');
});

test('planSave refuses adding a new environment under a name vacated by a rename', () => {
  // rename b→c AND write a fresh b in one save: the rename executes after the
  // write and would carry the fresh b.json away as c.json.
  const plan = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'c' },
    environments: { b: cfgOk() },
    ops: { renames: [op({ from: 'b', to: 'c' })], deletes: [] },
  }, disk(['b']));
  assert.match(plan.errors.join(), /collides/i);
});

test('planSave reconciles pristine samples this save does not claim — and only those', () => {
  const plan = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'uat' },
    environments: { uat: cfgOk() },
    ops: { renames: [], deletes: [] },
  }, disk(['qc', 'uat'], ['qc']));
  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(plan.reconcile, ['qc']);
  assert.deepStrictEqual(plan.finalEnvNames, ['uat']);
  // writing over the pristine name claims it — nothing reconciled
  const claimed = planSave({
    projectConfig: { name: 'd', defaultEnvironment: 'qc' },
    environments: { qc: cfgOk() },
    ops: {},
  }, disk(['qc'], ['qc']));
  assert.deepStrictEqual(claimed.errors, []);
  assert.deepStrictEqual(claimed.reconcile, []);
});

test('planSave refuses touching an unreadable on-disk environment file', () => {
  const proj = { name: 'd', defaultEnvironment: 'qa' };
  const state = { envNames: ['qa', 'broken'], pristineNames: [], unreadableNames: ['broken'] };
  // write over it
  assert.match(planSave({ projectConfig: proj, environments: { qa: cfgOk(), broken: cfgOk() }, ops: {} }, state)
    .errors.join(), /broken/);
  // rename it away
  assert.match(planSave({ projectConfig: proj, environments: { qa: cfgOk() },
    ops: { renames: [op({ from: 'broken', to: 'fixed' })], deletes: [] } }, state).errors.join(), /broken/);
  // rename onto it
  assert.match(planSave({ projectConfig: proj, environments: { qa: cfgOk() },
    ops: { renames: [op({ from: 'qa', to: 'broken' })], deletes: [] } },
    { envNames: ['qa', 'broken'], pristineNames: [], unreadableNames: ['broken'] }).errors.join(), /broken/);
  // delete it
  assert.match(planSave({ projectConfig: proj, environments: { qa: cfgOk() },
    ops: { renames: [], deletes: [op({ name: 'broken' })] } }, state).errors.join(), /broken/);
});

// ── buildEnvUsers: per-user unknown-prop preservation (invariant #11) ─────
test('buildEnvUsers merges each entry onto its on-disk base — hand-added props survive', () => {
  const base = {
    valid_user: { phone: '0550000001', role: 'customer', apiKeyRef: 'hand-added' },
    old_user: { phone: '9' },
  };
  const out = buildEnvUsers([
    { handle: 'valid_user', phone: '0550009999', email: '', role: 'customer', notes: '' },
    { handle: 'new_user', phone: '1' },
  ], base);
  assert.deepStrictEqual(out.valid_user,
    { phone: '0550009999', role: 'customer', apiKeyRef: 'hand-added' },
    'managed fields mirror the screen; unmanaged props are preserved');
  assert.deepStrictEqual(out.new_user, { phone: '1' });
  assert.ok(!('old_user' in out), 'a user removed on screen is removed from the file');
});

test('buildEnvUsers: an emptied managed field clears the saved value (screen wins)', () => {
  const out = buildEnvUsers(
    [{ handle: 'u', phone: '', role: 'admin' }],
    { u: { phone: '0550000001', notes: 'kept? no — cleared is cleared', custom: 'kept' } });
  assert.deepStrictEqual(out.u, { role: 'admin', custom: 'kept' });
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
