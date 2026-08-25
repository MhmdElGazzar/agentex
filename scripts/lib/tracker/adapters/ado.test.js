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
for (const n of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT']) delete process.env[n];

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
        const text = r.text !== undefined ? r.text : JSON.stringify(r.json !== undefined ? r.json : {});
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

  await test('addCaseToSuite PATCHes the pinned suite-entries route with body [{id}]', async () => {
    const f = fakeFetch([{ method: 'PATCH', match: '/testplan/suiteentry/', json: {} }]);
    await createAdapter({ cwd: proj(), fetch: f }).addCaseToSuite(3, 4, 505, { execute: true });
    const call = f.calls[0];
    assert.ok(call.url.includes(`${BASE}/${PROJ}/_apis/testplan/suiteentry/4?`), call.url);
    assert.match(call.url, /api-version=7\.1-preview\.2/, 'suite entries is a -preview endpoint');
    assert.deepStrictEqual(JSON.parse(call.body), [{ id: 505 }]);
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

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
