'use strict';
// Unit tests for the Azure DevOps REST adapter. Run: node scripts/lib/tracker/adapters/ado.test.js
// Fully offline: fetch is INJECTED (never monkey-patched) — a scripted fake with
// call recording. No network, no ADO org, no az CLI anywhere.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdapter, TrackerError, PAT_ENV_NAMES } = require('./ado.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const SENTINEL_PAT = 'SENTINEL-PAT-a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SENTINEL_B64 = Buffer.from(':' + SENTINEL_PAT).toString('base64');

// The tests own the PAT environment — the machine's real values must not leak in.
for (const n of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'AGENTEX_CI']) delete process.env[n];

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
    assert.deepStrictEqual(a.capabilities.relations, { parent: true, testedBy: true, attachedFile: true });
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

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
