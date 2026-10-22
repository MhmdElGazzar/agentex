'use strict';
// Tests for studio/data_store.js — the collected-data store and the captured-token files.
// Run: node skills/endpoint-testing/scripts/studio/data_store.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const D = require('./data_store.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
function repo(gitignore) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-datastore-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (gitignore !== undefined) fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
  return dir;
}
const IGNORES = '.agentex/\ntest/.auth/\n';
const TOKEN = 'EVAL_SENTINEL_TOKEN_datastore_41';

test('the collected store is written with schemaVersion 1 and read back', () => {
  const dir = repo(IGNORES);
  const r = D.writeStore(dir, 'orders', { suite: 'integration/api_test_suites/orders/orders_suite.json', environment: 'qc', values: [{ id: 'v1', param: 'orderId', value: 1042, source: 'ui' }] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const back = D.readStore(dir, 'orders');
  assert.strictEqual(back.schemaVersion, 1);
  assert.strictEqual(back.values[0].value, 1042);
  assert.strictEqual(r.path, '.agentex/cache/api-data/orders.json');
});

test('a token value never reaches the collected store, only its reference', () => {
  const dir = repo(IGNORES);
  D.writeStore(dir, 'orders', { token: { ref: 'orders-qc', user: 'qa_user_a', source: 'ui', capturedAt: 'now', token: TOKEN, value: TOKEN }, values: [] });
  const text = fs.readFileSync(path.join(dir, '.agentex/cache/api-data/orders.json'), 'utf8');
  assert.ok(!text.includes(TOKEN));
  assert.deepStrictEqual(Object.keys(D.readStore(dir, 'orders').token).sort(), ['capturedAt', 'ref', 'source', 'user']);
});

test('the token file is written 0600 with schemaVersion and read back without its value', () => {
  const dir = repo(IGNORES);
  const r = D.writeToken(dir, { store: 'orders', environment: 'qc', user: 'qa_user_a', scheme: 'bearer', headerName: 'Authorization', token: TOKEN, capturedAt: '2026-10-22T10:00:00Z' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const f = path.join(dir, 'test/.auth/api-tokens/orders-qc.json');
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(rec.schemaVersion, 1);
  assert.strictEqual(rec.token, TOKEN);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  const meta = D.readTokenMeta(dir, 'orders', 'qc');
  assert.strictEqual(meta.user, 'qa_user_a');
  assert.ok(!JSON.stringify(meta).includes(TOKEN));
});

test('expiresAt is decoded from a JWT exp and never from anything else', () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.strictEqual(D.jwtExpiry(`${b64({ alg: 'none' })}.${b64({ exp: 1800000000 })}.s`), new Date(1800000000 * 1000).toISOString());
  assert.strictEqual(D.jwtExpiry('opaque-token'), null);
});

test('a path that is not gitignored is refused, nothing written', () => {
  const dir = repo('');
  const a = D.writeStore(dir, 'orders', { values: [] });
  const b = D.writeToken(dir, { store: 'orders', environment: 'qc', user: 'u', scheme: 'bearer', token: TOKEN });
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.error, 'not-ignored');
  assert.strictEqual(a.path, '.agentex/cache/api-data/orders.json');
  assert.strictEqual(b.ok, false);
  assert.ok(!fs.existsSync(path.join(dir, '.agentex')) && !fs.existsSync(path.join(dir, 'test')));
});

test('no git repository -> treated as ignored (documented)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-nogit-'));
  assert.strictEqual(D.isIgnored(dir, '.agentex/cache/api-data/x.json'), true);
});

test('a store slug that escapes its folder is refused', () => {
  const dir = repo(IGNORES);
  assert.throws(() => D.writeStore(dir, '../evil', { values: [] }), /invalid/);
  assert.throws(() => D.writeToken(dir, { store: 'a/b', environment: 'qc', token: 'x' }), /invalid/);
});

test('deleting the store loses nothing committed: readStore returns null, suites are untouched', () => {
  const dir = repo(IGNORES);
  D.writeStore(dir, 'orders', { values: [] });
  fs.rmSync(path.join(dir, '.agentex'), { recursive: true });
  assert.strictEqual(D.readStore(dir, 'orders'), null);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
