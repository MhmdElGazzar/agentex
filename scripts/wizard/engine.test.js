'use strict';
// Tests for the wizard engine — extraction, validation, config building.
// Run: node scripts/wizard/engine.test.js
const assert = require('node:assert');
const { extractFromText, validateConfigs, buildConfigs, mergeExtracted, validate } = require('./engine.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

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
    { key: 'defaultEnvironment', label: 'env', pattern: '^[a-z0-9][a-z0-9_-]{0,30}$' },
  ]}];
  assert.deepStrictEqual(validate({ defaultEnvironment: 'qa' }, steps), []);
  assert.match(validate({ defaultEnvironment: 'QA App!!' }, steps).join(), /env/);

  const schema = require('./schema.json');
  const fields = schema.steps.flatMap(s => s.fields || []);
  for (const key of ['defaultEnvironment', 'db.passwordEnvVar', 'api.tokenEnvVar']) {
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

// ── schema shape ──────────────────────────────────────────────────────────
test('schema has 7 numbered steps and no ai-import step', () => {
  const schema = require('./schema.json');
  assert.strictEqual(schema.steps.length, 7);
  assert.ok(!schema.steps.some(s => s.id === 'ai-import'), 'ai-import must not be a numbered step');
  assert.ok(!schema.steps.some(s => s.type === 'ai-extract'), 'no ai-extract step type in the flow');
  assert.strictEqual(schema.steps[schema.steps.length - 1].type, 'review', 'review stays last');
});

// ── validateConfigs ───────────────────────────────────────────────────────
test('validateConfigs accepts a well-formed payload', () => {
  const errs = validateConfigs({ name: 'demo' }, { portalUrl: 'https://ok.example' }, 'qa');
  assert.deepStrictEqual(errs, []);
});

test('validateConfigs rejects bad url, bad env name, missing name', () => {
  assert.match(validateConfigs({ name: 'd' }, { portalUrl: 'nope' }, 'qa').join(), /portalUrl/);
  assert.match(validateConfigs({ name: 'd' }, { portalUrl: 'https://ok.example' }, '../evil').join(), /envName/);
  assert.match(validateConfigs({}, { portalUrl: 'https://ok.example' }, 'qa').join(), /name/);
  assert.match(
    validateConfigs({ name: 'd' }, { portalUrl: 'https://ok.example', api: { baseUrl: 'bad' } }, 'qa').join(),
    /api\.baseUrl/,
  );
});

// ── buildConfigs ──────────────────────────────────────────────────────────
test('buildConfigs maps answers to the file contract', () => {
  const { projectConfig, envConfig, envName } = buildConfigs({
    name: 'demo', defaultEnvironment: 'uat', portalUrl: 'https://uat.example',
    'db.server': 'db.local', 'api.baseUrl': 'https://api.example',
    users: [{ handle: 'valid_user', phone: '0550000001' }],
  }, []);
  assert.strictEqual(envName, 'uat');
  assert.strictEqual(projectConfig.name, 'demo');
  assert.deepStrictEqual(Object.keys(envConfig.users), ['valid_user']);
  assert.deepStrictEqual(envConfig.db.password, { envSecret: 'SQLCMDPASSWORD' });
  assert.deepStrictEqual(envConfig.api.token, { envSecret: 'API_TOKEN' });
  assert.ok(!('azure' in projectConfig), 'empty azure block is stripped');
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
