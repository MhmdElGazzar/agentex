'use strict';
// Tests for the wizard engine — extraction, validation, config building.
// Run: node scripts/wizard/engine.test.js
const assert = require('node:assert');
const { extractFromText, validateConfigs, buildConfigs } = require('./engine.js');

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
