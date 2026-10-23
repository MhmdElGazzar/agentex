'use strict';
// Tests for project_values.js — "project first": values for the wizard's needs from the
// project's test data, past executions and cataloged DB queries.
// Run: node skills/swagger-import/scripts/project_values.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'project_values.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
function proj(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-projvalues-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
function run(dir, needs, extra = []) {
  const p = spawnSync(process.execPath, [SCRIPT, '--needs', '-', ...extra], { cwd: dir, input: JSON.stringify(needs), encoding: 'utf8' });
  const lines = p.stdout.trim().split('\n');
  return { code: p.status, lines, out: JSON.parse(lines.pop()) };
}
const NEEDS = [{ param: 'orderId', in: 'path', type: 'integer' }, { param: 'status', in: 'query', type: 'string' }, { param: 'accessToken', in: 'query', type: 'string' }];

test('a key match in test/** JSON is a Project hit with its file and JSON path', () => {
  const dir = proj({ 'test/test-data/orders.json': { sample: { order_id: 1042, status: 'open' } } });
  const { code, out } = run(dir, NEEDS);
  assert.strictEqual(code, 0);
  const o = out.hits.find(h => h.param === 'orderId');
  assert.deepStrictEqual({ ...o, group: undefined }, { param: 'orderId', value: 1042, source: 'project', file: 'test/test-data/orders.json', path: '$.sample.order_id', from: 'test-data', environment: null, owner: null, group: undefined });
  assert.ok(o.group);
  assert.strictEqual(out.hits.find(h => h.param === 'status').value, 'open');
});

test('CSV columns and past execution logs (response bodies and query strings) are searched', () => {
  const dir = proj({
    'test/test-data/users.csv': 'name,Status\nqa_user_a,closed\n',
    'executions/execu_2026-10-20_10-00-00/api-tests/logs/orders__1-get.log': 'GET http://api.example.test/orders?orderId=77\n\nHTTP_STATUS:200\ncontent-type: application/json\n\n{"items":[{"orderId":88}]}\n',
  });
  const { out } = run(dir, NEEDS);
  const vals = out.hits.filter(h => h.param === 'orderId').map(h => h.value).sort();
  assert.deepStrictEqual(vals, ['77', 88].sort());
  assert.ok(out.hits.some(h => h.param === 'status' && h.value === 'closed' && h.file === 'test/test-data/users.csv'));
});

test('skips .env*, test/.auth/, .agentex/ and secret-named keys', () => {
  const dir = proj({
    '.env': 'orderId=5\n',
    'test/.env.local': 'orderId=6\n',
    'test/.auth/state.json': { orderId: 7 },
    '.agentex/cache/api-data/x.json': { orderId: 8 },
    'test/test-data/a.json': { accessToken: 'abc', orderId: 9, nested: { password: 'p', orderId: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln' } },
  });
  const { out } = run(dir, NEEDS);
  assert.deepStrictEqual(out.hits.map(h => [h.param, h.value]), [['orderId', 9]]);
  assert.ok(out.skippedNeeds.includes('accessToken'));
});

test('caps are honoured: --max-files and --max-bytes', () => {
  const files = {};
  for (let i = 0; i < 5; i++) files[`test/data/f${i}.json`] = { status: `s${i}` };
  files['test/data/big.json'] = JSON.stringify({ status: 'x'.repeat(5000) });
  const dir = proj(files);
  const a = run(dir, NEEDS, ['--max-files', '2']).out;
  assert.strictEqual(a.scanned.files, 2);
  assert.strictEqual(a.truncated, true);
  const b = run(dir, NEEDS, ['--max-bytes', '1000']).out;
  assert.ok(!b.hits.some(h => String(h.value).startsWith('xxx')));
});

test('cataloged DB queries are listed with selectOnly', () => {
  const dir = proj({ 'integration/orders_db.json': { name: 'orders-db', queries: [
    { name: 'latest-open', params: [], query: 'SELECT TOP 1 OrderId FROM Orders WHERE Status = \'open\'' },
    { name: 'with-cte', params: ['s'], query: 'WITH x AS (SELECT 1 a) SELECT a FROM x' },
    { name: 'close-all', params: [], query: 'UPDATE Orders SET Status = \'closed\'' },
    { name: 'sneaky', params: [], query: 'SELECT 1; DELETE FROM Orders' },
  ] } });
  const { out } = run(dir, NEEDS);
  assert.deepStrictEqual(out.db.map(d => [d.entry, d.selectOnly]), [['orders-db.latest-open', true], ['orders-db.with-cte', true], ['orders-db.close-all', false], ['orders-db.sneaky', false]]);
});

test('prints exactly one JSON line; accepts a collect event as --needs', () => {
  const dir = proj({});
  const { lines, out } = run(dir, { event: 'collect', needs: NEEDS });
  assert.strictEqual(lines.length, 0);
  assert.strictEqual(out.ok, true);
});


// ---- the ladder (wizard-trial-fixes AC8): executions first, newest first, URL-path IDs,
// attribution (environment / owner / group), other-environment hits dropped.
const ITEM_NEEDS = [{ param: 'itemId', in: 'path', type: 'integer', operations: ['GET /items/{itemId}'] }];
const log = (url, body) => `GET ${url}\n\nHTTP_STATUS:200\ncontent-type: application/json\n\n${body || '{}'}\n`;
const ENVS = {
  'environments/qa.json': { users: { alice: { username: 'alice@example.test', password: { envSecret: 'QA_ALICE_PW' } }, bob: { username: 'bob@example.test', password: 'S3NTINEL-plain-pw' } } },
  'environments/staging.json': { users: { carol: { username: 'carol' } } },
};

test('600 files: the only matching ID sits in an old run\'s log -> found, not truncated', () => {
  const files = { ...ENVS };
  for (let i = 0; i < 19; i++) files[`test/data/f${String(i).padStart(3, '0')}.json`] = { note: `n${i}` };
  for (let r = 0; r < 29; r++) {
    const day = String(r + 1).padStart(2, '0');
    for (let k = 0; k < 20; k++) files[`executions/execu_2026-09-${day}_10-00-00/api-tests/logs/case${k}-get.log`] = log(`http://api.example.test/ping${k}`, '{"ok":true}');
  }
  files['executions/execu_2026-09-01_10-00-00/api-tests/logs/old-get.log'] = log('http://api.example.test/items/98', '{"name":"x"}');
  assert.strictEqual(Object.keys(files).length - Object.keys(ENVS).length, 600);
  const dir = proj(files);
  const { out } = run(dir, ITEM_NEEDS, ['--env', 'qa']);
  assert.strictEqual(out.truncated, false);
  const h = out.hits.find(x => x.param === 'itemId');
  assert.ok(h, 'itemId found in the old log');
  assert.strictEqual(String(h.value), '98');
  assert.strictEqual(h.from, 'url-path');
  assert.strictEqual(h.file, 'executions/execu_2026-09-01_10-00-00/api-tests/logs/old-get.log');
  assert.ok(out.scanned.highSignal >= 580);
});

test('executions are scanned before test data, newest run first', () => {
  const dir = proj({
    'test/data/a.json': { orderId: 1 },
    'executions/execu_2026-10-01_09-00-00/logs/a.log': log('http://x.test/orders?orderId=11'),
    'executions/execu_2026-10-20_09-00-00/logs/a.log': log('http://x.test/orders?orderId=22'),
  });
  const { out } = run(dir, NEEDS);
  assert.deepStrictEqual(out.hits.filter(h => h.param === 'orderId').map(h => String(h.value)), ['22', '11', '1']);
});

test('execution evidence files do not count toward --max-files; test data still does', () => {
  const files = {};
  for (let i = 0; i < 8; i++) files[`executions/execu_2026-10-0${i + 1}_09-00-00/logs/a.log`] = log(`http://x.test/o?status=s${i}`);
  for (let i = 0; i < 5; i++) files[`test/data/f${i}.json`] = { status: `t${i}` };
  const dir = proj(files);
  const { out } = run(dir, NEEDS, ['--max-files', '2']);
  assert.strictEqual(out.scanned.highSignal, 8);
  assert.strictEqual(out.scanned.files, 10);
  assert.strictEqual(out.truncated, true);
  assert.strictEqual(out.truncatedReason, 'max-files');
});

test('IDs come from URL paths matched against the operations\' templates; one URL is one group', () => {
  const dir = proj({
    'executions/execu_2026-10-20_09-00-00/logs/a.log': log('http://x.test/api/v1/shops/7/items/98?status=open'),
    'executions/execu_2026-10-20_09-00-00/logs/b.log': log('http://x.test/api/v1/shops/9/items/abc'),
  });
  const needs = [{ param: 'shopId', in: 'path', type: 'integer', operations: ['GET /shops/{shopId}/items/{itemId}'] },
    { param: 'itemId', in: 'path', type: 'integer', operations: ['GET /shops/{shopId}/items/{itemId}'] },
    { param: 'status', in: 'query', type: 'string' }];
  const { out } = run(dir, needs);
  const byParam = Object.fromEntries(out.hits.filter(h => String(h.value) !== '9').map(h => [h.param, h]));
  assert.strictEqual(String(byParam.shopId.value), '7');
  assert.strictEqual(String(byParam.itemId.value), '98');
  assert.strictEqual(byParam.shopId.group, byParam.itemId.group);
  assert.ok(!out.hits.some(h => h.value === 'abc'), 'a non-integer value is not taken for an integer path param');
  const g = out.groups.find(x => x.id === byParam.itemId.group);
  assert.deepStrictEqual(g.covers.slice().sort(), ['itemId', 'shopId', 'status']);
  assert.strictEqual(String(g.values.itemId), '98');
});

test('a body with <stem>.id gives <stem>Id, in the same group as its sibling keys', () => {
  const dir = proj({ 'test/data/order.json': { orderId: 5, item: { id: 98 } } });
  const needs = [{ param: 'orderId', in: 'path', type: 'integer' }, { param: 'itemId', in: 'path', type: 'integer' }];
  const { out } = run(dir, needs);
  const a = out.hits.find(h => h.param === 'itemId'), b = out.hits.find(h => h.param === 'orderId');
  assert.strictEqual(a.value, 98);
  assert.strictEqual(a.group, b.group);
});

test('hits carry environment, owner and group; the run record names the environment', () => {
  const dir = proj({
    ...ENVS,
    'executions/execu_2026-10-20_09-00-00/suite-result.json': { env: 'qa', cases: [] },
    'executions/execu_2026-10-20_09-00-00/alice-run/logs/a.log': log('http://x.test/items/98'),
    'test/data/shared.json': { itemId: 5 },
  });
  const { out } = run(dir, ITEM_NEEDS, ['--env', 'qa']);
  const a = out.hits.find(h => String(h.value) === '98');
  assert.strictEqual(a.environment, 'qa');
  assert.strictEqual(a.owner, 'alice');
  assert.ok(typeof a.group === 'string' && a.group.length > 0 && a.group.length <= 200);
  const b = out.hits.find(h => String(h.value) === '5');
  assert.strictEqual(b.environment, null, 'nothing names an environment: null, never a guess');
  assert.strictEqual(b.owner, null);
  assert.ok(out.groups.every(g => 'environment' in g && 'owner' in g && Array.isArray(g.covers)));
});

test('a hit from another environment is dropped and counted, never returned', () => {
  const dir = proj({
    ...ENVS,
    'executions/execu_2026-10-20_09-00-00/suite-result.json': { env: 'staging' },
    'executions/execu_2026-10-20_09-00-00/logs/a.log': log('http://x.test/items/98'),
    'test/qa/data.json': { itemId: 5 },
    'test/staging/data.json': { itemId: 6 },
  });
  const { out } = run(dir, ITEM_NEEDS, ['--env', 'qa']);
  assert.deepStrictEqual(out.hits.map(h => String(h.value)), ['5']);
  assert.strictEqual(out.skipped.otherEnvironment, 2);
  assert.ok(!out.groups.some(g => g.environment === 'staging'));
});

test('groups are sorted: same environment before unknown, then more needs covered, then newer', () => {
  const dir = proj({
    ...ENVS,
    'test/data/unknown-wide.json': { orderId: 1, status: 'a' },
    'test/qa/narrow.json': { orderId: 2 },
    'test/qa/wide.json': { orderId: 3, status: 'b' },
  });
  const { out } = run(dir, NEEDS, ['--env', 'qa']);
  const files = out.groups.map(g => path.basename(g.file));
  assert.deepStrictEqual(files, ['wide.json', 'narrow.json', 'unknown-wide.json']);
});

test('sentinel: no secret value reaches the output (secret-named keys and fields, JWTs, headers, env passwords)', () => {
  const S = 'S3NTINEL-value-9f2c';
  const dir = proj({
    ...ENVS,
    'environments/qa.json': { users: { alice: { username: 'alice@example.test', password: S, apiKey: S } } },
    'test/data/a.json': { orderId: 1, password: S, nested: { accessToken: S } },
    'executions/execu_2026-10-20_09-00-00/logs/a.log': `GET http://x.test/orders/5?token=${S}&orderId=9\n\nHTTP_STATUS:200\nauthorization: Bearer ${S}\nset-cookie: sid=${S}\n\n{"orderId":10,"session":"${S}","jwt":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"}\n`,
  });
  const p = spawnSync(process.execPath, [SCRIPT, '--needs', '-', '--env', 'qa'], { cwd: dir, input: JSON.stringify(NEEDS), encoding: 'utf8' });
  assert.ok(!p.stdout.includes(S) && !p.stderr.includes(S), 'no sentinel in stdout/stderr');
  assert.ok(!p.stdout.includes('eyJhbGci'));
  const out = JSON.parse(p.stdout.trim());
  assert.ok(out.hits.some(h => h.param === 'orderId'));
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
