'use strict';
// Unit tests for the shared project-config resolver. Run: node scripts/lib/project_config.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pc = require('./project_config.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// Fresh throwaway project dir per test, with optional files.
function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-pc-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

// ---- readEnvVar ----
test('readEnvVar reads a .env line and strips quotes', () => {
  const dir = proj({ '.env': "DB_SERVER='srv.local'\nPLAIN=abc\n" });
  assert.strictEqual(pc.readEnvVar(dir, 'DB_SERVER'), 'srv.local');
  assert.strictEqual(pc.readEnvVar(dir, 'PLAIN'), 'abc');
  assert.strictEqual(pc.readEnvVar(dir, 'MISSING'), null);
});
test('readEnvVar prefers process.env over .env', () => {
  const dir = proj({ '.env': 'X_TEST_VAR=fromfile\n' });
  process.env.X_TEST_VAR = 'fromproc';
  try { assert.strictEqual(pc.readEnvVar(dir, 'X_TEST_VAR'), 'fromproc'); }
  finally { delete process.env.X_TEST_VAR; }
});

// ---- loadProjectConfig ----
test('loadProjectConfig returns {} when file is absent', () => {
  assert.deepStrictEqual(pc.loadProjectConfig(proj()), {});
});
test('loadProjectConfig parses config/project.json', () => {
  const dir = proj({ 'config/project.json': { name: 'demo', defaultEnvironment: 'qa' } });
  assert.strictEqual(pc.loadProjectConfig(dir).defaultEnvironment, 'qa');
});
test('loadProjectConfig throws on invalid JSON', () => {
  const dir = proj({ 'config/project.json': '{ nope' });
  assert.throws(() => pc.loadProjectConfig(dir), /invalid JSON/);
});

// ---- listEnvironments / loadEnvironment ----
test('listEnvironments: [] without folder, sorted names with it', () => {
  assert.deepStrictEqual(pc.listEnvironments(proj()), []);
  const dir = proj({ 'environments/uat.json': {}, 'environments/qa.json': {} });
  assert.deepStrictEqual(pc.listEnvironments(dir), ['qa', 'uat']);
});
test('loadEnvironment: null for legacy project (no name, no default)', () => {
  assert.strictEqual(pc.loadEnvironment(proj(), null), null);
});
test('loadEnvironment: explicit name wins over defaultEnvironment', () => {
  const dir = proj({
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { portalUrl: 'https://qa' },
    'environments/uat.json': { portalUrl: 'https://uat' },
  });
  assert.strictEqual(pc.loadEnvironment(dir, 'uat').portalUrl, 'https://uat');
  assert.strictEqual(pc.loadEnvironment(dir, null).name, 'qa');
});
test('loadEnvironment: wanted-but-missing env throws listing available', () => {
  const dir = proj({ 'environments/qa.json': {} });
  assert.throws(() => pc.loadEnvironment(dir, 'live'), /available: qa/);
});

// ---- resolveSecret / secretHint ----
test('resolveSecret: literal string, envSecret ref, null', () => {
  const dir = proj({ '.env': 'MY_SECRET=s3cret\n' });
  assert.strictEqual(pc.resolveSecret(dir, 'plain'), 'plain');
  assert.strictEqual(pc.resolveSecret(dir, { envSecret: 'MY_SECRET' }), 's3cret');
  assert.strictEqual(pc.resolveSecret(dir, { envSecret: 'UNSET_VAR' }), null);
  assert.strictEqual(pc.resolveSecret(dir, null), null);
  assert.strictEqual(pc.secretHint({ envSecret: 'MY_SECRET' }), 'env var MY_SECRET');
});

// ---- resolveDbConnection ----
test('resolveDbConnection: environment db block wins, password via envSecret', () => {
  const dir = proj({
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { db: { server: 'qa-db', port: 1434, name: 'QaDb', user: 'u1', password: { envSecret: 'QA_DB_PW' } } },
    '.env': 'QA_DB_PW=pw1\nDB_SERVER=legacy-db\n',
  });
  const c = pc.resolveDbConnection(dir, null, { serverEnv: 'DB_SERVER' });
  assert.strictEqual(c.server, 'qa-db');
  assert.strictEqual(c.port, '1434');
  assert.strictEqual(c.database, 'QaDb');
  assert.strictEqual(c.password, 'pw1');
});
test('resolveDbConnection: legacy catalog fallback reads .env by name', () => {
  const dir = proj({ '.env': 'DB_SERVER=legacy-db\nDB_NAME=LegacyDb\nSQLCMDPASSWORD=lpw\n' });
  const c = pc.resolveDbConnection(dir, null, { serverEnv: 'DB_SERVER', databaseEnv: 'DB_NAME' });
  assert.strictEqual(c.server, 'legacy-db');
  assert.strictEqual(c.database, 'LegacyDb');
  assert.strictEqual(c.password, 'lpw');
});
test('resolveDbConnection: named-but-unset databaseEnv throws', () => {
  const dir = proj({ '.env': 'DB_SERVER=srv\n' });
  const savedServer = process.env.DB_SERVER;
  const savedName = process.env.DB_NAME;
  delete process.env.DB_SERVER;
  delete process.env.DB_NAME;
  try {
    assert.throws(() => pc.resolveDbConnection(dir, null, { serverEnv: 'DB_SERVER', databaseEnv: 'DB_NAME' }), /DB_NAME/);
  } finally {
    if (savedServer === undefined) delete process.env.DB_SERVER; else process.env.DB_SERVER = savedServer;
    if (savedName === undefined) delete process.env.DB_NAME; else process.env.DB_NAME = savedName;
  }
});
test('resolveDbConnection: nothing resolvable throws', () => {
  assert.throws(() => pc.resolveDbConnection(proj(), null, {}), /no db config/);
});

// ---- resolveApiTarget ----
test('resolveApiTarget: env api block with envSecret token', () => {
  const dir = proj({
    'config/project.json': { defaultEnvironment: 'qa' },
    'environments/qa.json': { api: { baseUrl: 'https://api.qa/', token: { envSecret: 'QA_TOKEN' } } },
    '.env': 'QA_TOKEN=tok1\n',
  });
  const t = pc.resolveApiTarget(dir, null);
  assert.strictEqual(t.baseUrl, 'https://api.qa'); // trailing slash stripped
  assert.strictEqual(t.token, 'tok1');
  assert.strictEqual(t.hasToken, true);
});
test('resolveApiTarget: null when no environment or no api block', () => {
  assert.strictEqual(pc.resolveApiTarget(proj(), null), null);
  const dir = proj({ 'config/project.json': { defaultEnvironment: 'qa' }, 'environments/qa.json': { portalUrl: 'x' } });
  assert.strictEqual(pc.resolveApiTarget(dir, null), null);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
