'use strict';
// Unit tests for the Azure DevOps REST adapter. Run: node scripts/lib/tracker/adapters/ado.test.js
// Fully offline: fetch is INJECTED (never monkey-patched) — a scripted fake with
// call recording. No network, no ADO org, no az CLI anywhere.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdapter, normalizeOrg, TrackerError, PAT_ENV_NAMES } = require('./ado.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const SENTINEL_PAT = 'SENTINEL-PAT-a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SENTINEL_B64 = Buffer.from(':' + SENTINEL_PAT).toString('base64');

// The tests own the PAT and legacy config environment — the machine's real values must not leak in.
for (const n of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'AZURE_URL', 'AZURE_PROJECT', 'AGENTEX_CI']) delete process.env[n];

// Throwaway consumer project with an azure block + a sentinel PAT in .env.
function proj({ org = 'exampleorg', project = 'Sample Project', envLines, azureExtra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ado-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'),
    JSON.stringify({ azure: { org, project, ...azureExtra } }));
  fs.writeFileSync(path.join(dir, '.env'),
    envLines !== undefined ? envLines : `AZURE_PAT=${SENTINEL_PAT}\n`);
  return dir;
}

// Scripted fake fetch: matches [method + url substring] routes, records every call.
function fakeFetch(routes = []) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    for (const r of routes) {
      if ((r.method || 'GET') === (opts.method || 'GET') && String(url).includes(r.match)) {
        const status = r.status || 200;
        // json may be a function of the calls so far — for read-after-write routes.
        const json = typeof r.json === 'function' ? r.json(calls) : r.json;
        const text = r.text !== undefined ? r.text : JSON.stringify(json !== undefined ? json : {});
        return { ok: status >= 200 && status < 300, status, text: async () => text };
      }
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

const BASE = 'https://dev.azure.com/exampleorg';
const PROJ = 'Sample%20Project';

(async () => {
  // ── URL / route construction ────────────────────────────────────────────────
  await test('a bare org name is normalized to https://dev.azure.com/<org>', async () => {
    const f = fakeFetch([{ match: '/workitems/7', json: { id: 7, fields: {} } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await a.getWorkItem(7);
    assert.ok(f.calls[0].url.startsWith(`${BASE}/${PROJ}/_apis/wit/workitems/7?`), f.calls[0].url);
  });

  await test('an org URL is used as-is (trailing slash stripped), on-prem style included', async () => {
    const f = fakeFetch([]);
    const a = createAdapter({ cwd: proj({ org: 'https://tfs.example.com/Collection/' }), fetch: f });
    await a.getWorkItem(9);
    assert.ok(f.calls[0].url.startsWith('https://tfs.example.com/Collection/Sample%20Project/_apis/wit/workitems/9?'), f.calls[0].url);
  });

  await test('api-version from azure.apiVersion propagates to every route (default 7.1)', async () => {
    const f1 = fakeFetch([]);
    await createAdapter({ cwd: proj(), fetch: f1 }).getWorkItem(1);
    assert.match(f1.calls[0].url, /api-version=7\.1/);
    const f2 = fakeFetch([]);
    await createAdapter({ cwd: proj({ azureExtra: { apiVersion: '6.0' } }), fetch: f2 }).getWorkItem(1);
    assert.match(f2.calls[0].url, /api-version=6\.0/);
  });

  await test('getWorkItem with expand adds $expand=all', async () => {
    const f = fakeFetch([]);
    await createAdapter({ cwd: proj(), fetch: f }).getWorkItem(5, { expand: 'all' });
    assert.match(f.calls[0].url, /\$expand=all/);
  });

  await test('query() POSTs WIQL; findByTitle escapes quotes and returns ids', async () => {
    const f = fakeFetch([{ method: 'POST', match: '/_apis/wit/wiql', json: { workItems: [{ id: 11 }, { id: 12 }] } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const ids = await a.findByTitle('Bug', "O'Brien's bug");
    assert.deepStrictEqual(ids, [11, 12]);
    assert.strictEqual(f.calls[0].method, 'POST');
    const body = JSON.parse(f.calls[0].body);
    assert.match(body.query, /O''Brien''s bug/, 'single quotes doubled for WIQL');
    assert.match(body.query, /\[System\.TeamProject\]='Sample Project'/);
    assert.match(body.query, /\[System\.WorkItemType\]='Bug'/);
  });

  await test('listFields hits workitemtypes/<type>/fields with $expand=allowedValues', async () => {
    const f = fakeFetch([{ match: '/fields?', json: { value: [{ referenceName: 'X', allowedValues: ['a'] }] } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const fields = await a.listFields('Test Case');
    assert.deepStrictEqual(fields, [{ referenceName: 'X', allowedValues: ['a'] }]);
    assert.ok(f.calls[0].url.includes('/_apis/wit/workitemtypes/Test%20Case/fields?'), f.calls[0].url);
    assert.match(f.calls[0].url, /\$expand=allowedValues/);
  });

  await test('testplan reads: listSuites / listSuiteCases / getPoint / listRunResults routes', async () => {
    const f = fakeFetch([
      { match: '/testplan/Plans/3/suites', json: { value: [{ id: 4, name: 's' }] } },
      { match: '/testplan/Plans/3/Suites/4/TestCase', json: { value: [{ workItem: { id: 77 } }] } },
      { match: '/testplan/Plans/3/Suites/4/TestPoint?testCaseId=77', json: { value: [{ id: 900 }] } },
      { match: '/test/Runs/55/results', json: { value: [{ id: 100000 }] } },
    ]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    assert.deepStrictEqual(await a.listSuites(3), [{ id: 4, name: 's' }]);
    assert.deepStrictEqual(await a.listSuiteCases(3, 4), [{ workItem: { id: 77 } }]);
    assert.deepStrictEqual(await a.getPoint(3, 4, 77), { id: 900 });
    assert.deepStrictEqual(await a.listRunResults(55), [{ id: 100000 }]);
    assert.ok(f.calls.every((c) => c.url.startsWith(`${BASE}/${PROJ}/_apis/`)));
  });

  // ── auth: the PAT reaches the Authorization header ONLY ─────────────────────
  await test('auth header is Basic base64(":"+PAT) — and the PAT resolves from .env, not argv', async () => {
    const f = fakeFetch([]);
    await createAdapter({ cwd: proj(), fetch: f }).getWorkItem(1);
    assert.strictEqual(f.calls[0].headers.Authorization, `Basic ${SENTINEL_B64}`);
  });

  await test('PAT resolution order: AZURE_PAT first, then AZURE_DEVOPS_EXT_PAT, then AZURE_DEVOPS_PAT', async () => {
    const f1 = fakeFetch([]);
    await createAdapter({
      cwd: proj({ envLines: `AZURE_DEVOPS_PAT=third\nAZURE_DEVOPS_EXT_PAT=second\nAZURE_PAT=${SENTINEL_PAT}\n` }),
      fetch: f1,
    }).getWorkItem(1);
    assert.strictEqual(f1.calls[0].headers.Authorization, `Basic ${SENTINEL_B64}`);
    const f2 = fakeFetch([]);
    await createAdapter({ cwd: proj({ envLines: 'AZURE_DEVOPS_EXT_PAT=legacy-ext\n' }), fetch: f2 }).getWorkItem(1);
    assert.strictEqual(f2.calls[0].headers.Authorization, `Basic ${Buffer.from(':legacy-ext').toString('base64')}`);
  });

  await test('missing PAT: exit-2-shaped error naming all three env names and .env/the wizard', async () => {
    const a = createAdapter({ cwd: proj({ envLines: '' }), fetch: fakeFetch([]) });
    await assert.rejects(() => a.getWorkItem(1), (e) => {
      assert.strictEqual(e.exitCode, 2);
      for (const n of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT']) assert.ok(e.message.includes(n), n);
      assert.match(e.message, /\.env/);
      assert.match(e.message, /wizard|init-test/i);
      return true;
    });
  });

  // ── write dialect: json-patch conversion ────────────────────────────────────
  await test('createWorkItem converts neutral {fields, relations} to a json-patch op array', async () => {
    const f = fakeFetch([{ method: 'POST', match: '/workitems/$Bug', json: { id: 4711 } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const r = await a.createWorkItem('Bug', {
      fields: { 'System.Title': 'T', 'Microsoft.VSTS.Common.Priority': 2 },
      relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', targetId: 123, attributes: { comment: 'parent' } }],
    }, { execute: true });
    assert.strictEqual(r.id, 4711);
    assert.ok(r.url.includes('4711'));
    const call = f.calls[0];
    assert.ok(call.url.includes('/_apis/wit/workitems/$Bug?'), call.url);
    assert.strictEqual(call.headers['Content-Type'], 'application/json-patch+json');
    assert.deepStrictEqual(JSON.parse(call.body), [
      { op: 'add', path: '/fields/System.Title', value: 'T' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: 2 },
      { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${BASE}/_apis/wit/workItems/123`, attributes: { comment: 'parent' } } },
    ]);
  });

  await test('work-item type with a space is encoded in the create route ($Test%20Case)', async () => {
    const f = fakeFetch([{ method: 'POST', match: 'Test%20Case', json: { id: 1 } }]);
    await createAdapter({ cwd: proj(), fetch: f }).createWorkItem('Test Case', { fields: { 'System.Title': 't' } }, { execute: true });
    assert.ok(f.calls[0].url.includes('/_apis/wit/workitems/$Test%20Case?'), f.calls[0].url);
  });

  await test('validateOnly=true lands as a query param on the create route', async () => {
    const f = fakeFetch([{ method: 'POST', match: '/workitems/$Bug', json: { id: 0 } }]);
    await createAdapter({ cwd: proj(), fetch: f })
      .createWorkItem('Bug', { fields: { 'System.Title': 't' } }, { validateOnly: true, execute: true });
    assert.match(f.calls[0].url, /validateOnly=true/);
  });

  await test('updateWorkItem PATCHes json-patch with fields + addRelations', async () => {
    const f = fakeFetch([{ method: 'PATCH', match: '/workitems/42', json: { id: 42, rev: 3 } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const r = await a.updateWorkItem(42, {
      fields: { 'Microsoft.VSTS.TCM.ReproSteps': '<b>html</b>' },
      addRelations: [{ rel: 'AttachedFile', url: 'https://x/att/1', attributes: { comment: 'e.png' } }],
    }, { execute: true });
    assert.strictEqual(r.id, 42);
    const ops = JSON.parse(f.calls[0].body);
    assert.deepStrictEqual(ops[0], { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: '<b>html</b>' });
    assert.deepStrictEqual(ops[1].value.url, 'https://x/att/1');
  });

  await test('addRelation is sugar over updateWorkItem (one relation op)', async () => {
    const f = fakeFetch([{ method: 'PATCH', match: '/workitems/42', json: { id: 42 } }]);
    await createAdapter({ cwd: proj(), fetch: f }).addRelation(42, 'System.LinkTypes.Hierarchy-Reverse', 99, { execute: true });
    const ops = JSON.parse(f.calls[0].body);
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].value.rel, 'System.LinkTypes.Hierarchy-Reverse');
    assert.ok(ops[0].value.url.endsWith('/_apis/wit/workItems/99'));
  });

  await test('uploadAttachment POSTs raw bytes as octet-stream with fileName param', async () => {
    const dir = proj();
    const png = path.join(dir, 'shot.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const f = fakeFetch([{ method: 'POST', match: '/_apis/wit/attachments', json: { id: 'att-1', url: 'https://x/att-1' } }]);
    const r = await createAdapter({ cwd: dir, fetch: f }).uploadAttachment(png, { execute: true });
    assert.deepStrictEqual(r, { name: 'shot.png', id: 'att-1', url: 'https://x/att-1' });
    const call = f.calls[0];
    assert.match(call.url, /fileName=shot\.png/);
    assert.strictEqual(call.headers['Content-Type'], 'application/octet-stream');
    assert.strictEqual(Buffer.compare(call.body, fs.readFileSync(png)), 0, 'raw bytes travel as the body');
  });

  await test('uploadAttachment with opts.bytes sends that buffer verbatim — not a re-read of the file', async () => {
    const dir = proj();
    const png = path.join(dir, 'shot.png');
    fs.writeFileSync(png, Buffer.from('what is on disk now'));
    const checked = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
    const f = fakeFetch([{ method: 'POST', match: '/_apis/wit/attachments', json: { id: 'att-2', url: 'https://x/att-2' } }]);
    const a = createAdapter({ cwd: dir, fetch: f });
    const d = await a.uploadAttachment(png, { execute: false, bytes: checked });
    assert.match(d.body, /shot\.png, 8 bytes/, 'the dry-run size is the size that will be sent');
    await a.uploadAttachment(png, { execute: true, bytes: checked });
    assert.strictEqual(Buffer.compare(f.calls[0].body, checked), 0, 'the given bytes travel');
    await assert.rejects(() => a.uploadAttachment(png, { execute: true, bytes: 'not a buffer' }),
      (e) => e.exitCode === 2 && /opts\.bytes must be a Buffer/.test(e.message));
    assert.strictEqual(f.calls.length, 1, 'a bad bytes option sends nothing');
  });

  // Suite membership as the legacy GET returns it; flips once the add POST was sent.
  const suiteCases = (present, addedAfterPost = []) => (calls) => {
    const posted = calls.some((c) => c.method === 'POST' && c.url.includes('/testcases/'));
    return { value: [...present, ...(posted ? addedAfterPost : [])].map((id) => ({ testCase: { id: String(id) } })) };
  };

  await test('addCaseToSuite POSTs the legacy testcases route with the ids in the path', async () => {
    const f = fakeFetch([{ match: '/test/Plans/3/suites/4/testcases', json: suiteCases([], [505]) }]);
    const r = await createAdapter({ cwd: proj(), fetch: f }).addCaseToSuite(3, 4, 505, { execute: true });
    const post = f.calls.find((c) => c.method === 'POST');
    assert.ok(post.url.includes(`${BASE}/${PROJ}/_apis/test/Plans/3/suites/4/testcases/505?`), post.url);
    assert.match(post.url, /api-version=7\.1(&|$)/, 'GA api-version, no -preview suffix');
    assert.ok(!f.calls.some((c) => c.url.includes('suiteentry')), 'never the suite-entries (reorder) route');
    assert.deepStrictEqual(r, { ids: [505], added: [505], alreadyPresent: [], suiteId: 4, planId: 3 });
  });

  await test('addCaseToSuite is idempotent: ids already in the suite are skipped, none left = no POST', async () => {
    const f = fakeFetch([{ match: '/suites/4/testcases', json: suiteCases([505, 506], [507]) }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const r = await a.addCaseToSuite(3, 4, [505, 507], { execute: true });
    assert.ok(f.calls.find((c) => c.method === 'POST').url.includes('/testcases/507?'), 'only the missing id is posted');
    assert.deepStrictEqual(r.added, [507]);
    assert.deepStrictEqual(r.alreadyPresent, [505]);
    const f2 = fakeFetch([{ match: '/suites/4/testcases', json: suiteCases([505]) }]);
    const r2 = await createAdapter({ cwd: proj(), fetch: f2 }).addCaseToSuite(3, 4, 505, { execute: true });
    assert.strictEqual(f2.calls.filter((c) => c.method === 'POST').length, 0);
    assert.deepStrictEqual(r2.added, []);
  });

  await test('addCaseToSuite FAILS CLOSED when the re-read does not show the case (HTTP 200, nothing added)', async () => {
    const f = fakeFetch([{ match: '/suites/4/testcases', json: suiteCases([], []) }]);
    await assert.rejects(
      () => createAdapter({ cwd: proj(), fetch: f }).addCaseToSuite(3, 4, 505, { execute: true }),
      (e) => {
        assert.ok(e instanceof TrackerError);
        assert.strictEqual(e.op, 'addCaseToSuite');
        assert.match(e.message, /test case\(s\) 505 are not in suite 4 on re-read/);
        return true;
      });
  });

  await test('test-run writes: createRun / updateRunResults / updateRun routes + methods', async () => {
    const f = fakeFetch([
      { method: 'POST', match: '/test/runs?', json: { id: 88 } },
      { method: 'PATCH', match: '/test/Runs/88/results', json: { value: [] } },
      { method: 'PATCH', match: '/test/runs/88?', json: { id: 88, state: 'Completed' } },
    ]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const run = await a.createRun({ name: 'r', plan: { id: '3' }, pointIds: [900] }, { execute: true });
    assert.strictEqual(run.id, 88);
    await a.updateRunResults(88, [{ id: 100000, outcome: 'Failed' }], { execute: true });
    await a.updateRun(88, { state: 'Completed' }, { execute: true });
    assert.deepStrictEqual(f.calls.map((c) => c.method), ['POST', 'PATCH', 'PATCH']);
    assert.deepStrictEqual(JSON.parse(f.calls[1].body), [{ id: 100000, outcome: 'Failed' }]);
  });

  // ── deleteWorkItem: Recycle Bin only, destroy structurally impossible ──────
  await test('deleteWorkItem execute:false returns a DELETE descriptor (recycle-bin route), sends nothing', async () => {
    const f = fakeFetch([]);
    const a = createAdapter({ cwd: proj({ envLines: '' }), fetch: f }); // dry run needs no PAT
    const d = await a.deleteWorkItem(77, { execute: false });
    assert.strictEqual(f.calls.length, 0, 'zero requests sent');
    assert.strictEqual(d.method, 'DELETE');
    assert.ok(d.url.startsWith(`${BASE}/${PROJ}/_apis/wit/workitems/77?`), d.url);
    assert.strictEqual(d.headers.authorization, '<Basic ***, not printed>');
    assert.ok(!d.url.includes('destroy'), 'no destroy param, ever');
  });

  await test('deleteWorkItem execute:true DELETEs the work item (→ Recycle Bin) and returns the id', async () => {
    const f = fakeFetch([{ method: 'DELETE', match: '/workitems/77', json: { id: 77, deletedDate: '2026-08-27T00:00:00Z' } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const r = await a.deleteWorkItem(77, { execute: true });
    assert.strictEqual(r.id, 77);
    assert.strictEqual(f.calls[0].method, 'DELETE');
    assert.ok(f.calls[0].url.startsWith(`${BASE}/${PROJ}/_apis/wit/workitems/77?`), f.calls[0].url);
    assert.ok(!f.calls[0].url.includes('destroy'), 'no destroy param, ever');
  });

  await test('deleteWorkItem is structurally incapable of permanent destroy under any input', async () => {
    const f = fakeFetch([{ method: 'DELETE', match: '/workitems/', json: { id: 1 } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    // A destroy option is not part of the signature: passing one changes nothing.
    const d = await a.deleteWorkItem(41, { execute: false, destroy: true });
    assert.ok(!d.url.includes('destroy'), d.url);
    await a.deleteWorkItem('42', { execute: true, destroy: true }); // numeric string ok
    // Injection through the id itself is rejected before any URL is composed.
    for (const bad of ['77?destroy=true', '77&destroy=true', 'abc', '', null, undefined, 1.5, -3, 0]) {
      await assert.rejects(() => a.deleteWorkItem(bad, { execute: false }), /work-item id/i, String(bad));
    }
    for (const c of f.calls) assert.ok(!c.url.includes('destroy'), c.url);
  });

  // ── dry run: execute:false sends NOTHING and returns the descriptor ────────
  await test('every write with execute:false sends nothing and returns a redacted descriptor', async () => {
    const dir = proj({ envLines: '' }); // no PAT on purpose: a dry run must not even need one
    const png = path.join(dir, 'shot.png');
    fs.writeFileSync(png, Buffer.alloc(10));
    const f = fakeFetch([]);
    const a = createAdapter({ cwd: dir, fetch: f });
    const descriptors = [
      await a.createWorkItem('Bug', { fields: { 'System.Title': 't' } }, { execute: false }),
      await a.updateWorkItem(42, { fields: { x: 'y' } }, { execute: false }),
      await a.addRelation(42, 'r', 9, { execute: false }),
      await a.uploadAttachment(png, { execute: false }),
      await a.addCaseToSuite(3, 4, 5, { execute: false }),
      await a.createRun({ name: 'r' }, { execute: false }),
      await a.updateRunResults(88, [], { execute: false }),
      await a.updateRun(88, { state: 'Completed' }, { execute: false }),
      await a.deleteWorkItem(7, { execute: false }),
    ];
    assert.strictEqual(f.calls.length, 0, 'zero requests sent');
    for (const d of descriptors) {
      assert.ok(d.method && d.url, 'descriptor carries method + url');
      assert.strictEqual(d.headers.authorization, '<Basic ***, not printed>');
      assert.ok(!JSON.stringify(d).includes(SENTINEL_PAT));
    }
    assert.match(descriptors[0].url, /\$Bug/);
    assert.match(JSON.stringify(descriptors[3].body), /shot\.png/);
  });

  // ── IDs: canonical decimal on every request, unchecked on dry runs ────────
  // Malformed spellings a caller or an agent could hand over. None may reach the
  // wire — no leading zero, sign, whitespace, '#', exponent, non-ASCII digits,
  // unsafe magnitude, injected path/query, or a dry-run stand-in.
  const BAD_IDS = ['0123', ' 123', '123 ', '123\n', '#123', '+5', '-1', '0', '1.0', '1e2', '0x1f', '١٢٣',
    '9007199254740993', '77?destroy=true', '77/../78', '', 'NEW', '<bugId>', 'new-bug-id', '{new-bug-id}',
    0, -1, 1.5, NaN, Infinity, 2 ** 53, null, undefined, true, {}];
  const EXEC = { execute: true };

  await test('every read and execute path refuses a malformed id (exit 2) and sends ZERO requests', async () => {
    const f = fakeFetch([]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const routes = (id) => [
      ['getWorkItem', () => a.getWorkItem(id)],
      ['getStory', () => a.getStory(id)],
      ['listSuites', () => a.listSuites(id)],
      ['listSuiteCases plan', () => a.listSuiteCases(id, 4)],
      ['listSuiteCases suite', () => a.listSuiteCases(3, id)],
      ['getPoint plan', () => a.getPoint(id, 4, 77)],
      ['getPoint suite', () => a.getPoint(3, id, 77)],
      ['getPoint case', () => a.getPoint(3, 4, id)],
      ['listRunResults', () => a.listRunResults(id)],
      ['updateWorkItem', () => a.updateWorkItem(id, { fields: { x: 'y' } }, EXEC)],
      ['updateWorkItem relation', () => a.updateWorkItem(42, { addRelations: [{ rel: 'r', targetId: id }] }, EXEC)],
      ['addRelation source', () => a.addRelation(id, 'r', 9, EXEC)],
      ['addRelation target', () => a.addRelation(42, 'r', id, EXEC)],
      ['createWorkItem relation', () => a.createWorkItem('Bug', { relations: [{ rel: 'r', targetId: id }] }, EXEC)],
      ['createWorkItem validateOnly relation', () => a.createWorkItem('Bug', { relations: [{ rel: 'r', targetId: id }] }, { validateOnly: true, execute: true })],
      ['addCaseToSuite plan', () => a.addCaseToSuite(id, 4, 5, EXEC)],
      ['addCaseToSuite suite', () => a.addCaseToSuite(3, id, 5, EXEC)],
      ['addCaseToSuite case', () => a.addCaseToSuite(3, 4, [505, id], EXEC)],
      ['updateRunResults', () => a.updateRunResults(id, [], EXEC)],
      ['updateRun', () => a.updateRun(id, { state: 'Completed' }, EXEC)],
      ['deleteWorkItem', () => a.deleteWorkItem(id, EXEC)],
    ];
    for (const id of BAD_IDS) {
      for (const [name, call] of routes(id)) {
        await assert.rejects(call, (e) => {
          assert.strictEqual(e.exitCode, 2, `${name}(${String(id)}): ${e.message}`);
          // deleteWorkItem's own positive-integer check (unchanged) may fire first.
          assert.match(e.message, name === 'deleteWorkItem' ? /work-item id/ : /positive canonical decimal/, `${name}(${String(id)})`);
          return true;
        }, `${name}(${String(id)}) must be refused`);
      }
    }
    assert.strictEqual(f.calls.length, 0, 'every refusal happened before a request left the machine');
  });

  await test('canonical IDs reach the wire unchanged — numbers and plain decimal strings alike', async () => {
    const f = fakeFetch([{ match: '/suites/4/testcases', json: { value: [{ testCase: { id: '505' } }] } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await a.getWorkItem('123');
    await a.getWorkItem(9007199254740991); // Number.MAX_SAFE_INTEGER is still an id
    await a.getPoint('3', '4', '77');
    await a.addCaseToSuite('3', '4', '505', EXEC);
    await a.updateRun('88', { state: 'Completed' }, EXEC);
    await a.deleteWorkItem('77', EXEC);
    const paths = f.calls.map((c) => c.url.replace(/^.*\/_apis\//, '').replace(/\?.*$/, ''));
    assert.deepStrictEqual(paths, ['wit/workitems/123', 'wit/workitems/9007199254740991',
      'testplan/Plans/3/Suites/4/TestPoint', 'test/Plans/3/suites/4/testcases', 'test/runs/88', 'wit/workitems/77']);
  });

  await test('dry runs check NO id: the bug flow\'s stand-ins plan exactly as before, with no PAT and zero requests', async () => {
    const f = fakeFetch([]);
    const a = createAdapter({ cwd: proj({ envLines: '' }), fetch: f });
    const DRY = { execute: false };
    for (const id of ['NEW', '<bugId>', 'new-bug-id', '{new-bug-id}', '{run-id}', '{new-tc-id}', ' 77', '0123', '#5']) {
      const link = await a.addRelation(77, 'Microsoft.VSTS.Common.TestedBy-Reverse', id, DRY); // testplan.js fail --bug <id>
      assert.ok(link.url.includes('/wit/workitems/77?'), link.url);
      assert.strictEqual(link.body[0].value.url, `${BASE}/_apis/wit/workItems/${id}`);
      assert.ok((await a.addRelation(id, 'r', 321, DRY)).url.includes(`/wit/workitems/${id}?`));
      assert.ok((await a.updateWorkItem(id, { fields: { x: 'y' } }, DRY)).url.includes(`/wit/workitems/${id}?`));
      const create = await a.createWorkItem('Task', { relations: [{ rel: 'r', targetId: id }] }, DRY);
      assert.strictEqual(create.body[0].value.url, `${BASE}/_apis/wit/workItems/${id}`);
      assert.ok((await a.addCaseToSuite(id, id, id, DRY)).url.includes(`/test/Plans/${id}/suites/${id}/testcases/${id}?`));
      assert.ok((await a.updateRunResults(id, [], DRY)).url.includes(`/test/Runs/${id}/results?`));
      assert.ok((await a.updateRun(id, {}, DRY)).url.includes(`/test/runs/${id}?`));
    }
    // deleteWorkItem's dry run keeps its own long-standing positive-integer check;
    // only the execute path is stricter.
    assert.ok((await a.deleteWorkItem(' 77', DRY)).url.includes('/wit/workitems/77?'));
    await assert.rejects(() => a.deleteWorkItem(' 77', EXEC), /positive canonical decimal work-item id/);
    assert.strictEqual(f.calls.length, 0);
  });

  // ── azure.org must be a plain base URL ─────────────────────────────────────
  await test('azure.org carrying credentials, a query string or a fragment is refused at config time — value never echoed', async () => {
    const refused = [
      ['https://qa.user:TOPSECRET@dev.azure.com/exampleorg', /credentials/],
      ['https://TOPSECRET@dev.azure.com/exampleorg', /credentials/],
      ['https://dev.azure.com/exampleorg?TOPSECRET=1', /query string/],
      ['https://dev.azure.com/exampleorg?', /query string/],
      ['https://dev.azure.com/exampleorg#TOPSECRET', /fragment/],
      ['exampleorg?TOPSECRET', /query string/],
      ['https://bad host/exampleorg', /not a valid/],
    ];
    for (const [org, why] of refused) {
      assert.throws(() => createAdapter({ cwd: proj({ org }), fetch: fakeFetch([]) }), (e) => {
        assert.strictEqual(e.exitCode, 2, org);
        assert.match(e.message, why, org);
        assert.ok(!e.message.includes('TOPSECRET'), `the org value is never echoed: ${e.message}`);
        return true;
      });
    }
    // The legacy AZURE_URL fallback goes through the same gate.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ado-'));
    fs.writeFileSync(path.join(dir, '.env'), `AZURE_URL=https://u:TOPSECRET@dev.azure.com/legacyorg\nAZURE_PROJECT=P\nAZURE_PAT=${SENTINEL_PAT}\n`);
    assert.throws(() => createAdapter({ cwd: dir, fetch: fakeFetch([]) }), /credentials/);
    // Plain spellings are unchanged.
    assert.strictEqual(normalizeOrg('exampleorg'), 'https://dev.azure.com/exampleorg');
    assert.strictEqual(normalizeOrg(' https://tfs.example.com/Collection/ '), 'https://tfs.example.com/Collection');
  });

  // ── error contract ──────────────────────────────────────────────────────────
  await test('non-2xx: TrackerError with op, status, url and a <=500-char body slice', async () => {
    const long = 'x'.repeat(2000);
    const f = fakeFetch([{ method: 'POST', match: '/workitems/$Bug', status: 400, text: JSON.stringify({ message: 'The field Severity has an invalid value.', detail: long }) }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await assert.rejects(() => a.createWorkItem('Bug', { fields: { 'System.Title': 't' } }, { execute: true }), (e) => {
      assert.ok(e instanceof TrackerError);
      assert.strictEqual(e.op, 'createWorkItem');
      assert.strictEqual(e.status, 400);
      assert.ok(e.url.includes('/_apis/wit/workitems/$Bug'));
      assert.strictEqual(e.serverMessage, 'The field Severity has an invalid value.');
      assert.ok(e.body.length <= 500, `body slice is ${e.body.length} chars`);
      assert.ok(!e.message.includes(SENTINEL_PAT) && !JSON.stringify({ ...e }).includes(SENTINEL_PAT));
      return true;
    });
  });

  await test('401 carries credentialHint with env-var NAMES only — never the value', async () => {
    const f = fakeFetch([{ match: '/workitems/1', status: 401, text: '' }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await assert.rejects(() => a.getWorkItem(1), (e) => {
      assert.ok(e instanceof TrackerError);
      assert.deepStrictEqual(e.credentialHint.tried, ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT']);
      assert.strictEqual(e.credentialHint.resolved, 'AZURE_PAT');
      assert.ok(!JSON.stringify(e.credentialHint).includes(SENTINEL_PAT));
      return true;
    });
  });

  await test('a timeout aborts cleanly into a TrackerError (never a raw fetch error)', async () => {
    // AbortSignal.timeout timers are unref'd — a real socket would keep the loop
    // alive, so the fake needs its own ref'd timer to model the hung connection.
    const keepAlive = setTimeout(() => {}, 5000);
    const hanging = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    });
    const a = createAdapter({ cwd: proj(), fetch: hanging, timeoutMs: 25 });
    try {
      await assert.rejects(() => a.getWorkItem(1), (e) => {
        assert.ok(e instanceof TrackerError);
        assert.match(e.serverMessage, /timed out after 25ms/);
        return true;
      });
    } finally { clearTimeout(keepAlive); }
  });

  await test('a network-level failure is wrapped, not rethrown raw', async () => {
    const dead = async () => { throw new Error('getaddrinfo ENOTFOUND dev.azure.com'); };
    const a = createAdapter({ cwd: proj(), fetch: dead });
    await assert.rejects(() => a.getWorkItem(1), (e) => e instanceof TrackerError && /ENOTFOUND/.test(e.serverMessage));
  });

  // ── error-path scrub: an echoed PAT never survives into a TrackerError ─────
  // A PAT with characters that encode differently, so the URL-encoded and
  // JSON-escaped spellings are distinct strings the scrub has to catch.
  const ODD_PAT = 'odd+pat/with"quote\\slash';
  const ODD_B64 = Buffer.from(':' + ODD_PAT).toString('base64');
  const ODD_FORMS = {
    raw: ODD_PAT,
    header: `Basic ${ODD_B64}`,
    base64: ODD_B64,
    urlEncoded: encodeURIComponent(ODD_PAT),
    jsonEscaped: JSON.stringify(ODD_PAT).slice(1, -1),
  };
  const oddProj = () => proj({ envLines: `AZURE_PAT=${ODD_PAT}\n` });
  // Every surface a caller can print: message, own props, body, serverMessage.
  const assertNoPatForm = (e) => {
    const surfaces = [e.message, e.url, e.body, String(e.serverMessage), JSON.stringify({ ...e })].join('\n');
    for (const [name, form] of Object.entries(ODD_FORMS)) assert.ok(!surfaces.includes(form), `${name} form leaked: ${surfaces}`);
  };

  await test('error path: a non-OK text body echoing the PAT in any form is scrubbed (raw, header, base64, URL-encoded, JSON-escaped)', async () => {
    for (const [name, form] of Object.entries(ODD_FORMS)) {
      const f = fakeFetch([{ match: '/workitems/1', status: 401, text: `proxy echo: ${form} <end>` }]);
      await assert.rejects(() => createAdapter({ cwd: oddProj(), fetch: f }).getWorkItem(1), (e) => {
        assert.ok(e instanceof TrackerError, name);
        assertNoPatForm(e);
        assert.strictEqual(e.body, 'proxy echo: <redacted> <end>', name);
        return true;
      });
    }
  });

  await test('error path: a JSON error body is scrubbed value by value — nested, as a key, and behind \\u escapes', async () => {
    const unicodeEscaped = [...ODD_PAT].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const text = `{"message":"rejected ${ODD_FORMS.jsonEscaped}","detail":{"tokens":["${ODD_B64}","Basic ${ODD_B64}"],` +
      `"${ODD_FORMS.urlEncoded}":"as a key","hidden":"${unicodeEscaped}"}}`;
    assert.ok(!text.includes(ODD_PAT), 'precondition: the raw text never spells the PAT plainly');
    const f = fakeFetch([{ method: 'POST', match: '/wiql', status: 400, text }]);
    await assert.rejects(() => createAdapter({ cwd: oddProj(), fetch: f }).query('SELECT 1'), (e) => {
      assertNoPatForm(e);
      assert.strictEqual(e.serverMessage, 'rejected <redacted>');
      assert.deepStrictEqual(JSON.parse(e.body), {
        message: 'rejected <redacted>',
        detail: { tokens: ['<redacted>', '<redacted>'], '<redacted>': 'as a key', hidden: '<redacted>' },
      });
      return true;
    });
  });

  await test('error path: a fetch that throws while quoting the Authorization header is scrubbed', async () => {
    const leaky = async () => { throw new Error(`proxy refused Authorization: Basic ${ODD_B64} (token ${ODD_PAT})`); };
    await assert.rejects(() => createAdapter({ cwd: oddProj(), fetch: leaky }).getWorkItem(1), (e) => {
      assert.ok(e instanceof TrackerError);
      assertNoPatForm(e);
      assert.strictEqual(e.serverMessage, 'proxy refused Authorization: <redacted> (token <redacted>)');
      return true;
    });
  });

  await test('error path: a request URL carrying a PAT form is scrubbed in the error (url and message)', async () => {
    // listFields URL-encodes its type into the route — the one caller-shaped path segment.
    const f = fakeFetch([{ match: '/workitemtypes/', status: 404, text: '' }]);
    await assert.rejects(() => createAdapter({ cwd: oddProj(), fetch: f }).listFields(ODD_PAT), (e) => {
      assertNoPatForm(e);
      assert.ok(e.url.includes('/workitemtypes/<redacted>/fields'), e.url);
      return true;
    });
  });

  await test('error path: an unreadable response body becomes a scrubbed TrackerError, never a raw stream error', async () => {
    const broken = (status) => async () => ({ ok: status < 300, status, text: async () => { throw new Error(`stream reset (token ${ODD_PAT})`); } });
    await assert.rejects(() => createAdapter({ cwd: oddProj(), fetch: broken(502) }).getWorkItem(1), (e) => {
      assert.ok(e instanceof TrackerError);
      assert.strictEqual(e.status, 502);
      assert.match(e.serverMessage, /response body could not be read: stream reset \(token <redacted>\)/);
      assertNoPatForm(e);
      return true;
    });
    await assert.rejects(() => createAdapter({ cwd: oddProj(), fetch: broken(200) }).getWorkItem(1), (e) => {
      assert.ok(e instanceof TrackerError, 'a 2xx whose body cannot be read is still a failure');
      assert.strictEqual(e.status, null);
      assertNoPatForm(e);
      return true;
    });
  });

  await test('success path is untouched: a 2xx body is returned verbatim even when it contains the PAT', async () => {
    // The scrub is error-path only — a work item that happens to quote the
    // token is the user's data and comes back byte for byte.
    const wi = { id: 1, fields: { 'System.Description': `pasted ${SENTINEL_PAT} / Basic ${SENTINEL_B64}` } };
    const r = await createAdapter({ cwd: proj(), fetch: fakeFetch([{ match: '/workitems/1', json: wi }]) }).getWorkItem(1);
    assert.deepStrictEqual(r, wi);
    const plain = `plain ${SENTINEL_PAT}`;
    const r2 = await createAdapter({ cwd: proj(), fetch: fakeFetch([{ match: '/workitems/1', text: plain }]) }).getWorkItem(1);
    assert.strictEqual(r2, plain, 'a non-JSON 2xx body is returned as-is too');
  });

  // ── config resolution (invariant 10) ────────────────────────────────────────
  await test('missing azure.org / azure.project: exit-2 error naming the keys looked for', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ado-'));
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({ azure: { org: 'o' } }));
    assert.throws(() => createAdapter({ cwd: dir, fetch: fakeFetch([]) }), (e) => {
      assert.strictEqual(e.exitCode, 2);
      assert.match(e.message, /azure\.project/);
      assert.match(e.message, /AZURE_PROJECT/);
      return true;
    });
  });

  await test('legacy AZURE_* env keys back the azure block (pick pattern)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ado-'));
    fs.writeFileSync(path.join(dir, '.env'),
      `AZURE_URL=https://dev.azure.com/legacyorg\nAZURE_PROJECT=Legacy Proj\nAZURE_PAT=${SENTINEL_PAT}\n`);
    const f = fakeFetch([]);
    await createAdapter({ cwd: dir, fetch: f }).getWorkItem(1);
    assert.ok(f.calls[0].url.startsWith('https://dev.azure.com/legacyorg/Legacy%20Proj/_apis/'), f.calls[0].url);
  });

  // ── capability flags ────────────────────────────────────────────────────────
  await test('webUrl is exposed on the adapter (consumers drop their ADO-shaped local helpers)', async () => {
    const a = createAdapter({ cwd: proj(), fetch: fakeFetch([]) });
    assert.strictEqual(a.webUrl(4711), `${BASE}/${PROJ}/_workitems/edit/4711`);
  });

  await test('capability flags describe ADO honestly (Phase-3 seam)', async () => {
    const a = createAdapter({ cwd: proj(), fetch: fakeFetch([]) });
    assert.strictEqual(a.name, 'ado');
    assert.strictEqual(a.capabilities.validateOnly, true);
    assert.strictEqual(a.capabilities.attachments, true);
    assert.strictEqual(a.capabilities.testPlans, true);
    assert.strictEqual(a.capabilities.testRuns, true);
    assert.strictEqual(a.capabilities.dialect, 'json-patch');
    assert.strictEqual(a.capabilities.query, 'wiql');
    assert.deepStrictEqual(a.capabilities.relations, { parent: true, child: true, related: true, testedBy: true, attachedFile: true });
    assert.strictEqual(a.capabilities.deleteWorkItem, 'partial');
    assert.deepStrictEqual(PAT_ENV_NAMES, ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT']);
  });

  // ── the no-az AC as a test: nothing in the lib can spawn a process ─────────
  await test('no child_process anywhere in scripts/lib/tracker/ (structural source read)', async () => {
    const root = path.join(__dirname, '..');
    const offenders = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
          const src = fs.readFileSync(full, 'utf8');
          if (/child_process|spawnSync|execSync/.test(src)) offenders.push(entry.name);
        }
      }
    })(root);
    assert.deepStrictEqual(offenders, [], 'the tracker lib must never compose a command line');
  });

  // ── sentinel sweep: the PAT appears in zero bytes of anything returned ─────
  await test('sentinel PAT absent from every return value and every error of a full op sweep', async () => {
    const f = fakeFetch([
      { match: '/workitems/1', json: { id: 1, fields: {} } },
      { method: 'POST', match: '/wiql', json: { workItems: [] } },
      { method: 'POST', match: '/workitems/$Bug', json: { id: 2 } },
    ]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const outputs = [];
    outputs.push(await a.getWorkItem(1));
    outputs.push(await a.findByTitle('Bug', 't'));
    outputs.push(await a.createWorkItem('Bug', { fields: { 'System.Title': 't' } }, { execute: true }));
    try { await createAdapter({ cwd: proj(), fetch: fakeFetch([{ match: '/workitems/1', status: 500, text: 'boom' }]) }).getWorkItem(1); }
    catch (e) { outputs.push({ msg: e.message, own: { ...e } }); }
    const all = JSON.stringify(outputs);
    assert.ok(!all.includes(SENTINEL_PAT), 'raw PAT leaked');
    assert.ok(!all.includes(SENTINEL_B64), 'base64 PAT leaked');
  });

  // ── CI guard (invariant 4 / ci-quality-gate): no tracker writes in CI mode ──
  await test('under AGENTEX_CI=1 every write with execute:true is refused (exit-2 error, ci-mode, ZERO requests)', async () => {
    process.env.AGENTEX_CI = '1';
    try {
      const png = path.join(proj(), 'shot.png');
      fs.writeFileSync(png, Buffer.alloc(4096));
      const f = fakeFetch([]);
      const a = createAdapter({ cwd: proj(), fetch: f });
      const writes = [
        () => a.createWorkItem('Bug', { fields: { 'System.Title': 't' } }, { execute: true }),
        () => a.updateWorkItem(42, { fields: { x: 'y' } }, { execute: true }),
        () => a.addRelation(42, 'r', 9, { execute: true }),
        () => a.uploadAttachment(png, { execute: true }),
        () => a.addCaseToSuite(3, 4, 5, { execute: true }),
        () => a.createRun({ name: 'r' }, { execute: true }),
        () => a.updateRunResults(88, [], { execute: true }),
        () => a.updateRun(88, { state: 'Completed' }, { execute: true }),
        () => a.deleteWorkItem(7, { execute: true }),
      ];
      for (const w of writes) {
        await assert.rejects(w, (e) => {
          assert.match(e.message, /ci-mode: tracker writes are disabled in CI/);
          assert.strictEqual(e.exitCode, 2, 'the refusal is environment-class (2), never a product failure (1)');
          return true;
        });
      }
      assert.strictEqual(f.calls.length, 0, 'the guard refuses BEFORE any request leaves the machine');
    } finally { delete process.env.AGENTEX_CI; }
  });

  await test('under AGENTEX_CI=1 execute:false descriptors and reads are UNAFFECTED', async () => {
    process.env.AGENTEX_CI = '1';
    try {
      const f = fakeFetch([
        { match: '/workitems/1', json: { id: 1, fields: {} } },
        { method: 'POST', match: '/wiql', json: { workItems: [] } },
      ]);
      const a = createAdapter({ cwd: proj(), fetch: f });
      assert.strictEqual((await a.getWorkItem(1)).id, 1, 'reads still work');
      assert.deepStrictEqual(await a.findByTitle('Bug', 't'), [], 'query reads still work');
      const d = await a.createWorkItem('Bug', { fields: { 'System.Title': 't' } }, { execute: false });
      assert.strictEqual(d.method, 'POST', 'the dry-run descriptor path is untouched');
      assert.strictEqual(f.calls.filter((c) => c.method !== 'GET' && !c.url.includes('/wiql')).length, 0, 'still zero writes');
    } finally { delete process.env.AGENTEX_CI; }
  });

  await test('without AGENTEX_CI the same writes go through (the guard keys on the env var alone)', async () => {
    const f = fakeFetch([{ method: 'POST', match: '/workitems/$Bug', json: { id: 4711 } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const r = await a.createWorkItem('Bug', { fields: { 'System.Title': 't' } }, { execute: true });
    assert.strictEqual(r.id, 4711);
  });

  // ── neutral reads (additive): getStory / listChildren / listSprintStories ──
  // Flow-free by contract: no CLI text, no estimation wording, no story-type rule.
  const { iterationWiql } = require('./ado.js');
  const FLOW_WORDS = ['--', 're-run', 'bundled', 'config/project.json'];
  const assertFlowFree = (r) => {
    const s = JSON.stringify(r);
    for (const w of FLOW_WORDS) assert.ok(!s.includes(w), `result carries flow text "${w}": ${s}`);
  };
  const WI_7 = { id: 7, fields: { 'System.WorkItemType': 'User Story', 'System.Title': 'Seven', 'System.State': 'Active' },
    relations: [
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: `${BASE}/_apis/wit/workItems/71` },
      { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${BASE}/_apis/wit/workItems/1` },
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: `${BASE}/_apis/wit/workItems/not-numeric` },
      { rel: 'System.LinkTypes.Hierarchy-Forward', url: `${BASE}/_apis/wit/workItems/72` },
    ] };

  await test('PINNED: iterationWiql(p, t, "User Story") is byte-identical to the 319619c current-sprint WIQL', async () => {
    assert.strictEqual(iterationWiql("O'Neil Project", "QA 'A' Team", 'User Story'),
      "SELECT [System.Id] FROM workitems WHERE [System.WorkItemType]='User Story' AND [System.TeamProject]='O''Neil Project'" +
      " AND [System.IterationPath] = @CurrentIteration('[O''Neil Project]\\QA ''A'' Team') ORDER BY [System.Id]");
    assert.ok(iterationWiql('P', 'T', "It's").includes("[System.WorkItemType]='It''s'"), 'the work item type is a quoted parameter');
  });

  await test('getStory: exactly ONE request, identical to getWorkItem(ref, {expand:"all"}); neutral shape + raw', async () => {
    const f1 = fakeFetch([{ match: '/workitems/7?', json: WI_7 }]);
    await createAdapter({ cwd: proj(), fetch: f1 }).getWorkItem(7, { expand: 'all' });
    const f2 = fakeFetch([{ match: '/workitems/7?', json: WI_7 }]);
    const s = await createAdapter({ cwd: proj(), fetch: f2 }).getStory(7);
    assert.deepStrictEqual(f2.calls.map((c) => [c.method, c.url, c.body]), f1.calls.map((c) => [c.method, c.url, c.body]));
    assert.deepStrictEqual(Object.keys(s), ['id', 'type', 'title', 'state', 'url', 'raw']);
    assert.strictEqual(s.id, 7);
    assert.strictEqual(s.type, 'User Story');
    assert.strictEqual(s.title, 'Seven');
    assert.strictEqual(s.state, 'Active');
    assert.strictEqual(s.url, `${BASE}/${PROJ}/_workitems/edit/7`);
    assert.deepStrictEqual(s.raw, WI_7);
  });

  await test('getStory is TOTAL on an empty body (raw null, nulls, never a shape throw); transport errors propagate UNWRAPPED', async () => {
    const s = await createAdapter({ cwd: proj(), fetch: fakeFetch([{ match: '/workitems/7?', text: '' }]) }).getStory(7);
    assert.strictEqual(s.raw, null);
    assert.strictEqual(s.type, null); assert.strictEqual(s.title, null); assert.strictEqual(s.state, null);
    assert.strictEqual(s.id, 7, 'an empty body falls back to the ref');
    const noId = await createAdapter({ cwd: proj(), fetch: fakeFetch([{ match: '/workitems/7?', json: { fields: {} } }]) }).getStory(7);
    assert.strictEqual(noId.id, undefined, 'a body is taken verbatim: id is wi.id, never substituted');
    assert.strictEqual(noId.url, `${BASE}/${PROJ}/_workitems/edit/undefined`);
    const a = createAdapter({ cwd: proj(), fetch: fakeFetch([{ match: '/workitems/7?', status: 404, text: JSON.stringify({ message: 'gone' }) }]) });
    let direct; try { await a.getWorkItem(7, { expand: 'all' }); } catch (e) { direct = e; }
    let viaStory; try { await a.getStory(7); } catch (e) { viaStory = e; }
    assert.ok(viaStory instanceof TrackerError, 'the TrackerError itself, not a wrapper');
    assert.strictEqual(viaStory.message, direct.message);
  });

  await test('listChildren: one GET per Hierarchy-Forward relation, in relation order, non-numeric URLs skipped, no expand, unfiltered', async () => {
    const f = fakeFetch([
      { match: '/workitems/7?', json: WI_7 },
      { match: '/workitems/71?', json: { id: 71, fields: { 'System.Title': '[Testing] A', 'System.State': 'New' } } },
      { match: '/workitems/72?', json: { id: 72, fields: {} } },
    ]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const s = await a.getStory(7);
    const before = f.calls.length;
    const kids = await a.listChildren(s);
    const reads = f.calls.slice(before);
    assert.deepStrictEqual(reads.map((c) => c.url.replace(/\?.*/, '')), [`${BASE}/${PROJ}/_apis/wit/workitems/71`, `${BASE}/${PROJ}/_apis/wit/workitems/72`]);
    assert.ok(reads.every((c) => c.method === 'GET' && !c.url.includes('$expand')), 'child reads carry no expand');
    assert.deepStrictEqual(kids, [{ id: 71, title: '[Testing] A', state: 'New' }, { id: 72, title: '', state: null }]);
  });

  await test('listChildren: a failed child read REJECTS with the unwrapped error; a null raw throws the 319619c TypeError', async () => {
    const a = createAdapter({ cwd: proj(), fetch: fakeFetch([{ match: '/workitems/71?', status: 500, text: 'boom' }]) });
    await assert.rejects(a.listChildren({ id: 7, raw: WI_7 }), (e) => e instanceof TrackerError && /HTTP 500/.test(e.message));
    await assert.rejects(a.listChildren({ id: 7, raw: null }), (e) => e instanceof TypeError && e.message === "Cannot read properties of null (reading 'relations')");
  });

  await test('listSprintStories: no team -> team-required with ZERO requests', async () => {
    const f = fakeFetch([]);
    const r = await createAdapter({ cwd: proj(), fetch: f }).listSprintStories({ storyType: 'User Story', team: null });
    assert.deepStrictEqual(r, { ok: false, condition: 'team-required', data: {} });
    assert.strictEqual(f.calls.length, 0);
    assertFlowFree(r);
  });

  await test('listSprintStories: exactly ONE POST wit/wiql whose body is {query: iterationWiql(...)}; refs in order, null ids dropped; sprint null', async () => {
    const f = fakeFetch([{ method: 'POST', match: '/wiql', json: { workItems: [{ id: 3 }, { id: null }, {}, { id: 1 }] } }]);
    const r = await createAdapter({ cwd: proj(), fetch: f }).listSprintStories({ storyType: 'User Story', team: "QA 'A' Team" });
    assert.strictEqual(f.calls.length, 1, 'no team-iteration GET — the macro resolves server-side');
    assert.strictEqual(f.calls[0].method, 'POST');
    assert.ok(f.calls[0].url.startsWith(`${BASE}/${PROJ}/_apis/wit/wiql?`), f.calls[0].url);
    assert.strictEqual(f.calls[0].body, JSON.stringify({ query: iterationWiql('Sample Project', "QA 'A' Team", 'User Story') }));
    assert.deepStrictEqual(r, { ok: true, sprint: null, refs: [3, 1] });
    assertFlowFree(r);
  });

  await test('listSprintStories: an array response works; an empty result is {ok:true, refs:[]}; a 401 propagates unwrapped', async () => {
    const r1 = await createAdapter({ cwd: proj(), fetch: fakeFetch([{ method: 'POST', match: '/wiql', json: [{ id: 5 }] }]) })
      .listSprintStories({ storyType: 'User Story', team: 'T' });
    assert.deepStrictEqual(r1.refs, [5]);
    const r2 = await createAdapter({ cwd: proj(), fetch: fakeFetch([{ method: 'POST', match: '/wiql', json: { workItems: [] } }]) })
      .listSprintStories({ storyType: 'User Story', team: 'T' });
    assert.deepStrictEqual(r2, { ok: true, sprint: null, refs: [] });
    const a = createAdapter({ cwd: proj(), fetch: fakeFetch([{ method: 'POST', match: '/wiql', status: 401, text: 'no' }]) });
    await assert.rejects(a.listSprintStories({ storyType: 'User Story', team: 'T' }),
      (e) => e instanceof TrackerError && e.status === 401 && Boolean(e.credentialHint));
  });

  await test('listSprintStories: storyType is a REQUIRED caller parameter (no adapter default)', async () => {
    const f = fakeFetch([]);
    await assert.rejects(createAdapter({ cwd: proj(), fetch: f }).listSprintStories({ team: 'T' }), /storyType/);
    assert.strictEqual(f.calls.length, 0);
  });

  // ════ neutral reads for the tracker CLI (skill-consolidation-foundation WP-6) ════
  // A richer fake: respond(call, n) per route, optional response headers.
  function fake2(routes = []) {
    const calls = []; const hits = new Map();
    const fn = async (url, opts = {}) => {
      const call = { url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body };
      calls.push(call);
      for (const r of routes) {
        if ((r.method || 'GET') !== call.method || !call.url.includes(r.match)) continue;
        const n = (hits.get(r) || 0) + 1; hits.set(r, n);
        const resp = r.respond ? r.respond(call, n) : r;
        const status = resp.status || 200;
        const text = resp.text !== undefined ? resp.text : JSON.stringify(resp.json ?? {});
        const hdrs = resp.headers || {};
        return { ok: status >= 200 && status < 300, status, text: async () => text, headers: { get: (k) => hdrs[k.toLowerCase()] ?? null } };
      }
      return { ok: true, status: 200, text: async () => '{}', headers: { get: () => null } };
    };
    fn.calls = calls;
    return fn;
  }
  // workitemsbatch echo: returns every requested id except those in `drop`, SHUFFLED (reversed).
  const batchEcho = (drop = []) => ({
    method: 'POST', match: '/wit/workitemsbatch',
    respond: (call) => {
      const b = JSON.parse(call.body);
      return { json: { count: b.ids.length, value: b.ids.filter((i) => !drop.includes(i)).reverse().map((id) => ({ id, fields: { 'System.Title': `T${id}` } })) } };
    },
  });

  await test('getWorkItems: ceil(n/200) POST workitemsbatch requests for 1/200/201/450 ids; input order kept', async () => {
    for (const [n, reqs] of [[1, 1], [200, 1], [201, 2], [450, 3]]) {
      const ids = Array.from({ length: n }, (_, i) => 1000 + n - i); // descending: order is the caller's, not sorted
      const f = fake2([batchEcho()]);
      const res = await createAdapter({ cwd: proj(), fetch: f }).getWorkItems(ids, { fields: ['System.Title'] });
      assert.strictEqual(f.calls.length, reqs, `${n} ids`);
      assert.ok(f.calls.every((c) => c.method === 'POST' && c.url.startsWith(`${BASE}/${PROJ}/_apis/wit/workitemsbatch?api-version=7.1`)));
      assert.ok(f.calls.every((c) => JSON.parse(c.body).ids.length <= 200));
      assert.deepStrictEqual(res.items.map((w) => w.id), ids);
      assert.deepStrictEqual(res.missing, []);
    }
  });

  await test('getWorkItems: body carries ids (numbers), fields, errorPolicy omit; missing ids listed, never dropped', async () => {
    const f = fake2([batchEcho([12])]);
    const res = await createAdapter({ cwd: proj(), fetch: f }).getWorkItems(['11', 12, 13], { fields: ['System.Title', 'System.State'] });
    assert.deepStrictEqual(JSON.parse(f.calls[0].body), { ids: [11, 12, 13], fields: ['System.Title', 'System.State'], errorPolicy: 'omit' });
    assert.deepStrictEqual(res.items.map((w) => w.id), [11, 13]);
    assert.deepStrictEqual(res.missing, [12]);
    const f2 = fake2([{ method: 'POST', match: '/workitemsbatch', json: { value: [{ id: 11, fields: {} }, null] } }]);
    const r2 = await createAdapter({ cwd: proj(), fetch: f2 }).getWorkItems([11, 12]);
    assert.ok(!('fields' in JSON.parse(f2.calls[0].body)), 'no fields -> the key is omitted');
    assert.deepStrictEqual(r2.missing, [12], 'a null slot (errorPolicy omit) counts as missing');
  });

  await test('getWorkItems: a non-integer id is a config error (exit 2) before any request; [] reads nothing', async () => {
    const f = fake2([]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await assert.rejects(a.getWorkItems([1, 'PROJ-1']), (e) => e.exitCode === 2 && /PROJ-1/.test(e.message));
    assert.deepStrictEqual(await a.getWorkItems([]), { items: [], missing: [] });
    assert.strictEqual(f.calls.length, 0);
  });

  await test('getWorkItem {fields}: a fields= param; combining fields with expand is refused (exit 2, zero requests)', async () => {
    const f = fake2([]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await a.getWorkItem(42, { fields: ['System.Title', 'System.Description'] });
    assert.strictEqual(f.calls[0].url, `${BASE}/${PROJ}/_apis/wit/workitems/42?fields=System.Title%2CSystem.Description&api-version=7.1`);
    await assert.rejects(a.getWorkItem(42, { fields: ['System.Title'], expand: 'all' }), (e) => e.exitCode === 2 && /fields.*expand|expand.*fields/.test(e.message));
    assert.strictEqual(f.calls.length, 1);
    await a.getWorkItem(42);
    assert.strictEqual(f.calls[1].url, `${BASE}/${PROJ}/_apis/wit/workitems/42?api-version=7.1`, 'no option -> the URL is unchanged');
  });

  await test('query {top}: $top only when passed; the request bytes are otherwise unchanged', async () => {
    const f = fake2([]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await a.query('SELECT [System.Id] FROM workitems');
    await a.query('SELECT [System.Id] FROM workitems', { top: 50 });
    assert.strictEqual(f.calls[0].url, `${BASE}/${PROJ}/_apis/wit/wiql?api-version=7.1`);
    assert.strictEqual(f.calls[1].url, `${BASE}/${PROJ}/_apis/wit/wiql?$top=50&api-version=7.1`);
    assert.strictEqual(f.calls[0].body, f.calls[1].body);
  });

  const COMMENT = (id, name, date, text) => ({ id, createdBy: { id: `guid-${name}`, displayName: name, uniqueName: `${name.toLowerCase()}@example.com` }, createdDate: date, text });
  await test('listComments: comments API 7.1-preview.4, order=asc, continuationToken followed; HTML -> plain; oldest first', async () => {
    const f = fake2([{ match: '/wit/workItems/42/comments', respond: (call, n) => (n === 1
      ? { json: { count: 2, continuationToken: 'tok-2', comments: [COMMENT(1, 'Ana', '2026-01-01T10:00:00Z', '<div>first &amp; &lt;b&gt;</div>'), COMMENT(2, 'Ben', '2026-01-02T10:00:00Z', 'second<br>line')] } }
      : { json: { count: 1, comments: [COMMENT(3, 'Ana', '2026-01-03T10:00:00Z', '<div>مرحبا</div>')] } }) }]);
    const res = await createAdapter({ cwd: proj(), fetch: f }).listComments(42);
    assert.strictEqual(f.calls.length, 2);
    assert.strictEqual(f.calls[0].url, `${BASE}/${PROJ}/_apis/wit/workItems/42/comments?order=asc&api-version=7.1-preview.4`);
    assert.strictEqual(f.calls[1].url, `${BASE}/${PROJ}/_apis/wit/workItems/42/comments?order=asc&continuationToken=tok-2&api-version=7.1-preview.4`);
    assert.deepStrictEqual(res.map((c) => c.text), ['first & <b>', 'second\nline', 'مرحبا']);
    assert.deepStrictEqual(res[0], { id: 1, author: 'Ana', date: '2026-01-01T10:00:00Z', text: 'first & <b>', user: { id: 'guid-Ana', displayName: 'Ana', email: 'ana@example.com' } });
  });

  await test('listComments: a repeated continuation token fails closed instead of looping', async () => {
    const f = fake2([{ match: '/comments', json: { comments: [], continuationToken: 'same' } }]);
    await assert.rejects(createAdapter({ cwd: proj(), fetch: f }).listComments(42), (e) => e instanceof TrackerError && /continuation/.test(e.message));
    assert.strictEqual(f.calls.length, 2);
  });

  const ITERS = { value: [
    { id: 'g1', name: 'Sprint 8', path: 'Sample Project\\Sprint 8', attributes: { startDate: '2026-01-01T00:00:00Z', finishDate: '2026-01-14T00:00:00Z', timeFrame: 'past' } },
    { id: 'g2', name: 'Sprint 9', path: 'Sample Project\\Sprint 9', attributes: { startDate: '2026-01-15T00:00:00Z', finishDate: '2026-01-28T00:00:00Z', timeFrame: 'current' } },
    { id: 'g3', name: 'Sprint 10', path: 'Sample Project\\Sprint 10', attributes: { timeFrame: 'future' } },
  ] };
  await test('listIterations: ONE team-scoped request; neutral rows; client-side timeframe filter', async () => {
    const f = fake2([{ match: '/_apis/work/teamsettings/iterations', json: ITERS }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const all = await a.listIterations({ team: 'Sample Team' });
    assert.strictEqual(f.calls[0].url, `${BASE}/${PROJ}/Sample%20Team/_apis/work/teamsettings/iterations?api-version=7.1`);
    assert.deepStrictEqual(all[1], { id: 'g2', name: 'Sprint 9', path: 'Sample Project\\Sprint 9', startDate: '2026-01-15T00:00:00Z', finishDate: '2026-01-28T00:00:00Z', timeFrame: 'current' });
    assert.deepStrictEqual(all[2], { id: 'g3', name: 'Sprint 10', path: 'Sample Project\\Sprint 10', startDate: null, finishDate: null, timeFrame: 'future' });
    assert.deepStrictEqual((await a.listIterations({ team: 'Sample Team', timeframe: 'future' })).map((i) => i.name), ['Sprint 10']);
    assert.deepStrictEqual((await a.listIterations({ team: 'Sample Team', timeframe: 'past' })).map((i) => i.name), ['Sprint 8']);
    assert.strictEqual(f.calls.length, 3, 'one request per call');
  });

  await test('listIterations: no team -> exit-2 error naming azure.team, ZERO requests; unknown timeframe refused', async () => {
    const f = fake2([]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    await assert.rejects(a.listIterations({}), (e) => e.exitCode === 2 && /azure\.team/.test(e.message));
    await assert.rejects(a.listIterations({ team: 'T', timeframe: 'soon' }), (e) => e.exitCode === 2 && /current, future, past, all/.test(e.message));
    assert.strictEqual(f.calls.length, 0);
  });

  await test('listChildRefs: ONE project-scoped WIQL on [System.Parent] IN (...) whatever the parent count', async () => {
    const f = fake2([{ method: 'POST', match: '/wit/wiql', json: { workItems: [{ id: 501 }, { id: 502 }] } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    assert.deepStrictEqual(await a.listChildRefs([42, '43']), [501, 502]);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(JSON.parse(f.calls[0].body).query,
      'SELECT [System.Id] FROM workitems WHERE [System.Parent] IN (42, 43) AND [System.TeamProject] = @project ORDER BY [System.Id]');
    await assert.rejects(a.listChildRefs(['x']), (e) => e.exitCode === 2);
    assert.deepStrictEqual(await a.listChildRefs([]), []);
    assert.strictEqual(f.calls.length, 1);
  });

  const IDENT = { count: 1, value: [{ id: 'guid-po', providerDisplayName: 'Pat Owner', properties: { Mail: { $type: 'System.String', $value: 'po@example.com' } } }] };
  await test('findIdentity: identity host derived from the org URL; same Authorization header; neutral rows', async () => {
    for (const [org, host] of [
      ['exampleorg', 'https://vssps.dev.azure.com/exampleorg'],
      ['https://exampleorg.visualstudio.com', 'https://exampleorg.vssps.visualstudio.com'],
    ]) {
      const f = fake2([{ match: '/_apis/identities', json: IDENT }]);
      const res = await createAdapter({ cwd: proj({ org }), fetch: f }).findIdentity('po@example.com');
      assert.strictEqual(f.calls[0].url, `${host}/_apis/identities?searchFilter=General&filterValue=po%40example.com&queryMembership=None&api-version=7.1`);
      assert.strictEqual(f.calls[0].headers.Authorization, `Basic ${SENTINEL_B64}`);
      assert.deepStrictEqual(res, [{ id: 'guid-po', displayName: 'Pat Owner', email: 'po@example.com' }]);
    }
  });

  await test('findIdentity: any other host refuses "mention by email" (exit 2, zero requests); 401 names the Identity (Read) scope', async () => {
    const f = fake2([]);
    await assert.rejects(createAdapter({ cwd: proj({ org: 'https://tfs.example.com/Collection' }), fetch: f }).findIdentity('a@example.com'),
      (e) => e.exitCode === 2 && /mention by email/.test(e.message));
    assert.strictEqual(f.calls.length, 0);
    const f2 = fake2([{ match: '/_apis/identities', status: 401, text: 'no' }]);
    await assert.rejects(createAdapter({ cwd: proj(), fetch: f2 }).findIdentity('a@example.com'),
      (e) => e instanceof TrackerError && e.status === 401 && /Identity \(Read\)/.test(e.message) && Boolean(e.credentialHint));
    assert.strictEqual(f2.calls.length, 1, 'never retried');
  });

  await test('listSuites follows x-ms-continuationtoken; the first request URL is unchanged', async () => {
    const f = fake2([{ match: '/testplan/Plans/3/suites', respond: (call, n) => (n === 1
      ? { json: { value: [{ id: 4, name: 'A' }] }, headers: { 'x-ms-continuationtoken': 'c2' } }
      : { json: { value: [{ id: 5, name: 'B' }] } }) }]);
    const res = await createAdapter({ cwd: proj(), fetch: f }).listSuites(3);
    assert.deepStrictEqual(res.map((s) => s.id), [4, 5]);
    assert.strictEqual(f.calls[0].url, `${BASE}/${PROJ}/_apis/testplan/Plans/3/suites?api-version=7.1`);
    assert.strictEqual(f.calls[1].url, `${BASE}/${PROJ}/_apis/testplan/Plans/3/suites?continuationToken=c2&api-version=7.1`);
    const plain = fakeFetch([{ match: '/suites', json: { value: [{ id: 4 }] } }]);
    assert.strictEqual((await createAdapter({ cwd: proj(), fetch: plain }).listSuites(3)).length, 1, 'a response without headers is one page');
  });

  await test('new capability flags: batchRead, sprints, relations child/related', async () => {
    const c = createAdapter({ cwd: proj(), fetch: fakeFetch([]) }).capabilities;
    assert.strictEqual(c.batchRead, true);
    assert.strictEqual(c.sprints, true);
    assert.deepStrictEqual(c.relations, { parent: true, child: true, related: true, testedBy: true, attachedFile: true });
  });

  await test('addComment: POST wit/workItems/{id}/comments (7.1-preview.4) {text}; the dry-run body is EXACT (never summarized)', async () => {
    const long = `<div>${'x'.repeat(300)} &lt;tag&gt; مرحبا</div>`;
    const f = fake2([{ method: 'POST', match: '/wit/workItems/42/comments', json: { id: 77, workItemId: 42 } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const d = await a.addComment(42, long, { execute: false });
    assert.strictEqual(f.calls.length, 0, 'dry run sends nothing');
    assert.strictEqual(d.method, 'POST');
    assert.strictEqual(d.url, `${BASE}/${PROJ}/_apis/wit/workItems/42/comments?api-version=7.1-preview.4`);
    assert.deepStrictEqual(d.body, { text: long }, 'the exact body the execute run sends');
    assert.strictEqual(d.headers.authorization, '<Basic ***, not printed>');
    const r = await a.addComment(42, long, { execute: true });
    assert.strictEqual(f.calls.length, 1);
    assert.deepStrictEqual(JSON.parse(f.calls[0].body), { text: long });
    assert.strictEqual(f.calls[0].headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(r, { id: 77, workItemId: 42 });
  });

  await test('addComment: the CI choke point refuses execute:true (exit 2, ci-mode, zero requests); the dry run still works', async () => {
    process.env.AGENTEX_CI = '1';
    try {
      const f = fake2([]);
      const a = createAdapter({ cwd: proj(), fetch: f });
      await assert.rejects(a.addComment(42, 'x', { execute: true }), (e) => e.exitCode === 2 && e.reason === 'ci-mode');
      assert.strictEqual((await a.addComment(42, 'x', { execute: false })).method, 'POST');
      assert.strictEqual(f.calls.length, 0);
    } finally { delete process.env.AGENTEX_CI; }
  });

  await test('capability comments is now true on ADO (comment threads read + written via the comments API)', async () => {
    assert.strictEqual(createAdapter({ cwd: proj(), fetch: fakeFetch([]) }).capabilities.comments, true);
  });

  // ════ test-plan "ensure" ops (WP-9) ════
  await test('listPlans: GET testplan/plans following x-ms-continuationtoken -> { plans, truncated:false }', async () => {
    const f = fake2([{ match: '/_apis/testplan/plans', respond: (call, n) => (n === 1
      ? { json: { value: [{ id: 1, name: 'A', rootSuite: { id: 10 } }] }, headers: { 'x-ms-continuationtoken': 't2' } }
      : { json: { value: [{ id: 2, name: 'B', rootSuite: { id: 20 } }] } }) }]);
    const res = await createAdapter({ cwd: proj(), fetch: f }).listPlans();
    assert.deepStrictEqual(res.plans.map((p) => p.id), [1, 2]);
    assert.strictEqual(res.truncated, false);
    assert.strictEqual(f.calls[0].url, `${BASE}/${PROJ}/_apis/testplan/plans?api-version=7.1`);
    assert.strictEqual(f.calls[1].url, `${BASE}/${PROJ}/_apis/testplan/plans?continuationToken=t2&api-version=7.1`);
  });

  await test('listPlans: a page cap reports truncated:true (the caller then cannot prove a name absent)', async () => {
    const f = fake2([{ match: '/_apis/testplan/plans', respond: (call, n) => ({ json: { value: [{ id: n, name: `P${n}` }] }, headers: { 'x-ms-continuationtoken': `t${n + 1}` } }) }]);
    const res = await createAdapter({ cwd: proj(), fetch: f }).listPlans({ maxPages: 3 });
    assert.strictEqual(res.truncated, true);
    assert.strictEqual(f.calls.length, 3);
  });

  await test('getPlan: GET testplan/plans/{id}', async () => {
    const f = fake2([{ match: '/testplan/plans/7', json: { id: 7, name: 'P', rootSuite: { id: 70 } } }]);
    const p = await createAdapter({ cwd: proj(), fetch: f }).getPlan(7);
    assert.strictEqual(p.rootSuite.id, 70);
    assert.strictEqual(f.calls[0].url, `${BASE}/${PROJ}/_apis/testplan/plans/7?api-version=7.1`);
  });

  await test('createPlan: dry-run descriptor (POST testplan/plans {name, areaPath?, iteration?}); execute hits the CI choke point', async () => {
    const f = fake2([{ method: 'POST', match: '/_apis/testplan/plans', json: { id: 9, name: 'Gate', rootSuite: { id: 90 } } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const d = await a.createPlan({ name: 'Gate', areaPath: 'Sample Project\\QA' }, { execute: false });
    assert.strictEqual(d.method, 'POST');
    assert.strictEqual(d.url, `${BASE}/${PROJ}/_apis/testplan/plans?api-version=7.1`);
    assert.deepStrictEqual(d.body, { name: 'Gate', areaPath: 'Sample Project\\QA' });
    assert.strictEqual(f.calls.length, 0);
    const r = await a.createPlan({ name: 'Gate' }, { execute: true });
    assert.deepStrictEqual(JSON.parse(f.calls[0].body), { name: 'Gate' });
    assert.deepStrictEqual(r, { id: 9, name: 'Gate', rootSuiteId: 90 });
    process.env.AGENTEX_CI = '1';
    try { await assert.rejects(a.createPlan({ name: 'Gate' }, { execute: true }), (e) => e.reason === 'ci-mode'); }
    finally { delete process.env.AGENTEX_CI; }
    assert.strictEqual(f.calls.length, 1);
  });

  await test('createSuite: requirement and static bodies under a parent; execute hits the CI choke point', async () => {
    const f = fake2([{ method: 'POST', match: '/testplan/Plans/7/suites', json: { id: 71, name: 'S', suiteType: 'staticTestSuite' } }]);
    const a = createAdapter({ cwd: proj(), fetch: f });
    const d1 = await a.createSuite(7, { type: 'requirement', requirementId: 42, parent: 70 }, { execute: false });
    assert.strictEqual(d1.url, `${BASE}/${PROJ}/_apis/testplan/Plans/7/suites?api-version=7.1`);
    assert.deepStrictEqual(d1.body, { suiteType: 'requirementTestSuite', requirementId: 42, parentSuite: { id: 70 } });
    const d2 = await a.createSuite(7, { type: 'static', name: 'Regression — gate', parent: 70 }, { execute: false });
    assert.deepStrictEqual(d2.body, { suiteType: 'staticTestSuite', name: 'Regression — gate', parentSuite: { id: 70 } });
    await assert.rejects(a.createSuite(7, { type: 'dynamic', parent: 70 }, { execute: false }), (e) => e.exitCode === 2);
    assert.strictEqual(f.calls.length, 0);
    const r = await a.createSuite(7, { type: 'static', name: 'S', parent: 70 }, { execute: true });
    assert.deepStrictEqual(r, { id: 71, name: 'S', suiteType: 'staticTestSuite' });
    process.env.AGENTEX_CI = '1';
    try { await assert.rejects(a.createSuite(7, { type: 'static', name: 'S', parent: 70 }, { execute: true }), (e) => e.reason === 'ci-mode'); }
    finally { delete process.env.AGENTEX_CI; }
    assert.strictEqual(f.calls.length, 1);
  });

  // ════ removeCaseFromSuite (release gate only, WP-14) ════
  const members = (ids) => ({ value: ids.map((id) => ({ workItem: { id, name: `TC ${id}` } })) });
  await test('removeCaseFromSuite: dry run = DELETE testplan/.../TestCase?testCaseIds=… descriptor; association only, no destroy', async () => {
    const f = fake2([]);
    const d = await createAdapter({ cwd: proj(), fetch: f }).removeCaseFromSuite(3, 4, [77, '78'], { execute: false });
    assert.strictEqual(d.method, 'DELETE');
    assert.strictEqual(d.url, `${BASE}/${PROJ}/_apis/testplan/Plans/3/Suites/4/TestCase?testCaseIds=77%2C78&api-version=7.1`);
    assert.ok(!/destroy/i.test(JSON.stringify(d)) && !/wit\/workitems/i.test(d.url));
    assert.strictEqual(f.calls.length, 0);
  });

  await test('removeCaseFromSuite --execute: reads members, removes only members (idempotent), re-reads; never DELETEs a work item', async () => {
    let removed = false;
    const f = fake2([
      { method: 'DELETE', match: '/testplan/Plans/3/Suites/4/TestCase', respond: () => { removed = true; return { text: '' }; } },
      { match: '/testplan/Plans/3/Suites/4/TestCase', respond: () => ({ json: members(removed ? [90] : [77, 90]) }) },
    ]);
    const r = await createAdapter({ cwd: proj(), fetch: f }).removeCaseFromSuite(3, 4, [77, 78], { execute: true });
    assert.deepStrictEqual(r, { ids: [77, 78], removed: [77], notMembers: [78], planId: 3, suiteId: 4 });
    assert.deepStrictEqual(f.calls.map((c) => c.method), ['GET', 'DELETE', 'GET']);
    assert.match(f.calls[1].url, /TestCase\?testCaseIds=77&api-version/);
    assert.ok(!f.calls.some((c) => c.method === 'DELETE' && /wit\/workitems/i.test(c.url)), 'a work item is never deleted');
    assert.ok(!f.calls.some((c) => /destroy/i.test(c.url)));
    const g = fake2([{ match: '/TestCase', json: members([90]) }]);
    const r2 = await createAdapter({ cwd: proj(), fetch: g }).removeCaseFromSuite(3, 4, [77], { execute: true });
    assert.deepStrictEqual(r2.removed, []);
    assert.deepStrictEqual(g.calls.map((c) => c.method), ['GET'], 'nothing to remove -> no DELETE');
  });

  await test('removeCaseFromSuite fails closed when a case is still a member on re-read; CI choke point refuses execute', async () => {
    const f = fake2([
      { method: 'DELETE', match: '/TestCase', text: '' },
      { match: '/TestCase', json: members([77]) },
    ]);
    await assert.rejects(createAdapter({ cwd: proj(), fetch: f }).removeCaseFromSuite(3, 4, [77], { execute: true }),
      (e) => e instanceof TrackerError && /77/.test(e.message) && /re-read/.test(e.message));
    process.env.AGENTEX_CI = '1';
    try {
      const g = fake2([]);
      await assert.rejects(createAdapter({ cwd: proj(), fetch: g }).removeCaseFromSuite(3, 4, [77], { execute: true }), (e) => e.reason === 'ci-mode');
      assert.strictEqual(g.calls.length, 0);
    } finally { delete process.env.AGENTEX_CI; }
  });

  // ── primitives shared with Phase 0 (listIterations, getWorkItems) ──────────
  await test('listIterations({team}): ONE GET {project}/{team}/_apis/work/teamsettings/iterations, team URL-encoded; neutral shape, unfiltered', async () => {
    const f = fakeFetch([{ match: '/_apis/work/teamsettings/iterations', json: { value: [
      { id: 'g1', name: 'Sprint 41', path: 'Sample Project\\Sprint 41', attributes: { startDate: '2026-09-01T00:00:00Z', finishDate: '2026-09-14T00:00:00Z', timeFrame: 'past' } },
      { id: 'g2', name: 'Sprint 43', path: 'Sample Project\\Sprint 43', attributes: { timeFrame: 'current' } },
    ] } }]);
    const r = await createAdapter({ cwd: proj(), fetch: f }).listIterations({ team: 'QA & Team A' });
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].method, 'GET');
    assert.strictEqual(f.calls[0].url, `${BASE}/${PROJ}/QA%20%26%20Team%20A/_apis/work/teamsettings/iterations?api-version=7.1`);
    assert.ok(!f.calls[0].url.includes('timeframe'), 'no $timeframe filter is relied on (only Current is supported server-side)');
    assert.deepStrictEqual(r, [
      { id: 'g1', name: 'Sprint 41', path: 'Sample Project\\Sprint 41', startDate: '2026-09-01T00:00:00Z', finishDate: '2026-09-14T00:00:00Z', timeFrame: 'past' },
      { id: 'g2', name: 'Sprint 43', path: 'Sample Project\\Sprint 43', startDate: null, finishDate: null, timeFrame: 'current' },
    ]);
  });

  await test('listIterations: no team refuses (exit 2) with ZERO requests', async () => {
    const f = fakeFetch([]);
    await assert.rejects(createAdapter({ cwd: proj(), fetch: f }).listIterations({}), (e) => e.exitCode === 2 && /team/i.test(e.message));
    assert.strictEqual(f.calls.length, 0);
  });

  await test('getWorkItems(ids, {fields}): POST wit/workitemsbatch, chunks of 200 — 1/200/201/450 ids → 1/1/2/3 requests, input order kept', async () => {
    for (const [n, requests] of [[1, 1], [200, 1], [201, 2], [450, 3]]) {
      const ids = Array.from({ length: n }, (_, i) => 1000 + n - i); // descending input
      const f = fakeFetch([{ method: 'POST', match: '/_apis/wit/workitemsbatch', json: (calls) => {
        const body = JSON.parse(calls[calls.length - 1].body);
        return { value: [...body.ids].sort((a, b) => a - b).map((id) => ({ id, fields: { 'System.Id': id } })) }; // service order differs
      } }]);
      const r = await createAdapter({ cwd: proj(), fetch: f }).getWorkItems(ids, { fields: ['System.Id', 'System.Title'] });
      assert.strictEqual(f.calls.length, requests, `${n} ids`);
      assert.deepStrictEqual(r.items.map((w) => w.id), ids, 'input order restored');
      assert.deepStrictEqual(r.missing, []);
      for (const c of f.calls) {
        assert.strictEqual(c.method, 'POST');
        assert.strictEqual(c.url, `${BASE}/${PROJ}/_apis/wit/workitemsbatch?api-version=7.1`);
        const body = JSON.parse(c.body);
        assert.deepStrictEqual(body.fields, ['System.Id', 'System.Title']);
        assert.strictEqual(body.errorPolicy, 'omit');
        assert.ok(body.ids.length <= 200);
      }
    }
  });

  await test('getWorkItems: ids the service omits are listed in missing; zero ids send nothing; bad ids refuse', async () => {
    const f = fakeFetch([{ method: 'POST', match: '/workitemsbatch', json: { value: [{ id: 7, fields: {} }] } }]);
    const r = await createAdapter({ cwd: proj(), fetch: f }).getWorkItems([7, 8], { fields: ['System.Id'] });
    assert.deepStrictEqual(r.items.map((w) => w.id), [7]);
    assert.deepStrictEqual(r.missing, [8]);
    const f0 = fakeFetch([]);
    assert.deepStrictEqual(await createAdapter({ cwd: proj(), fetch: f0 }).getWorkItems([], { fields: ['System.Id'] }), { items: [], missing: [] });
    assert.strictEqual(f0.calls.length, 0);
    await assert.rejects(createAdapter({ cwd: proj(), fetch: f0 }).getWorkItems(['x']), (e) => e.exitCode === 2);
  });

  // ── neutral history reads (first-run estimation proposal) ────────────────
  // The field guard: no history request ever carries a time-spent, remaining,
  // worklog or description field — only the Original Estimate is read.
  const FORBIDDEN = /CompletedWork|RemainingWork|timespent|timeestimate|timetracking|aggregatetimespent|worklog|description|renderedFields/i;
  const assertFieldGuard = (calls) => {
    assert.ok(calls.length > 0, 'requests were sent');
    for (const c of calls) {
      assert.ok(!FORBIDDEN.test(c.url), `forbidden field in URL ${c.url}`);
      assert.ok(!FORBIDDEN.test(String(c.body || '')), `forbidden field in body ${c.body}`);
    }
  };
  const ITER = (id, name, timeFrame, startDate, finishDate) => ({ id, name, path: `Sample Project\\${name}`, attributes: { timeFrame, startDate, finishDate } });

  await test('listPastSprints: no team → team-required with ZERO requests (flow-free)', async () => {
    const f = fakeFetch([]);
    const r = await createAdapter({ cwd: proj(), fetch: f }).listPastSprints({ team: null, count: 2 });
    assert.deepStrictEqual(r, { ok: false, condition: 'team-required', data: {} });
    assert.strictEqual(f.calls.length, 0);
    assertFlowFree(r);
  });

  await test('listPastSprints: ONE iterations GET; keeps timeFrame past, newest finishDate first (ties: startDate, then name), takes count', async () => {
    const f = fakeFetch([{ match: '/work/teamsettings/iterations', json: { value: [
      ITER('a', 'Sprint 40', 'past', '2026-08-18', '2026-08-31'),
      ITER('b', 'Sprint 43', 'current', '2026-10-13', '2026-10-26'),
      ITER('c', 'Sprint 42', 'past', '2026-09-15', '2026-09-28'),
      ITER('d', 'Sprint 41b', 'past', '2026-09-02', '2026-09-28'),
      ITER('e', 'Sprint 44', 'future', '2026-10-27', '2026-11-09'),
      ITER('f', 'Sprint 41a', 'past', '2026-09-02', '2026-09-28'),
    ] } }]);
    const r = await createAdapter({ cwd: proj(), fetch: f }).listPastSprints({ team: 'Sample Team', count: 3 });
    assert.strictEqual(f.calls.length, 1);
    assert.deepStrictEqual(r, { ok: true, found: 4, sprints: [
      { id: 'c', name: 'Sprint 42', path: 'Sample Project\\Sprint 42', finishDate: '2026-09-28' },
      { id: 'f', name: 'Sprint 41a', path: 'Sample Project\\Sprint 41a', finishDate: '2026-09-28' },
      { id: 'd', name: 'Sprint 41b', path: 'Sample Project\\Sprint 41b', finishDate: '2026-09-28' },
    ] });
    assertFlowFree(r);
  });

  await test('listPastSprints: fewer past iterations than asked → the ones that exist; none → an empty list', async () => {
    const f = fakeFetch([{ match: '/work/teamsettings/iterations', json: { value: [ITER('a', 'Sprint 1', 'past', '2026-01-01', '2026-01-14')] } }]);
    const r = await createAdapter({ cwd: proj(), fetch: f }).listPastSprints({ team: 'T', count: 2 });
    assert.deepStrictEqual(r.sprints.map((s) => s.name), ['Sprint 1']);
    assert.strictEqual(r.found, 1);
    const g = fakeFetch([{ match: '/work/teamsettings/iterations', json: { value: [ITER('b', 'Sprint 2', 'current')] } }]);
    assert.deepStrictEqual(await createAdapter({ cwd: proj(), fetch: g }).listPastSprints({ team: 'T', count: 2 }), { ok: true, found: 0, sprints: [] });
  });

  // A history board: stories 2101/2102 in two past sprints, each with children.
  const historyRoutes = (extra = []) => [
    ...extra,
    { method: 'POST', match: '/_apis/wit/wiql', json: (calls) => {
      const q = JSON.parse(calls[calls.length - 1].body).query;
      if (q.includes('[System.Parent]')) return { workItems: [{ id: 4511 }, { id: 4512 }, { id: 4520 }, { id: 4521 }] };
      return { workItems: [{ id: 2101 }, { id: 2102 }] };
    } },
    { method: 'POST', match: '/_apis/wit/workitemsbatch', json: (calls) => {
      const ids = JSON.parse(calls[calls.length - 1].body).ids;
      const all = {
        2101: { id: 2101, fields: { 'System.Id': 2101, 'System.Title': 'Contact preferences' } },
        2102: { id: 2102, fields: { 'System.Id': 2102, 'System.Title': 'Checkout address form' } },
        4511: { id: 4511, fields: { 'System.Id': 4511, 'System.Title': '[Testing] Test Execution', 'System.Parent': 2101, 'Microsoft.VSTS.Scheduling.OriginalEstimate': 2 } },
        4512: { id: 4512, fields: { 'System.Id': 4512, 'System.Title': 'Build the form', 'System.Parent': 2102, 'Microsoft.VSTS.Scheduling.OriginalEstimate': 1.234 } },
        4520: { id: 4520, fields: { 'System.Id': 4520, 'System.Title': '[Testing] Test Execution', 'System.Parent': 2102, 'Microsoft.VSTS.Scheduling.OriginalEstimate': 0 } },
        4521: { id: 4521, fields: { 'System.Id': 4521, 'System.Title': '[Testing] Requirement Review', 'System.Parent': 2102 } },
      };
      return { value: ids.map((id) => all[id]).filter(Boolean) };
    } },
  ];
  const PAST = [{ id: 'c', name: 'Sprint 42', path: "Sample Project\\Sprint 42" }, { id: 'a', name: "Sprint 41's", path: "Sample Project\\Sprint 41's" }];

  await test('listChildEstimates: the exact request sequence and texts — story WIQL, story titles, child WIQL, child estimates', async () => {
    const f = fakeFetch(historyRoutes());
    const r = await createAdapter({ cwd: proj(), fetch: f }).listChildEstimates({ sprints: PAST, storyType: 'User Story' });
    assert.deepStrictEqual(f.calls.map((c) => `${c.method} ${c.url.replace(`${BASE}/${PROJ}/_apis/`, '')}`), [
      'POST wit/wiql?api-version=7.1',
      'POST wit/workitemsbatch?api-version=7.1',
      'POST wit/wiql?api-version=7.1',
      'POST wit/workitemsbatch?api-version=7.1',
    ]);
    assert.strictEqual(JSON.parse(f.calls[0].body).query,
      "SELECT [System.Id] FROM workitems WHERE [System.TeamProject]='Sample Project' AND [System.WorkItemType]='User Story'" +
      " AND [System.IterationPath] IN ('Sample Project\\Sprint 42', 'Sample Project\\Sprint 41''s') ORDER BY [System.Id]");
    assert.deepStrictEqual(JSON.parse(f.calls[1].body), { ids: [2101, 2102], fields: ['System.Id', 'System.Title'], errorPolicy: 'omit' });
    assert.strictEqual(JSON.parse(f.calls[2].body).query,
      "SELECT [System.Id] FROM workitems WHERE [System.TeamProject]='Sample Project' AND [System.Parent] IN (2101, 2102) ORDER BY [System.Id]");
    assert.deepStrictEqual(JSON.parse(f.calls[3].body), {
      ids: [4511, 4512, 4520, 4521],
      fields: ['System.Id', 'System.Title', 'System.Parent', 'Microsoft.VSTS.Scheduling.OriginalEstimate'], errorPolicy: 'omit',
    });
    assert.deepStrictEqual(r, {
      stories: [
        { id: 2101, seq: 2101, title: 'Contact preferences', url: `${BASE}/${PROJ}/_workitems/edit/2101` },
        { id: 2102, seq: 2102, title: 'Checkout address form', url: `${BASE}/${PROJ}/_workitems/edit/2102` },
      ],
      children: [
        { id: 4511, seq: 4511, title: '[Testing] Test Execution', parentId: 2101, hours: 2 },
        { id: 4512, seq: 4512, title: 'Build the form', parentId: 2102, hours: 1.23 },
        { id: 4520, seq: 4520, title: '[Testing] Test Execution', parentId: 2102, hours: null },
        { id: 4521, seq: 4521, title: '[Testing] Requirement Review', parentId: 2102, hours: null },
      ],
      truncated: false,
    });
    assertFlowFree(r);
    assertFieldGuard(f.calls);
  });

  await test('listChildEstimates: ZERO requests for no sprints; a sprint set with no stories stops after the story WIQL', async () => {
    const f = fakeFetch([]);
    assert.deepStrictEqual(await createAdapter({ cwd: proj(), fetch: f }).listChildEstimates({ sprints: [], storyType: 'User Story' }),
      { stories: [], children: [], truncated: false });
    assert.strictEqual(f.calls.length, 0);
    const g = fakeFetch([{ method: 'POST', match: '/wiql', json: { workItems: [] } }]);
    const r = await createAdapter({ cwd: proj(), fetch: g }).listChildEstimates({ sprints: PAST, storyType: 'User Story' });
    assert.deepStrictEqual(r, { stories: [], children: [], truncated: false });
    assert.strictEqual(g.calls.length, 1);
  });

  await test('listChildEstimates: the child WIQL runs per 200-story chunk (201 stories → 2 child queries)', async () => {
    const storyIds = Array.from({ length: 201 }, (_, i) => 3000 + i);
    const f = fakeFetch([
      { method: 'POST', match: '/_apis/wit/wiql', json: (calls) => {
        const q = JSON.parse(calls[calls.length - 1].body).query;
        return q.includes('[System.Parent]') ? { workItems: [] } : { workItems: storyIds.map((id) => ({ id })) };
      } },
      { method: 'POST', match: '/workitemsbatch', json: (calls) => ({ value: JSON.parse(calls[calls.length - 1].body).ids.map((id) => ({ id, fields: { 'System.Title': `S${id}` } })) }) },
    ]);
    await createAdapter({ cwd: proj(), fetch: f }).listChildEstimates({ sprints: PAST, storyType: 'User Story' });
    const childQueries = f.calls.filter((c) => c.url.includes('/wiql') && JSON.parse(c.body).query.includes('[System.Parent]'));
    assert.strictEqual(childQueries.length, 2);
    assert.ok(JSON.parse(childQueries[0].body).query.includes('IN (3000, 3001,'), 'chunk 1 starts at the first story');
    assert.ok(JSON.parse(childQueries[1].body).query.includes('IN (3200)'), 'chunk 2 holds the 201st');
    assertFieldGuard(f.calls);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
