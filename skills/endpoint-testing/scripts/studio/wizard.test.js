'use strict';
// Tests for studio/wizard.js — "New suite from Swagger": steps 1, 2, 4, 5 on the server alone.
// Run: node skills/endpoint-testing/scripts/studio/wizard.test.js
const { assert, fs, path, http, harness, proj, treeOf, req, studio, waitRun } = require('../golden/studio_helpers.js');
const { test, done } = harness();

const PET = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'swagger-import', 'scripts', 'golden', 'import', 'petstore-oa3', 'spec.json'), 'utf8'));
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
    // S-6: the run came from the wizard, and result.md says so
    const md = fs.readFileSync(path.join(dir, r.runDir, 'result.md'), 'utf8');
    assert.ok(md.includes('run from the suite wizard'), md);
    assert.ok(!md.includes('run from the editor'), md);
  });

  await test('the wizard page is served in Arabic by default, with the spec prefilled when given', async () => {
    const s = await studio(project(), { mode: 'wizard', spec: 'specs/orders.json' });
    const html = (await require('../golden/studio_helpers.js').req(s.st.port, 'GET', '/wizard')).text;
    assert.match(html, /<html lang="ar" dir="rtl">/);
    assert.ok(html.includes("spec: 'specs/orders.json'"));
  });

  // ---- step 3 with the agent: the Q21 guard and consent (agent routes driven directly) ----
  async function collectRun(envJson) {
    const sv = await servers();
    const dir = proj({ '.gitignore': '.agentex/\ntest/.auth/\n', 'environments/qc.json': { portalUrl: 'https://app.example.test', users: { qa_user_a: {} }, ...envJson } });
    const s = await studio(dir, { mode: 'wizard' });
    await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets', env: 'qc' });
    await s.page('POST', '/api/wizard/select', { selection: ['GET /pets/{petId}', 'GET /pets'] });
    sv.close();
    await s.agent('GET', '/api/agent/next?timeout=10'); // attach
    const c = await s.page('POST', '/api/wizard/collect', { user: 'qa_user_a' });
    const ev = (await s.agent('GET', '/api/agent/next?timeout=50')).json;
    assert.strictEqual(ev.event, 'collect');
    const post = (event, payload) => s.agent('POST', '/api/agent/event', { event, payload: { runId: c.json.runId, ...payload } });
    return { s, dir, runId: c.json.runId, post };
  }
  const ITEMS = [{ what: 'Pet with status sold', screen: 'New pet' }, { what: 'Second pet', screen: 'New pet' }];

  for (const [label, envJson] of [['missing', {}], ['the string "true"', { nonProduction: 'true' }], ['false', { nonProduction: false }]]) {
    await test(`Q21 guard: nonProduction ${label} -> the proposal is refused naming the field and the file; collecting goes on`, async () => {
      const { s, post } = await collectRun(envJson);
      const r = await post('proposal', { items: ITEMS });
      assert.strictEqual(r.json.error, 'refused');
      assert.strictEqual(r.json.field, 'nonProduction');
      assert.strictEqual(r.json.file, 'environments/qc.json');
      const st = (await s.page('GET', '/api/wizard/state')).json;
      assert.deepStrictEqual(st.run.refused && [st.run.refused.field, st.run.refused.file], ['nonProduction', 'environments/qc.json']);
      assert.strictEqual(st.run.proposal, null);
      assert.strictEqual((await post('value', { param: 'petId', value: 3, source: 'ui' })).json.ok, true);
      assert.strictEqual((await post('proposal', { items: ITEMS })).json.error, 'one-proposal-per-run');
    });
  }

  await test('Q21 consent: one proposal per run; the consent echoes the exact list; created outside it is refused and flagged', async () => {
    const { s, dir, post } = await collectRun({ nonProduction: true });
    const pr = await post('proposal', { items: ITEMS });
    assert.strictEqual(pr.json.ok, true, pr.text);
    assert.strictEqual((await post('proposal', { items: ITEMS })).json.error, 'one-proposal-per-run');
    const st = (await s.page('GET', '/api/wizard/state')).json;
    assert.deepStrictEqual(st.run.proposal.items, ITEMS);
    await s.page('POST', '/api/wizard/consent', { proposalId: pr.json.proposalId, decision: 'yes' });
    const ev = (await s.agent('GET', '/api/agent/next?timeout=50')).json;
    assert.deepStrictEqual(ev, { event: 'consent', runId: st.run.runId, proposalId: pr.json.proposalId, decision: 'yes', items: ITEMS });
    assert.strictEqual((await post('created', { proposalId: pr.json.proposalId, index: 0 })).json.ok, true);
    const out = await post('created', { proposalId: pr.json.proposalId, index: 7, what: 'A customer account' });
    assert.strictEqual(out.json.error, 'not-consented');
    const after = (await s.page('GET', '/api/wizard/state')).json;
    assert.deepStrictEqual(after.run.violations.map(v => v.what), ['A customer account']);
    assert.deepStrictEqual(after.run.created.map(c => c.what), ['Pet with status sold']);
    await post('ended', { found: 1, total: 2 });
    await s.page('POST', '/api/wizard/value', { param: 'petId', value: '3', source: 'manual' });
    const a = await s.page('POST', '/api/wizard/approve', {});
    assert.strictEqual(a.status, 200, a.text);
    const store = JSON.parse(fs.readFileSync(path.join(dir, '.agentex/cache/api-data/pets.json'), 'utf8'));
    assert.deepStrictEqual(store.consents.map(c => [c.decision, c.items.length, c.created]), [['yes', 2, [0]]]);
  });

  await test('Q21 consent "no": nothing may be created; Collect again opens a new run that may ask again (A19)', async () => {
    const { s, post } = await collectRun({ nonProduction: true });
    const pr = await post('proposal', { items: ITEMS });
    await s.page('POST', '/api/wizard/consent', { proposalId: pr.json.proposalId, decision: 'no' });
    assert.strictEqual((await s.agent('GET', '/api/agent/next?timeout=50')).json.decision, 'no');
    assert.strictEqual((await post('created', { proposalId: pr.json.proposalId, index: 0 })).json.error, 'not-consented');
    await post('ended', { found: 0, total: 2 });
    const again = await s.page('POST', '/api/wizard/collect-again', { all: false, user: 'qa_user_a' });
    assert.strictEqual(again.json.ok, true, again.text);
    const ev = (await s.agent('GET', '/api/agent/next?timeout=50')).json;
    assert.strictEqual(ev.event, 'collect-again');
    assert.deepStrictEqual(ev.needs.map(n => n.param).sort(), ['petId', 'status']);
    const pr2 = await s.agent('POST', '/api/agent/event', { event: 'proposal', payload: { runId: again.json.runId, items: ITEMS.slice(0, 1) } });
    assert.strictEqual(pr2.json.ok, true);
  });

  await test('gate: the page shows it and "I\'ve completed the login" reaches the agent; failed keeps the wizard going', async () => {
    const { s, post } = await collectRun({});
    await post('gate', { kind: 'captcha', text: 'a captcha is shown' });
    assert.strictEqual((await s.page('GET', '/api/wizard/state')).json.run.gate.kind, 'captcha');
    await s.page('POST', '/api/wizard/gate-cleared', {});
    assert.strictEqual((await s.agent('GET', '/api/agent/next?timeout=50')).json.event, 'gate-cleared');
    await post('failed', { reason: 'the browser is not available' });
    const st = (await s.page('GET', '/api/wizard/state')).json;
    assert.deepStrictEqual([st.run.status, st.run.reason], ['failed', 'the browser is not available']);
    assert.strictEqual((await s.page('GET', '/api/wizard/preview')).status, 200);
  });

  await test('failed is final: a later ended does not overwrite it; the state the page reads still carries the failure note', async () => {
    const { s, post } = await collectRun({});
    await post('failed', { reason: 'the login did not work' });
    const late = await post('ended', { found: 0, total: 2 });
    assert.strictEqual(late.json.ok, true);
    const st = (await s.page('GET', '/api/wizard/state')).json;
    assert.deepStrictEqual([st.run.status, st.run.reason], ['failed', 'the login did not work']);
    assert.strictEqual(st.run.found, undefined);
  });

  await test('the captured token is held in memory, never in a response, and written only to its 0600 file at approval', async () => {
    const SENT = 'EVAL_SENTINEL_TOKEN_wizard_59';
    const { s, dir, post } = await collectRun({});
    const t = await s.agent('POST', '/api/agent/token', { token: SENT, scheme: 'bearer', headerName: 'Authorization', apiOrigin: 'https://api.example.test' });
    assert.deepStrictEqual(t.json, { ok: true });
    await post('ended', { found: 0, total: 2 });
    const st = await s.page('GET', '/api/wizard/state');
    const pv = await s.page('GET', '/api/wizard/preview');
    assert.ok(!st.text.includes(SENT) && !pv.text.includes(SENT));
    assert.strictEqual(pv.json.baseUrl.suggested, 'https://api.example.test/v1');
    const a = await s.page('POST', '/api/wizard/approve', {});
    assert.ok(!a.text.includes(SENT));
    assert.strictEqual(a.json.tokenRef, 'pets-qc');
    const tok = JSON.parse(fs.readFileSync(path.join(dir, 'test/.auth/api-tokens/pets-qc.json'), 'utf8'));
    assert.strictEqual(tok.token, SENT);
    for (const f of ['integration/api_test_suites/pets/pets_api.json', 'integration/api_test_suites/pets/pets_suite.json', '.agentex/cache/api-data/pets.json']) {
      assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes(SENT), f);
    }
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'integration/api_test_suites/pets/pets_api.json'), 'utf8')).auth.tokenStore, 'pets');
  });

  await test('a store path that is not gitignored is refused and named; the suite and catalog are still written', async () => {
    const sv = await servers();
    const dir = proj({ '.gitignore': 'node_modules/\n', 'environments/qc.json': { users: {} } });
    const s = await studio(dir, { mode: 'wizard' });
    await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets', env: 'qc' });
    await s.page('POST', '/api/wizard/select', { selection: ['GET /store/inventory'] });
    sv.close();
    await s.agent('POST', '/api/agent/token', { token: 'tok-not-persisted-123', scheme: 'bearer' });
    const a = await s.page('POST', '/api/wizard/approve', {});
    assert.deepStrictEqual(a.json.notIgnored, ['test/.auth/api-tokens/pets-qc.json', '.agentex/cache/api-data/pets.json']);
    assert.ok(!fs.existsSync(path.join(dir, 'test')) && !fs.existsSync(path.join(dir, '.agentex')));
    assert.ok(fs.existsSync(path.join(dir, 'integration/api_test_suites/pets/pets_suite.json')));
  });

  // N10: a skipped case counts under Skipped only — never under Needs review — on both pages.
  // One suite: GET /items (public, required query q, nothing collected) gives an unskipped
  // placeholder case; POST /items (a write, so skipped, required body field name) gives a
  // skipped placeholder case. Wizard step 4, the landing filter, the editor's list counts, its
  // filter rows and the editor page's own predicate must all say 1.
  const ITEMS_SPEC = {
    openapi: '3.0.0', info: { title: 'Items' }, servers: [{ url: 'http://127.0.0.1:1/v1' }],
    paths: { '/items': {
      get: { operationId: 'listItems', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: {} } },
      post: { operationId: 'addItem', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } }, responses: { 201: {} } },
    } },
  };
  const itemsSpec = () => new Promise(resolve => {
    const srv = http.createServer((q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(ITEMS_SPEC)); });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/openapi.json`, close: () => { srv.close(); srv.closeAllConnections(); } }));
  });
  const vm = require('node:vm');

  await test('N10: "Needs review" excludes skipped cases — wizard step 4, landing filter, editor counts, rows and page agree (1)', async () => {
    const sp = await itemsSpec();
    const dir = project();
    const s = await studio(dir, { mode: 'wizard' });
    await s.page('POST', '/api/wizard/spec', { source: sp.url, suiteName: 'Items', env: 'qc' });
    await s.page('POST', '/api/wizard/select', { selection: ['GET /items', 'POST /items'] });
    sp.close();
    const sm = (await s.page('GET', '/api/wizard/preview')).json.summary;
    const flagged = sm.endpoints.flatMap(e => e.cases).filter(c => c.needsReview);
    assert.strictEqual(sm.review, 1, JSON.stringify(sm));
    assert.strictEqual(flagged.length, 1, JSON.stringify(sm.endpoints));
    assert.ok(flagged.every(c => !c.skipped), 'a skipped case is never flagged needs review');
    const a = await s.page('POST', '/api/wizard/approve', {});
    assert.strictEqual(a.status, 200, a.text);
    assert.strictEqual(a.json.filter, 'needs-review');
    const suite = JSON.parse(fs.readFileSync(path.join(dir, a.json.suitePath), 'utf8'));
    const placeholder = c => Object.values(c.sources || {}).includes('placeholder');
    assert.ok(suite.cases.some(c => c.skip && placeholder(c)) && suite.cases.some(c => !c.skip && placeholder(c)), 'fixture has both kinds');

    const listed = (await s.page('GET', '/api/suites')).json.suites.find(x => x.path === a.json.suitePath);
    assert.strictEqual(listed.needsReview, 1, JSON.stringify(listed));
    const S = require('./suite_store.js');
    assert.strictEqual(suite.cases.filter(c => S.matchesFilter(c, null, 'needs-review')).length, 1);

    // the editor page counts with the predicate the server injects into it
    const html = (await req(s.st.port, 'GET', '/editor')).text;
    const at = html.indexOf('const needsReview = ');
    assert.ok(at > 0, 'the page declares needsReview');
    const src = html.slice(at, html.indexOf('; // shared', at));
    const pageNeedsReview = vm.runInNewContext(`(${src.slice('const needsReview = '.length)})`);
    assert.strictEqual(suite.cases.filter(pageNeedsReview).length, 1);
    assert.match(html, /if \(f === 'needs-review'\) return needsReview\(c\);/);
    s.close();
  });

  await test('N10: a suite whose only placeholder case is skipped lands on the "all" filter (AC18)', async () => {
    const sp = await itemsSpec();
    const dir = project();
    const s = await studio(dir, { mode: 'wizard' });
    await s.page('POST', '/api/wizard/spec', { source: sp.url, suiteName: 'Items', env: 'qc' });
    await s.page('POST', '/api/wizard/select', { selection: ['POST /items'] });
    sp.close();
    assert.strictEqual((await s.page('GET', '/api/wizard/preview')).json.summary.review, 0);
    const a = await s.page('POST', '/api/wizard/approve', {});
    assert.strictEqual(a.json.filter, 'all');
    assert.strictEqual((await s.page('GET', '/api/suites')).json.suites[0].needsReview, 0);
    s.close();
  });

  // ---- wizard-trial-fixes (S-1): users, reload, typed values, token honesty, writes ----
  const trialProject = (extra = {}) => project({
    'environments/qc.json': { portalUrl: 'https://app.example.test', users: { alice: { email: 'a@example.test' }, locked: { email: 'l@example.test', disabled: 'account locked after 5 failed sign-ins' }, bob: {} } },
    ...extra,
  });
  async function trialStudio(extra, selection = ['GET /pets/{petId}', 'GET /pets']) {
    const sv = await servers();
    const dir = trialProject(extra);
    const s = await studio(dir, { mode: 'wizard' });
    const r1 = await s.page('POST', '/api/wizard/spec', { source: sv.specUrl, suiteName: 'Pets', env: 'qc' });
    await s.page('POST', '/api/wizard/select', { selection });
    await s.agent('GET', '/api/agent/next?timeout=10'); // attach
    sv.close();
    return { s, dir, sv, r1 };
  }

  await test('AC1: /api/envs lists userInfo (reason or null) and keeps users as names', async () => {
    const s = await studio(trialProject(), { mode: 'wizard' });
    const qc = (await s.page('GET', '/api/envs')).json.environments.find(e => e.name === 'qc');
    assert.deepStrictEqual(qc.users, ['alice', 'locked', 'bob']);
    assert.deepStrictEqual(qc.userInfo, [{ name: 'alice', disabled: null }, { name: 'locked', disabled: 'account locked after 5 failed sign-ins' }, { name: 'bob', disabled: null }]);
  });

  await test('AC1: collect (and collect-again) with a disabled user is a 400 user-disabled naming the reason; no event, no run', async () => {
    const { s } = await trialStudio();
    for (const p of ['collect', 'collect-again']) {
      const r = await s.page('POST', `/api/wizard/${p}`, { user: 'locked', all: true });
      assert.strictEqual(r.status, 400, r.text);
      assert.deepStrictEqual([r.json.error, r.json.reason], ['user-disabled', 'account locked after 5 failed sign-ins']);
    }
    assert.strictEqual((await s.page('GET', '/api/wizard/state')).json.run, null);
    assert.strictEqual((await s.agent('GET', '/api/agent/next?timeout=10')).json.event, 'idle');
    assert.strictEqual((await s.page('POST', '/api/wizard/collect', { user: 'alice' })).json.ok, true);
  });

  await test('AC2: suggestedUser is the most frequent usable owner of the project values; a disabled or unknown owner is skipped; none -> null', async () => {
    const { s } = await trialStudio({}, ['GET /pets/{petId}', 'GET /pets', 'GET /store/inventory']);
    const st = async () => (await s.page('GET', '/api/wizard/state')).json.suggestedUser;
    assert.strictEqual(await st(), null);
    const c = await s.page('POST', '/api/wizard/collect', { user: 'alice' });
    const needs = (await s.page('GET', '/api/wizard/state')).json.needs.map(n => n.param);
    const post = (param, user, extra = {}) => s.agent('POST', '/api/agent/event', { event: 'value', payload: { runId: c.json.runId, param, value: param === 'petId' ? 3 : 'sold', source: 'project', user, ...extra } });
    assert.ok(needs.includes('petId') && needs.includes('status'), needs.join());
    assert.strictEqual((await post('petId', 'locked')).json.ok, true);
    assert.strictEqual(await st(), null, 'a disabled owner is never suggested');
    await post('status', 'ghost');
    assert.strictEqual(await st(), null, 'an owner who is not a user of the environment is skipped');
    await post('petId', 'bob');
    assert.strictEqual(await st(), 'bob');
    await post('status', 'alice');
    assert.strictEqual(await st(), 'alice', 'a tie goes to the first in the environment file order');
  });

  await test('AC4: step 1 reports an existing suite file; the same re-post keeps selection, values and token; a new spec or env resets and says so', async () => {
    const sv = await servers();
    const dir = trialProject({ 'integration/api_test_suites/pets/pets_suite.json': { name: 'pets-suite', cases: [] } });
    const s = await studio(dir, { mode: 'wizard' });
    const body = { source: sv.specUrl, suiteName: 'Pets', env: 'qc' };
    const r1 = await s.page('POST', '/api/wizard/spec', body);
    assert.strictEqual(r1.json.existsFile, 'integration/api_test_suites/pets/pets_suite.json');
    assert.strictEqual(r1.json.reset, false);
    await s.page('POST', '/api/wizard/select', { selection: ['GET /pets/{petId}'] });
    await s.page('POST', '/api/wizard/value', { param: 'petId', value: '7', source: 'manual' });
    await s.agent('POST', '/api/agent/token', { token: 'opaque-session-value-1', user: 'alice' });
    const again = await s.page('POST', '/api/wizard/spec', body);
    assert.strictEqual(again.json.kept, true);
    assert.deepStrictEqual(again.json.selection, ['GET /pets/{petId}']);
    const st = (await s.page('GET', '/api/wizard/state')).json;
    assert.deepStrictEqual([st.step, st.values.petId.value, st.token.present, st.source, st.suiteName], [3, 7, true, sv.specUrl, 'Pets']);
    const renamed = await s.page('POST', '/api/wizard/spec', { ...body, suiteName: 'Pets Two' });
    assert.deepStrictEqual([renamed.json.kept, renamed.json.slug, renamed.json.existsFile], [true, 'pets-two', null]);
    assert.strictEqual((await s.page('GET', '/api/wizard/state')).json.values.petId.value, 7);
    const other = await s.page('POST', '/api/wizard/spec', { ...body, env: 'uat' });
    sv.close();
    assert.strictEqual(other.json.reset, true);
    const after = (await s.page('GET', '/api/wizard/state')).json;
    assert.deepStrictEqual([after.step, after.values, after.token.present, after.selection], [2, {}, false, []]);
  });

  await test('AC5: a wrong-type value is refused with bad-type naming the type, from the page and from the agent; a right one is kept', async () => {
    const { s } = await trialStudio();
    const bad = await s.page('POST', '/api/wizard/value', { param: 'petId', value: 'abc', source: 'manual' });
    assert.deepStrictEqual([bad.status, bad.json.error, bad.json.expected], [400, 'bad-type', 'integer']);
    const c = await s.page('POST', '/api/wizard/collect', { user: 'alice' });
    const ev = (p) => s.agent('POST', '/api/agent/event', { event: 'value', payload: { runId: c.json.runId, ...p } });
    const viaAgent = await ev({ param: 'petId', value: 'abc', source: 'ui' });
    assert.deepStrictEqual([viaAgent.status, viaAgent.json.error, viaAgent.json.expected], [400, 'bad-type', 'integer']);
    assert.deepStrictEqual((await s.page('GET', '/api/wizard/state')).json.values, {});
    assert.strictEqual((await ev({ param: 'petId', value: '12', source: 'ui' })).json.ok, true);
  });

  await test('AC5: a UI or project value can be replaced by a typed one (manual)', async () => {
    const { s } = await trialStudio();
    const c = await s.page('POST', '/api/wizard/collect', { user: 'alice' });
    await s.agent('POST', '/api/agent/event', { event: 'value', payload: { runId: c.json.runId, param: 'petId', value: 3, source: 'ui' } });
    assert.strictEqual((await s.page('POST', '/api/wizard/value', { param: 'petId', value: '9', source: 'manual' })).json.ok, true);
    const v = (await s.page('GET', '/api/wizard/state')).json.values.petId;
    assert.deepStrictEqual([v.value, v.source], [9, 'manual']);
  });

  await test('AC5: "missing only" with nothing missing answers nothing-missing and starts no run; "all" still runs', async () => {
    const { s } = await trialStudio({}, ['GET /pets/{petId}']);
    await s.page('POST', '/api/wizard/value', { param: 'petId', value: '7', source: 'manual' });
    const c = await s.page('POST', '/api/wizard/collect', { user: 'alice' });
    const post = (event, payload) => s.agent('POST', '/api/agent/event', { event, payload: { runId: c.json.runId, ...payload } });
    await post('value', { param: 'petId', value: 3, source: 'ui' });
    await post('ended', { found: 1, total: 1 });
    const none = await s.page('POST', '/api/wizard/collect-again', { all: false, user: 'alice' });
    assert.deepStrictEqual([none.status, none.json.ok, none.json.error], [200, false, 'nothing-missing']);
    assert.strictEqual((await s.page('GET', '/api/wizard/state')).json.run.runId, c.json.runId, 'no new run');
    assert.strictEqual((await s.page('POST', '/api/wizard/collect-again', { all: true, user: 'alice' })).json.ok, true);
  });

  await test('B7/§1.1: a value stores its owner, environment and group; another environment is refused; phase "session" is accepted', async () => {
    const { s, dir } = await trialStudio();
    const c = await s.page('POST', '/api/wizard/collect', { user: 'alice' });
    const post = (event, payload) => s.agent('POST', '/api/agent/event', { event, payload: { runId: c.json.runId, ...payload } });
    assert.strictEqual((await post('phase', { name: 'session', text: 'renewing the saved session' })).json.ok, true);
    const other = await post('value', { param: 'petId', value: 3, source: 'project', user: 'bob', environment: 'uat', group: 'g1' });
    assert.deepStrictEqual([other.status, other.json.error], [400, 'other-environment']);
    assert.ok(!(await s.page('GET', '/api/wizard/state')).json.values.petId);
    assert.strictEqual((await post('value', { param: 'petId', value: 3, source: 'project', user: 'bob', environment: 'qc', group: 'executions/run-1/a.log#1' })).json.ok, true);
    const v = (await s.page('GET', '/api/wizard/state')).json.values.petId;
    assert.deepStrictEqual([v.user, v.environment, v.group], ['bob', 'qc', 'executions/run-1/a.log#1']);
    await s.page('POST', '/api/wizard/approve', {});
    const store = JSON.parse(fs.readFileSync(path.join(dir, '.agentex/cache/api-data/pets.json'), 'utf8'));
    const sv = store.values.find(x => x.param === 'petId');
    assert.deepStrictEqual([sv.user, sv.environment, sv.group], ['bob', 'qc', 'executions/run-1/a.log#1']);
  });

  await test('AC6: tokenBlocked counts the ready token cases when nothing supplies a token, and drops to 0 with a captured token; writes[] lists every write', async () => {
    const { s } = await trialStudio({}, ['GET /pets/{petId}', 'GET /pets']);
    await s.page('POST', '/api/wizard/value', { param: 'petId', value: '7', source: 'manual' });
    const p1 = (await s.page('GET', '/api/wizard/preview')).json;
    const authed = p1.summary.endpoints.filter(e => e.auth === 'token').flatMap(e => e.cases).filter(c => !c.skipped && !c.needsReview && c.kind !== 'no-token').length;
    assert.ok(authed >= 1, JSON.stringify(p1.summary.endpoints));
    assert.strictEqual(p1.summary.tokenBlocked, authed);
    assert.ok(p1.summary.tokenBlocked <= p1.summary.ready);
    assert.deepStrictEqual(p1.writes.map(w => w.kind), ['catalog', 'suite', 'data-store', 'env-line'], JSON.stringify(p1.writes));
    await s.agent('POST', '/api/agent/token', { token: 'opaque-session-value-1', user: 'alice' });
    const p2 = (await s.page('GET', '/api/wizard/preview')).json;
    assert.strictEqual(p2.summary.tokenBlocked, 0);
    assert.deepStrictEqual(p2.writes.map(w => w.kind), ['catalog', 'suite', 'data-store', 'token', 'env-line']);
    assert.ok(!JSON.stringify(p2).includes('opaque-session-value-1'));
  });

  await test('AC6: a tokenEnv value in .env, or an unexpired token store, also clears tokenBlocked; no data and a set base URL shorten writes[]', async () => {
    const { s } = await trialStudio({ '.env': 'PETS_TOKEN=abc\nPETS_BASE_URL=http://127.0.0.1:1\n' }, ['GET /pets/{petId}']);
    const p = (await s.page('GET', '/api/wizard/preview')).json;
    assert.strictEqual(p.summary.tokenBlocked, 0);
    assert.ok(p.writes.some(w => w.kind === 'data-store'), 'a needed value is still missing, so the store is written');
    assert.ok(!p.writes.some(w => w.kind === 'env-line'));
    const t2 = await trialStudio({ 'test/.auth/api-tokens/pets-qc.json': { token: 'x', expiresAt: new Date(Date.now() + 3600e3).toISOString() } }, ['GET /pets/{petId}']);
    assert.strictEqual((await t2.s.page('GET', '/api/wizard/preview')).json.summary.tokenBlocked, 0);
    const t3 = await trialStudio({ 'test/.auth/api-tokens/pets-qc.json': { token: 'x', expiresAt: new Date(Date.now() - 3600e3).toISOString() } }, ['GET /pets/{petId}']);
    assert.ok((await t3.s.page('GET', '/api/wizard/preview')).json.summary.tokenBlocked > 0);
  });

  await test('AC9 (step 3 side): the wizard state carries summary.mismatches from the generator, empty when there is none', async () => {
    const { s } = await trialStudio();
    assert.deepStrictEqual((await s.page('GET', '/api/wizard/state')).json.mismatches, []);
  });

  await test('F18: a second studio start answers already-running with the URL of the requested mode (+ ?spec=)', async () => {
    const dir = trialProject();
    const s = await studio(dir, { mode: 'wizard' });
    const out = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'server.js'), dir, '--mode', 'wizard', '--spec', 'specs/a b.json', '--no-open', '--port', '0'], { encoding: 'utf8', env: { ...process.env, TMPDIR: path.dirname(path.dirname(s.st.studio.sessionFile)) } });
    const j = JSON.parse(out.stdout.trim().split('\n').pop());
    assert.strictEqual(j.error, 'already-running', out.stdout + out.stderr);
    assert.strictEqual(j.url, `http://127.0.0.1:${s.st.port}/wizard?spec=${encodeURIComponent('specs/a b.json')}`);
    const ed = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'server.js'), dir, '--no-open', '--port', '0'], { encoding: 'utf8', env: { ...process.env, TMPDIR: path.dirname(path.dirname(s.st.studio.sessionFile)) } });
    assert.strictEqual(JSON.parse(ed.stdout.trim().split('\n').pop()).url, `http://127.0.0.1:${s.st.port}/editor`);
  });

  await test('page injection: the editor page carries the studio_view.js helpers and the user data', async () => {
    const s = await studio(trialProject(), { mode: 'wizard' });
    const html = (await req(s.st.port, 'GET', '/wizard')).text;
    assert.ok(!html.includes('__STUDIO_VIEW_HELPERS__'));
    assert.ok(html.includes('function userOptions('), 'helpers injected');
  });

  done();
})();
