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
  assert.deepStrictEqual(out.hits.find(h => h.param === 'orderId'), { param: 'orderId', value: 1042, source: 'project', file: 'test/test-data/orders.json', path: '$.sample.order_id' });
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

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
