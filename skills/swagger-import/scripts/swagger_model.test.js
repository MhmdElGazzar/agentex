'use strict';
// Tests for swagger_model.js: the spec model behind import_swagger.js (legacy mode) and the
// suite wizard's four-kind generator (happy / not-found / no-token / missing-field).
// Run: node skills/swagger-import/scripts/swagger_model.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const M = require('./swagger_model.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
const golden = c => JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'import', c, 'spec.json'), 'utf8'));
const PET3 = golden('petstore-oa3');
const PET2 = golden('petstore-swagger2');
const model3 = () => M.parseSpec(PET3, 'spec.json');
const model2 = () => M.parseSpec(PET2, 'spec.json');
const byId = (ops, id) => ops.find(o => o.id === id);
const WRITE_SKIP = 'review: write operation — remove this line to enable';

test('parseSpec refuses a document that is neither Swagger 2.0 nor OpenAPI 3.x', () => {
  assert.throws(() => M.parseSpec({ hello: 'world' }, 'x.json'), /neither "swagger": "2.0" nor "openapi": "3.x"/);
});

test('listOperations: auth from global security, op-level security: [] = public', () => {
  const ops = M.listOperations(model3());
  assert.strictEqual(byId(ops, 'GET /pets').auth, 'token');
  assert.strictEqual(byId(ops, 'GET /store/inventory').auth, 'public');
  const noSec = M.listOperations(M.parseSpec({ openapi: '3.0.0', info: { title: 'x' }, paths: { '/a': { get: { responses: {} } }, '/b': { get: { security: [{ k: [] }], responses: {} } } } }, 's'));
  assert.strictEqual(byId(noSec, 'GET /a').auth, 'public');
  assert.strictEqual(byId(noSec, 'GET /b').auth, 'token');
});

test('listOperations: needs = path params, required query params, required top-level body fields', () => {
  const ops = M.listOperations(model3());
  assert.deepStrictEqual(byId(ops, 'GET /pets').needs.map(n => [n.param, n.in, n.type]), [['status', 'query', 'string']]);
  assert.deepStrictEqual(byId(ops, 'POST /pets').needs.map(n => [n.param, n.in, n.type]), [['name', 'body', 'string'], ['status', 'body', 'string']]);
  assert.deepStrictEqual(byId(ops, 'GET /pets/{petId}').needs.map(n => [n.param, n.in, n.type]), [['petId', 'path', 'integer']]);
  const ops2 = M.listOperations(model2());
  assert.deepStrictEqual(byId(ops2, 'POST /pet').needs.map(n => [n.param, n.in]), [['name', 'body']]);
  assert.deepStrictEqual(byId(ops2, 'GET /pet/findByStatus').needs.map(n => [n.param, n.in]), [['status', 'query']]);
});

test('listOperations: destructive = DELETE, a destructive verb, or x-destructive; write flag', () => {
  const ops = M.listOperations(model3());
  assert.strictEqual(byId(ops, 'DELETE /pets/{petId}').destructive, true);
  assert.strictEqual(byId(ops, 'POST /pets/{petId}/archive').destructive, true);
  assert.strictEqual(byId(ops, 'POST /pets').destructive, false);
  assert.strictEqual(byId(ops, 'POST /pets').write, true);
  assert.strictEqual(byId(ops, 'GET /pets').write, false);
  const verb = M.listOperations(M.parseSpec({ openapi: '3.0.0', info: { title: 'x' }, paths: {
    '/a': { post: { operationId: 'removeMember', responses: {} } },
    '/b': { put: { summary: 'Purge the cache', responses: {} } },
    '/c': { post: { operationId: 'addMember', summary: 'Add a member', responses: {} } },
  } }, 's'));
  assert.deepStrictEqual(verb.map(o => o.destructive), [true, true, false]);
});


test('destructive (F4): a verb or its -s/-d/-ed/-ing form in a path segment, summary or operationId flags any method', () => {
  const m = M.parseSpec({ openapi: '3.0.0', info: { title: 'x' }, paths: {
    '/items/{id}/delete': { post: { responses: {} } },
    '/items/delete-all': { post: { responses: {} } },
    '/internal/reset-cache': { get: { responses: {} } },
    '/cache/clear': { get: { responses: {} } },
    '/cache/flushing': { put: { responses: {} } },
    '/tokens': { post: { summary: 'Invalidates a token', responses: {} } },
    '/orders/{id}': { get: { summary: 'Get one order', responses: {} } },
    '/dropdowns': { get: { responses: {} } },
  } }, 's');
  const ops = M.listOperations(m);
  const flags = Object.fromEntries(ops.map(o => [o.id, o.destructive]));
  assert.deepStrictEqual(flags, { 'POST /items/{id}/delete': true, 'POST /items/delete-all': true, 'GET /internal/reset-cache': true, 'GET /cache/clear': true, 'PUT /cache/flushing': true, 'POST /tokens': true, 'GET /orders/{id}': false, 'GET /dropdowns': false });
  assert.strictEqual(byId(ops, 'GET /internal/reset-cache').write, false);
});

test('destructive (F4): selected anyway, every case of a destructive non-write operation carries skip', () => {
  const m = M.parseSpec({ openapi: '3.0.0', info: { title: 'x' }, servers: [{ url: 'http://h.test' }], paths: { '/internal/reset-cache': { get: { responses: { 200: { description: 'ok' } } } }, '/ping': { get: { responses: { 200: { description: 'ok' } } } } } }, 's');
  const out = M.generate(m, ['GET /internal/reset-cache', 'GET /ping'], {}, { name: 'svc' });
  const reset = out.suite.cases.filter(c => c.name.startsWith('get-internal-reset-cache'));
  assert.ok(reset.length > 0 && reset.every(c => c.skip === M.DESTRUCTIVE_SKIP), JSON.stringify(reset));
  assert.ok(out.suite.cases.filter(c => c.name.startsWith('get-ping')).every(c => !c.skip));
});

test('same record (B8): values from two groups -> summary.mismatches and a review note on each case; one group -> none', () => {
  const m = M.parseSpec({ openapi: '3.0.0', info: { title: 'x' }, servers: [{ url: 'http://h.test' }], paths: {
    '/shops/{shopId}/items/{itemId}': { get: { operationId: 'getItem', parameters: [
      { name: 'shopId', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'itemId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok' } } } },
    '/orders/{orderId}': { get: { operationId: 'getOrder', parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok' } } } },
  } }, 's');
  const vals = { shopId: { value: 7, source: 'project', group: 'a.log#url' }, itemId: { value: 98, source: 'project', group: 'b.log#url' }, orderId: { value: 5, source: 'project', group: 'c.json#$' } };
  const out = M.generate(m, ['GET /shops/{shopId}/items/{itemId}', 'GET /orders/{orderId}'], vals, { name: 'svc' });
  assert.deepStrictEqual(out.summary.mismatches, [{ id: 'GET /shops/{shopId}/items/{itemId}', params: { shopId: 'a.log#url', itemId: 'b.log#url' } }]);
  const item = out.suite.cases.filter(c => c.entry === 'svc.getitem');
  assert.ok(item.length > 0 && item.every(c => c.review.some(r => /different records/.test(r) && /404/.test(r))));
  assert.ok(out.suite.cases.filter(c => c.entry === 'svc.getorder').every(c => !(c.review || []).some(r => /different records/.test(r))));
  const same = M.generate(m, ['GET /shops/{shopId}/items/{itemId}'], { ...vals, itemId: { value: 98, source: 'project', group: 'a.log#url' } }, { name: 'svc' });
  assert.deepStrictEqual(same.summary.mismatches, []);
  assert.deepStrictEqual(M.needsReview(item[0]), false, 'needsReview keeps its definition');
});

const all = m => M.listOperations(m).map(o => o.id);
const casesFor = (out, id) => out.suite.cases.filter(c => c.entry === `petstore.${out.summary.endpoints.find(e => e.id === id).request}`);

test('happy: 2xx status plus the response schema\'s required fields', () => {
  const out = M.generate(model3(), ['GET /pets/{petId}'], { petId: { value: 7, source: 'ui' } }, { name: 'petstore' });
  const happy = out.suite.cases.find(c => c.kind === 'happy');
  assert.deepStrictEqual(happy.expect, { status: 200, fields: ['id', 'name'] });
  assert.deepStrictEqual(happy.params, { petId: 7 });
  assert.deepStrictEqual(happy.sources, { petId: 'ui' });
});

test('not-found only with an ID in the path; Auto IDs for integer / uuid / string', () => {
  const out = M.generate(model3(), all(model3()), {}, { name: 'petstore' });
  assert.strictEqual(casesFor(out, 'GET /pets').some(c => c.kind === 'not-found'), false);
  const nf = casesFor(out, 'GET /pets/{petId}').find(c => c.kind === 'not-found');
  assert.strictEqual(nf.expect.status, 404);
  assert.strictEqual(nf.params.petId, M.AUTO_IDS.integer);
  assert.strictEqual(nf.sources.petId, 'auto');
  const uuid = casesFor(out, 'POST /pets/{petId}/archive').find(c => c.kind === 'not-found');
  assert.strictEqual(uuid.params.petId, M.AUTO_IDS.uuid);
  const str = M.generate(M.parseSpec({ openapi: '3.0.0', info: { title: 'x' }, paths: { '/u/{slug}': { get: { parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: {} } } } } }, 's'), ['GET /u/{slug}'], {}, { name: 'x' });
  assert.strictEqual(str.suite.cases.find(c => c.kind === 'not-found').params.slug, M.AUTO_IDS.string);
});

test('no-token only when the operation requires auth; auth: "none", 401', () => {
  const out = M.generate(model3(), all(model3()), {}, { name: 'petstore' });
  assert.strictEqual(casesFor(out, 'GET /store/inventory').some(c => c.kind === 'no-token'), false);
  const nt = casesFor(out, 'GET /pets').find(c => c.kind === 'no-token');
  assert.strictEqual(nt.auth, 'none');
  assert.strictEqual(nt.expect.status, 401);
});

test('a public operation in a token catalog: its cases carry auth "none" (no credential needed)', () => {
  const out = M.generate(model3(), ['GET /store/inventory', 'GET /pets'], {}, { name: 'petstore' });
  const inv = out.suite.cases.filter(c => c.entry === 'petstore.getinventory');
  assert.ok(inv.length && inv.every(c => c.auth === 'none'), JSON.stringify(inv));
  assert.strictEqual(out.suite.cases.find(c => c.entry === 'petstore.listpets' && c.kind === 'happy').auth, undefined);
});

test('missing-field: the first required query param or top-level body field, with omit set', () => {
  const out = M.generate(model3(), all(model3()), {}, { name: 'petstore' });
  const q = casesFor(out, 'GET /pets').find(c => c.kind === 'missing-field');
  assert.deepStrictEqual(q.omit, ['status']);
  assert.strictEqual(q.expect.status, 400);
  const b = casesFor(out, 'POST /pets').find(c => c.kind === 'missing-field');
  assert.deepStrictEqual(b.omit, ['name']);
  assert.strictEqual(casesFor(out, 'GET /pets/{petId}').some(c => c.kind === 'missing-field'), false);
});

test('every case of a write operation carries the write skip; read cases do not', () => {
  const out = M.generate(model3(), all(model3()), {}, { name: 'petstore' });
  for (const c of out.suite.cases) {
    const write = /^(POST|PUT|PATCH|DELETE) /.test(out.summary.endpoints.find(e => e.request === c.entry.split('.')[1]).id);
    assert.strictEqual(c.skip, write ? WRITE_SKIP : undefined, c.name);
  }
});

test('error message from OpenAPI 3 example / examples and Swagger 2 examples', () => {
  const out = M.generate(model3(), all(model3()), {}, { name: 'petstore' });
  assert.deepStrictEqual(casesFor(out, 'GET /pets/{petId}').find(c => c.kind === 'not-found').expect, { status: 404, equals: { message: 'Pet not found' } });
  assert.deepStrictEqual(casesFor(out, 'GET /pets').find(c => c.kind === 'missing-field').expect, { status: 400, contains: { message: 'status is required' } });
  assert.deepStrictEqual(casesFor(out, 'POST /pets').find(c => c.kind === 'missing-field').expect, { status: 400, contains: { message: 'name must not be empty' } });
  const out2 = M.generate(model2(), ['GET /pet/{petId}'], {}, { name: 'petstore' });
  assert.deepStrictEqual(out2.suite.cases.find(c => c.kind === 'not-found').expect, { status: 404, equals: { message: 'Pet not found' } });
});

test('message path detection: message, error.message, detail, title, error', () => {
  assert.deepStrictEqual(M.messageOf({ code: 1, message: 'a' }), { path: 'message', text: 'a' });
  assert.deepStrictEqual(M.messageOf({ error: { message: 'b' } }), { path: 'error.message', text: 'b' });
  assert.deepStrictEqual(M.messageOf({ detail: 'c', title: 'd' }), { path: 'detail', text: 'c' });
  assert.deepStrictEqual(M.messageOf({ title: 'd' }), { path: 'title', text: 'd' });
  assert.deepStrictEqual(M.messageOf({ error: 'e' }), { path: 'error', text: 'e' });
  assert.strictEqual(M.messageOf({ code: 3 }), null);
  assert.strictEqual(M.messageOf('plain'), null);
});

test('no documented example -> status-only case with a review note', () => {
  const out = M.generate(model3(), ['DELETE /pets/{petId}'], {}, { name: 'petstore' });
  const nf = out.suite.cases.find(c => c.kind === 'not-found');
  assert.deepStrictEqual(nf.expect, { status: 404 });
  assert.ok(nf.review.some(n => /no documented 404 message/.test(n)), JSON.stringify(nf.review));
});

test('collected values carry their source; a missing value is a placeholder', () => {
  const out = M.generate(model3(), ['GET /pets'], { status: { value: 'sold', source: 'project' } }, { name: 'petstore' });
  assert.deepStrictEqual(out.suite.cases.find(c => c.kind === 'happy').sources, { status: 'project' });
  const out2 = M.generate(model3(), ['GET /pets'], {}, { name: 'petstore' });
  const happy = out2.suite.cases.find(c => c.kind === 'happy');
  assert.deepStrictEqual(happy.sources, { status: 'placeholder' });
  assert.strictEqual(happy.params.status, 'available');
  assert.strictEqual(out2.summary.review, 2);
  assert.strictEqual(out2.summary.ready, 1); // the missing-field case omits the placeholder
});

test('needsReview (N10): not skipped and still a placeholder value; a skipped case is Skipped only', () => {
  const ph = { sources: { id: 'placeholder' } };
  assert.strictEqual(M.needsReview(ph), true);
  assert.strictEqual(M.needsReview({ ...ph, skip: 'review: write operation — remove this line to enable' }), false);
  assert.strictEqual(M.needsReview({ ...ph, omit: ['id'] }), false);
  assert.strictEqual(M.needsReview({ sources: { id: 'ui' } }), false);
  assert.strictEqual(M.needsReview(undefined), false);
  const out = M.generate(model3(), ['POST /pets'], {}, { name: 'petstore' });
  assert.ok(out.suite.cases.some(c => c.skip && Object.values(c.sources || {}).includes('placeholder')));
  assert.strictEqual(out.summary.review, 0);
  assert.ok(out.summary.endpoints[0].cases.every(c => c.skipped && !c.needsReview));
});

test('$param body nodes are typed from the schema; params are the needs only', () => {
  const out = M.generate(model3(), ['POST /pets'], { name: { value: 'Rex', source: 'manual' }, status: { value: 'sold', source: 'ui' } }, { name: 'petstore' });
  const req = out.catalog.requests[0];
  assert.deepStrictEqual(req.body, { name: { $param: 'name', type: 'string' }, status: { $param: 'status', type: 'string' } });
  assert.deepStrictEqual(req.params, ['name', 'status']);
  const typed = M.generate(M.parseSpec({ openapi: '3.0.0', info: { title: 'x' }, paths: { '/o': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['qty', 'price', 'rush', 'item', 'tags'], properties: { qty: { type: 'integer' }, price: { type: 'number' }, rush: { type: 'boolean' }, item: { type: 'object' }, tags: { type: 'array' } } } } } }, responses: { 201: {} } } } } }, 's'), ['POST /o'], {}, { name: 'x' });
  assert.deepStrictEqual(Object.values(typed.catalog.requests[0].body).map(n => n.type), ['integer', 'number', 'boolean', 'json', 'json']);
});

test('tokenStore is set when the spec has bearer/apiKey auth or a token was captured', () => {
  const out = M.generate(model3(), ['GET /pets'], {}, { name: 'petstore' });
  assert.deepStrictEqual(out.catalog.auth, { type: 'bearer', tokenEnv: 'PETSTORE_TOKEN', tokenStore: 'petstore' });
  const out2 = M.generate(model2(), ['GET /pet/{petId}'], {}, { name: 'petstore-two' });
  assert.deepStrictEqual(out2.catalog.auth, { type: 'apiKey', headerName: 'api_key', tokenEnv: 'PETSTORE_TWO_TOKEN', tokenStore: 'petstore-two' });
  const none = M.parseSpec({ openapi: '3.0.0', info: { title: 'x' }, paths: { '/a': { get: { responses: { 200: {} } } } } }, 's');
  assert.deepStrictEqual(M.generate(none, ['GET /a'], {}, { name: 'x' }).catalog.auth, { type: 'none' });
  assert.deepStrictEqual(M.generate(none, ['GET /a'], {}, { name: 'x', capturedToken: { scheme: 'bearer' } }).catalog.auth, { type: 'bearer', tokenEnv: 'X_TOKEN', tokenStore: 'x' });
});

test('catalog targets its own base URL env var; summary counts by kind and source', () => {
  const out = M.generate(model3(), all(model3()), { status: { value: 'sold', source: 'ui' }, petId: { value: 3, source: 'project' } }, { name: 'petstore' });
  assert.strictEqual(out.catalog.target, 'catalog');
  assert.strictEqual(out.catalog.baseUrl, '${PETSTORE_BASE_URL}');
  assert.strictEqual(out.summary.baseUrlVar, 'PETSTORE_BASE_URL');
  assert.strictEqual(out.summary.baseUrlLiteral, 'https://api.example.test/v1');
  const k = out.summary.byKind;
  assert.strictEqual(k.happy + k['not-found'] + k['no-token'] + k['missing-field'], out.summary.total);
  assert.strictEqual(out.summary.ready + out.summary.review + out.summary.skipped, out.summary.total);
  assert.strictEqual(out.summary.bySource.ui, 1);
  assert.strictEqual(out.summary.bySource.project, 1);
  assert.ok(out.summary.bySource.auto >= 1);
});

test('legacy mode reproduces the importer case set (happy-path + error-case)', () => {
  const out = M.generateLegacy(model3(), { name: 'petstore' });
  assert.ok(out.suite.cases.every(c => /-(happy-path|error-case)$/.test(c.name)));
  assert.strictEqual(out.catalog.target, 'catalog');
});

// A server that accepts the request and never answers (127.0.0.1 only): the fetch must end
// in SpecError within the bound, not hang.
(async () => {
  const http = require('node:http');
  const server = http.createServer(() => {});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/spec.json`;
  const t0 = Date.now();
  try {
    await M.loadSpec(url, { timeoutMs: 300 });
    failures.push('hung server'); console.error('  FAIL - hung server: loadSpec resolved');
  } catch (e) {
    try {
      assert.ok(e instanceof M.SpecError, `not a SpecError: ${e && e.message}`);
      assert.match(e.message, /timed out after 0\.3 s/);
      assert.ok(e.message.includes(url));
      assert.ok(Date.now() - t0 < 5000, 'took too long');
      passed++; console.log('  ok - a spec URL that never answers ends in SpecError "timed out" within the bound');
    } catch (a) { failures.push('hung server'); console.error(`  FAIL - hung server: ${a.message}`); }
  }
  server.closeAllConnections && server.closeAllConnections();
  server.close();
  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
