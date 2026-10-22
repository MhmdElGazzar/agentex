'use strict';
// Tests for studio/wizard.js — "New suite from Swagger": steps 1, 2, 4, 5 on the server alone.
// Run: node skills/endpoint-testing/scripts/studio/wizard.test.js
const { assert, fs, path, http, harness, proj, treeOf, studio, waitRun } = require('./test_helpers.js');
const { test, done } = harness();

const PET = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'swagger-import', 'scripts', 'fixtures', 'golden', 'petstore-oa3', 'spec.json'), 'utf8'));
// The spec server counts its requests; the "service" behind the spec counts its own.
function servers() {
  return new Promise(resolve => {
    const specHits = []; const apiHits = [];
    const api = http.createServer((q, res) => {
      apiHits.push(`${q.method} ${q.url}`);
      res.setHeader('content-type', 'application/json');
      if (q.url.startsWith('/v1/store/inventory')) return res.end('{"total":3}');
      res.writeHead(404); res.end('{"message":"Pet not found"}');
    });
    api.listen(0, '127.0.0.1', () => {
      const apiPort = api.address().port;
      const spec = { ...PET, servers: [{ url: `http://127.0.0.1:${apiPort}/v1` }] };
      const specSrv = http.createServer((q, res) => { specHits.push(q.url); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(spec)); });
      specSrv.listen(0, '127.0.0.1', () => resolve({ specUrl: `http://127.0.0.1:${specSrv.address().port}/openapi.json`, apiPort, specHits, apiHits,
        close: () => { api.close(); specSrv.close(); api.closeAllConnections(); specSrv.closeAllConnections(); } }));
    });
  });
}
const project = (extra = {}) => proj({
  '.gitignore': '.agentex/\ntest/.auth/\n',
  'config/project.json': { defaultEnvironment: 'qc' },
  'environments/qc.json': { portalUrl: 'https://app.example.test', users: { qa_user_a: { email: 'qa_user_a@example.test' }, qa_user_b: { email: 'qa_user_b@example.test' } } },
  'environments/uat.json': { portalUrl: 'https://app.example.test', users: {} },
  ...extra,
});
const ALL_SAFE = ['GET /pets', 'POST /pets', 'GET /pets/{petId}', 'GET /store/inventory'];

(async () => {
  await test('step 1 needs an environment picked from the project (no silent default)', async () => {
    const sv = await servers();
    const s = await studio(project(), { mode: 'wizard' });
    const none = await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets' });
    const bad = await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets', env: 'prod' });
    sv.close();
    assert.strictEqual(none.status, 400); assert.strictEqual(none.json.error, 'env');
    assert.strictEqual(bad.status, 400); assert.match(bad.json.message, /qc, uat/);
    assert.strictEqual(sv.specHits.length, 0);
  });

  await test('steps 1-4: exactly one outbound request (the spec), no service call, no file written', async () => {
    const sv = await servers();
    const dir = project();
    const before = treeOf(dir);
    const s = await studio(dir, { mode: 'wizard' });
    const r1 = await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets', env: 'qc' });
    assert.strictEqual(r1.status, 200, r1.text);
    assert.deepStrictEqual(r1.json.files, { catalog: 'integration/api_test_suites/pets/pets_api.json', suite: 'integration/api_test_suites/pets/pets_suite.json' });
    const r2 = await s.page('POST', '/api/wizard/select', { selection: ALL_SAFE });
    assert.strictEqual(r2.status, 200);
    await s.page('POST', '/api/wizard/value', { param: 'status', value: 'sold', source: 'manual' });
    await s.page('POST', '/api/wizard/collect', { user: 'qa_user_a' });
    await s.page('GET', '/api/wizard/state');
    const r4 = await s.page('GET', '/api/wizard/preview');
    assert.strictEqual(r4.status, 200, r4.text);
    sv.close();
    assert.strictEqual(sv.specHits.length, 1);
    assert.strictEqual(sv.apiHits.length, 0);
    assert.deepStrictEqual(treeOf(dir), before);
  });

  await test('step 2 lists every operation with auth, needs and the AC4 flags; Next needs one', async () => {
    const sv = await servers();
    const s = await studio(project(), { mode: 'wizard' });
    const r1 = await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets', env: 'qc' });
    sv.close();
    const byId = Object.fromEntries(r1.json.ops.map(o => [o.id, o]));
    assert.strictEqual(r1.json.ops.length, 6);
    assert.strictEqual(byId['DELETE /pets/{petId}'].destructive, true);
    assert.strictEqual(byId['POST /pets/{petId}/archive'].destructive, true);
    assert.deepStrictEqual([byId['POST /pets'].write, byId['POST /pets'].destructive], [true, false]);
    assert.strictEqual(byId['GET /store/inventory'].auth, 'public');
    assert.deepStrictEqual(byId['GET /pets/{petId}'].needs.map(n => n.param), ['petId']);
    const none = await s.page('POST', '/api/wizard/select', { selection: [] });
    assert.strictEqual(none.status, 400); assert.strictEqual(none.json.error, 'pick-one');
  });

  await test('step 3 without an attached agent: collect answers no-agent; typed and placeholder values are kept', async () => {
    const sv = await servers();
    const s = await studio(project(), { mode: 'wizard' });
    await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets', env: 'qc' });
    await s.page('POST', '/api/wizard/select', { selection: ['GET /pets/{petId}', 'GET /pets'] });
    sv.close();
    const c = await s.page('POST', '/api/wizard/collect', { user: 'qa_user_a' });
    assert.deepStrictEqual([c.json.ok, c.json.error], [false, 'no-agent']);
    assert.strictEqual((await s.page('GET', '/api/wizard/state')).json.attached, false);
    await s.page('POST', '/api/wizard/value', { param: 'petId', value: '7', source: 'manual' });
    await s.page('POST', '/api/wizard/value', { param: 'status', source: 'placeholder' });
    const p = (await s.page('GET', '/api/wizard/preview')).json;
    assert.strictEqual(p.summary.bySource.manual, 1);
    assert.strictEqual(p.summary.bySource.placeholder, 1);
    const tok = await s.page('POST', '/api/wizard/value', { param: 'petId', value: 'Bearer abcdefghijklmnop', source: 'manual' });
    assert.strictEqual(tok.json.error, 'credential-shaped');
  });

  await test('step 4 preview: totals, kinds and per-endpoint cases with skip/review markers', async () => {
    const sv = await servers();
    const s = await studio(project(), { mode: 'wizard' });
    await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets', env: 'qc' });
    await s.page('POST', '/api/wizard/select', { selection: ALL_SAFE });
    sv.close();
    const p = (await s.page('GET', '/api/wizard/preview')).json;
    const sm = p.summary;
    assert.strictEqual(sm.ready + sm.review + sm.skipped, sm.total);
    assert.ok(sm.byKind.happy === 4 && sm.byKind['no-token'] === 3 && sm.byKind['not-found'] === 1 && sm.byKind['missing-field'] === 2, JSON.stringify(sm.byKind));
    const post = sm.endpoints.find(e => e.id === 'POST /pets');
    assert.ok(post.cases.every(c => c.skipped));
    assert.strictEqual(p.baseUrl.var, 'PETS_BASE_URL');
    assert.strictEqual(p.baseUrl.isSet, false);
  });

  await test('step 5 approve: both files with wx, store with schemaVersion, .env line only when unset, filter needs-review', async () => {
    const sv = await servers();
    const dir = project({ '.env': 'OTHER=1' });
    const s = await studio(dir, { mode: 'wizard' });
    await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets', env: 'qc' });
    await s.page('POST', '/api/wizard/select', { selection: ALL_SAFE });
    await s.page('POST', '/api/wizard/value', { param: 'petId', value: '7', source: 'manual' });
    const a = await s.page('POST', '/api/wizard/approve', { baseUrl: `http://127.0.0.1:${sv.apiPort}/v1` });
    sv.close();
    assert.strictEqual(a.status, 200, a.text);
    assert.strictEqual(a.json.filter, 'needs-review');
    const cat = JSON.parse(fs.readFileSync(path.join(dir, a.json.catalogPath), 'utf8'));
    assert.strictEqual(cat.target, 'catalog');
    assert.strictEqual(cat.baseUrl, '${PETS_BASE_URL}');
    const suite = JSON.parse(fs.readFileSync(path.join(dir, a.json.suitePath), 'utf8'));
    assert.ok(suite.cases.some(c => c.kind === 'no-token' && c.auth === 'none'));
    assert.strictEqual(fs.readFileSync(path.join(dir, '.env'), 'utf8'), `OTHER=1\nPETS_BASE_URL=http://127.0.0.1:${sv.apiPort}/v1\n`);
    const store = JSON.parse(fs.readFileSync(path.join(dir, '.agentex/cache/api-data/pets.json'), 'utf8'));
    assert.strictEqual(store.schemaVersion, 1);
    assert.ok(store.missing.some(m => m.param === 'status' && m.cases > 0));
    assert.strictEqual(sv.apiHits.length, 0, 'no request until Run');
  });

  await test('step 5: an existing value in .env is never changed and no line is added', async () => {
    const sv = await servers();
    const dir = project({ '.env': 'PETS_BASE_URL=http://keep.example.test\n' });
    const s = await studio(dir, { mode: 'wizard' });
    await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets', env: 'qc' });
    await s.page('POST', '/api/wizard/select', { selection: ['GET /store/inventory'] });
    sv.close();
    const p = (await s.page('GET', '/api/wizard/preview')).json;
    assert.strictEqual(p.baseUrl.isSet, true);
    const a = await s.page('POST', '/api/wizard/approve', { baseUrl: 'http://other.example.test' });
    assert.strictEqual(a.json.envLineAdded, false);
    assert.strictEqual(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'PETS_BASE_URL=http://keep.example.test\n');
    assert.strictEqual(a.json.filter, 'all');
  });

  await test('step 5: an existing file disables approval; the existing file stays byte-identical', async () => {
    const sv = await servers();
    const dir = project({ 'integration/api_test_suites/pets/pets_suite.json': '{"hand":"written"}' });
    const s = await studio(dir, { mode: 'wizard' });
    const r1 = await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets', env: 'qc' });
    await s.page('POST', '/api/wizard/select', { selection: ['GET /store/inventory'] });
    sv.close();
    assert.deepStrictEqual(r1.json.exists, { catalog: false, suite: true });
    assert.strictEqual((await s.page('GET', '/api/wizard/preview')).json.exists.suite, true);
    const a = await s.page('POST', '/api/wizard/approve', {});
    assert.strictEqual(a.status, 409);
    assert.strictEqual(a.json.error, 'exists');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'integration/api_test_suites/pets/pets_suite.json'), 'utf8'), '{"hand":"written"}');
    assert.ok(!fs.existsSync(path.join(dir, 'integration/api_test_suites/pets/pets_api.json')));
  });

  await test('step 5: "Approve and run now" runs the new suite only', async () => {
    const sv = await servers();
    const dir = project({ '.env': '', 'integration/api_test_suites/other/other_suite.json': { cases: [{ name: 'x', entry: 'other.x', expect: { status: 200 } }] } });
    const s = await studio(dir, { mode: 'wizard' });
    await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets', env: 'qc' });
    await s.page('POST', '/api/wizard/select', { selection: ['GET /store/inventory'] });
    const a = await s.page('POST', '/api/wizard/approve', { baseUrl: `http://127.0.0.1:${sv.apiPort}/v1`, run: true });
    assert.ok(a.json.runId, a.text);
    const r = await waitRun(s.page, a.json.runId);
    sv.close();
    assert.strictEqual(r.result.suite, 'integration/api_test_suites/pets/pets_suite.json');
    assert.deepStrictEqual(r.result.cases.map(c => [c.name, c.result]), [["getinventory-happy", "PASS"]], JSON.stringify(r.result));
    assert.deepStrictEqual(sv.apiHits, ['GET /v1/store/inventory']);
  });

  await test('the wizard page is served in Arabic by default, with the spec prefilled when given', async () => {
    const s = await studio(project(), { mode: 'wizard', spec: 'specs/orders.json' });
    const html = (await require('./test_helpers.js').req(s.st.port, 'GET', '/wizard')).text;
    assert.match(html, /<html lang="ar" dir="rtl">/);
    assert.ok(html.includes("spec: 'specs/orders.json'"));
  });

  done();
})();
