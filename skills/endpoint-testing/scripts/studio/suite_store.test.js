'use strict';
// Tests for studio/suite_store.js — listing, counts, filters, and the hash-checked Save merge.
// Run: node skills/endpoint-testing/scripts/studio/suite_store.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('./suite_store.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
function proj(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-suitestore-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  return dir;
}
const ORDERS = 'integration/api_test_suites/orders/orders_suite.json';
const SUITE = {
  name: 'orders-suite',
  owner: 'kept-unknown-top-level',
  cases: [
    { name: 'get-happy', entry: 'orders.get-order', kind: 'happy', params: { orderId: 1042 }, sources: { orderId: 'ui' }, expect: { status: 200, fields: ['id'] }, review: ['a note'], custom: { x: 1 } },
    { name: 'get-not-found', entry: 'orders.get-order', kind: 'not-found', params: { orderId: 999999999 }, sources: { orderId: 'auto' }, expect: { status: 404, equals: { message: 'Order not found', code: 'NF' } } },
    { name: 'list-happy', entry: 'orders.list-orders', params: { status: 'example' }, sources: { status: 'placeholder' }, expect: { status: 200 } },
    { name: 'create-happy', entry: 'orders.create-order', skip: 'review: write operation — remove this line to enable', params: { item: 'x' }, expect: { status: 201 } },
  ],
};
const files = () => ({
  [ORDERS]: SUITE,
  'integration/api_test_suites/orders/orders_api.json': { name: 'orders', requests: [] },
  'integration/api_test_suites/hand/nested/mine_suite.json': { cases: [{ name: 'h', entry: 'svc.h', expect: { status: 200 } }] },
});
const runResult = (dir, ts, cases) => {
  const f = path.join(dir, 'executions', `execu_${ts}`, 'api-tests', 'suite-result.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ schemaVersion: 1, startedAt: ts, result: 'FAIL', cases }));
  const t = new Date(ts.replace(/_(\d\d)-(\d\d)-(\d\d)$/, 'T$1:$2:$3Z'));
  fs.utimesSync(f, t, t);
};

test('lists every *_suite.json recursively, hand-written included, never a catalog', () => {
  const dir = proj(files());
  const list = S.listSuites(dir);
  assert.deepStrictEqual(list.map(s => s.path), ['integration/api_test_suites/hand/nested/mine_suite.json', ORDERS]);
});

test('per-suite counts: endpoints, cases, needs review, skipped, failing from the newest run', () => {
  const dir = proj(files());
  runResult(dir, '2026-10-20_10-00-00', [{ suite: ORDERS, index: 1, name: 'get-happy', result: 'FAIL', status: 500 }]);
  runResult(dir, '2026-10-21_10-00-00', [{ suite: ORDERS, index: 1, name: 'get-happy', result: 'PASS', status: 200 }, { suite: ORDERS, index: 2, name: 'get-not-found', result: 'FAIL', status: 200 }]);
  const s = S.listSuites(dir).find(x => x.path === ORDERS);
  assert.deepStrictEqual({ endpoints: s.endpoints, cases: s.cases, needsReview: s.needsReview, skipped: s.skipped, failing: s.failing },
    { endpoints: 3, cases: 4, needsReview: 1, skipped: 1, failing: 1 });
});

test('filters: all / needs-review / failing / skipped match the rows', () => {
  const dir = proj(files());
  runResult(dir, '2026-10-21_10-00-00', [{ suite: ORDERS, index: 2, name: 'get-not-found', result: 'FAIL', status: 200 }]);
  const loaded = S.load(dir, ORDERS);
  const last = S.lastResults(dir, ORDERS);
  const names = f => loaded.json.cases.filter((c, i) => S.matchesFilter(c, last[i + 1], f)).map(c => c.name);
  assert.deepStrictEqual(names('all'), ['get-happy', 'get-not-found', 'list-happy', 'create-happy']);
  assert.deepStrictEqual(names('needs-review'), ['list-happy']);
  assert.deepStrictEqual(names('failing'), ['get-not-found']);
  assert.deepStrictEqual(names('skipped'), ['create-happy']);
});

test('applyEdits keeps unknown keys, review notes and the order of untouched cases', () => {
  const obj = JSON.parse(JSON.stringify(SUITE));
  const out = S.applyEdits(obj, [{ op: 'update', index: 2, case: { name: 'nf-renamed', expect: { status: 410 } } }]);
  assert.strictEqual(out.owner, 'kept-unknown-top-level');
  assert.deepStrictEqual(out.cases.map(c => c.name), ['get-happy', 'nf-renamed', 'list-happy', 'create-happy']);
  assert.deepStrictEqual(out.cases[0], SUITE.cases[0]);
  assert.deepStrictEqual(out.cases[1].expect, { status: 410, equals: { message: 'Order not found', code: 'NF' } });
  assert.strictEqual(out.cases[1].kind, 'not-found');
});

test('applyEdits: the message check moves between equals and contains, other equals entries kept', () => {
  const out = S.applyEdits(JSON.parse(JSON.stringify(SUITE)), [{ op: 'update', index: 2, case: { expect: { message: { from: 'message', path: 'message', text: 'not found', match: 'contains' } } } }]);
  assert.deepStrictEqual(out.cases[1].expect, { status: 404, equals: { code: 'NF' }, contains: { message: 'not found' } });
});

test('applyEdits: params merge with sources, omit, auth none and skip toggles', () => {
  const out = S.applyEdits(JSON.parse(JSON.stringify(SUITE)), [
    { op: 'update', index: 3, case: { params: { status: 'open' }, sources: { status: 'manual' } } },
    { op: 'update', index: 1, case: { auth: 'none', omit: ['orderId'] } },
    { op: 'update', index: 4, case: { skip: null } },
    { op: 'update', index: 1, case: { auth: null, omit: [] } },
  ]);
  assert.deepStrictEqual(out.cases[2].params, { status: 'open' });
  assert.deepStrictEqual(out.cases[2].sources, { status: 'manual' });
  assert.ok(!('auth' in out.cases[0]) && !('omit' in out.cases[0]));
  assert.ok(!('skip' in out.cases[3]));
});

test('applyEdits: + Add case goes under its endpoint; delete removes by original index', () => {
  const out = S.applyEdits(JSON.parse(JSON.stringify(SUITE)), [
    { op: 'add', entry: 'orders.get-order', case: { name: 'get-extra', entry: 'orders.get-order', params: { orderId: 1 }, expect: { status: 200 } } },
    { op: 'delete', index: 3 },
  ]);
  assert.deepStrictEqual(out.cases.map(c => c.name), ['get-happy', 'get-not-found', 'get-extra', 'create-happy']);
});

test('save: a stale etag -> conflict, the file on disk is byte-identical', () => {
  const dir = proj(files());
  const loaded = S.load(dir, ORDERS);
  fs.appendFileSync(path.join(dir, ORDERS), ' ');
  const before = fs.readFileSync(path.join(dir, ORDERS));
  const r = S.save(dir, ORDERS, loaded.etag, [{ op: 'update', index: 1, case: { name: 'x' } }]);
  assert.strictEqual(r.status, 'conflict');
  assert.ok(fs.readFileSync(path.join(dir, ORDERS)).equals(before));
});

test('save: the hash is re-checked just before the rename', () => {
  const dir = proj(files());
  const loaded = S.load(dir, ORDERS);
  const r = S.save(dir, ORDERS, loaded.etag, [{ op: 'update', index: 1, case: { name: 'x' } }], {
    beforeRename: () => fs.writeFileSync(path.join(dir, ORDERS), '{"cases":[],"hand":"edit"}\n'),
  });
  assert.strictEqual(r.status, 'conflict');
  assert.strictEqual(fs.readFileSync(path.join(dir, ORDERS), 'utf8'), '{"cases":[],"hand":"edit"}\n');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(path.join(dir, ORDERS))).filter(f => f.endsWith('.tmp')), []);
});

test('save: atomic temp + rename, returns the new etag; reload shows the same values', () => {
  const dir = proj(files());
  const loaded = S.load(dir, ORDERS);
  let sawTemp = false;
  const r = S.save(dir, ORDERS, loaded.etag, [{ op: 'update', index: 3, case: { params: { status: 'open' }, sources: { status: 'ui' } } }], {
    beforeRename: tmp => { sawTemp = fs.existsSync(tmp); },
  });
  assert.strictEqual(r.status, 'ok', JSON.stringify(r));
  assert.ok(sawTemp);
  const again = S.load(dir, ORDERS);
  assert.strictEqual(again.etag, r.etag);
  assert.deepStrictEqual(again.json.cases[2].sources, { status: 'ui' });
});

test('save: a non-canonical file -> needs-format-consent, then ok with acceptFormat', () => {
  const dir = proj({ ...files(), [ORDERS]: JSON.stringify(SUITE) });
  const loaded = S.load(dir, ORDERS);
  assert.strictEqual(loaded.canonical, false);
  const edits = [{ op: 'update', index: 1, case: { name: 'x' } }];
  assert.strictEqual(S.save(dir, ORDERS, loaded.etag, edits).status, 'needs-format-consent');
  assert.strictEqual(fs.readFileSync(path.join(dir, ORDERS), 'utf8'), JSON.stringify(SUITE));
  assert.strictEqual(S.save(dir, ORDERS, loaded.etag, edits, { acceptFormat: true }).status, 'ok');
});

test('never loads or writes a catalog or a path outside the suites folder', () => {
  const dir = proj(files());
  assert.throws(() => S.load(dir, 'integration/api_test_suites/orders/orders_api.json'), /suite/);
  assert.throws(() => S.save(dir, 'integration/api_test_suites/orders/orders_api.json', 'x', []), /suite/);
  assert.throws(() => S.load(dir, 'integration/api_test_suites/../../x_suite.json'), /suite/);
});

console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
