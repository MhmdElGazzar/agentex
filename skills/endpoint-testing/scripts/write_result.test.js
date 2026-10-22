'use strict';
// Tests for write_result.js — result.md from a suite-result.json (editor runs).
// Run: node skills/endpoint-testing/scripts/write_result.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const W = require('./write_result.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
const RESULT = {
  schemaVersion: 1, suite: 'integration/api_test_suites/orders/orders_suite.json', env: 'qc', startedAt: '2026-10-22T10:00:00.000Z',
  result: 'FAIL', total: 4, passed: 1, failed: 1, blocked: 2,
  cases: [
    { name: 'get-happy', entry: 'orders.get-order', suite: 'integration/api_test_suites/orders/orders_suite.json', index: 1, result: 'PASS', status: 200, log: 'executions/execu_x/api-tests/logs/a.log', ms: 12 },
    { name: 'get-not-found', entry: 'orders.get-order', suite: 'integration/api_test_suites/orders/orders_suite.json', index: 2, result: 'FAIL', status: 200, failures: ['status 200 != expected 404'], log: 'executions/execu_x/api-tests/logs/b.log', ms: 9 },
    { name: 'list-happy', entry: 'orders.list-orders', suite: 'integration/api_test_suites/orders/orders_suite.json', index: 3, result: 'BLOCKED', reasonCode: 'placeholder', reason: 'needs a real value: param "status" is still a placeholder — set it in the editor or the suite file' },
    { name: 'create-happy', entry: 'orders.create-order', suite: 'integration/api_test_suites/orders/orders_suite.json', index: 4, result: 'BLOCKED', skipped: true, reason: 'case skipped: "review: write operation — remove this line to enable"' },
  ],
};

test('tally line and the closing one-line tally', () => {
  const md = W.render(RESULT);
  assert.match(md, /^# API tests/m);
  assert.match(md, /\| 4 \| 1 \| 1 \| 2 \|/);
  assert.match(md.trim().split('\n').pop(), /^1 pass \/ 1 fail \/ 2 blocked$/);
});

test('FAIL entries carry steps, expected vs actual and the evidence log; BLOCKED listed separately', () => {
  const md = W.render(RESULT, { params: (suite, index) => (index === 2 ? { orderId: 999999999 } : null) });
  const fail = md.slice(md.indexOf('## Failures'), md.indexOf('## Blocked'));
  assert.match(fail, /get-not-found/);
  assert.match(fail, /orders\.get-order/);
  assert.match(fail, /"orderId":999999999/);
  assert.match(fail, /status 200 != expected 404/);
  assert.match(fail, /executions\/execu_x\/api-tests\/logs\/b\.log/);
  const blocked = md.slice(md.indexOf('## Blocked'));
  assert.match(blocked, /list-happy — needs a real value/);
  assert.match(blocked, /create-happy — case skipped/);
  assert.ok(!fail.includes('list-happy'));
});

test('the severity line says not rated (run from the editor)', () => {
  assert.ok(W.render(RESULT).includes('Severity: not rated (run from the editor — ask the agent in chat to triage)'));
});

test('deterministic: the same input renders the same bytes', () => {
  assert.strictEqual(W.render(RESULT), W.render(JSON.parse(JSON.stringify(RESULT))));
});

test('CLI writes result.md next to the suite-result.json and prints one JSON line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-writeresult-'));
  const f = path.join(dir, 'suite-result.json');
  fs.writeFileSync(f, JSON.stringify(RESULT));
  const p = spawnSync(process.execPath, [path.join(__dirname, 'write_result.js'), '--result', f], { encoding: 'utf8' });
  assert.strictEqual(p.status, 0, p.stdout + p.stderr);
  const out = JSON.parse(p.stdout.trim());
  assert.strictEqual(out.ok, true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'result.md'), 'utf8'), W.render(RESULT));
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
