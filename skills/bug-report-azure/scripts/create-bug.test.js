'use strict';
// Self-contained tests for the rebuilt create-bug.js — validate phase / write
// phase / ledger, all through the tracker lib with an INJECTED fake fetch.
// Offline: no network, no ADO org, no az CLI. One spawned run proves the
// one-JSON-line CLI contract (it blocks on config before any fetch).
// Run: node skills/bug-report-azure/scripts/create-bug.test.js
//
// Coverage per docs/contributing/testing.md + the design's assertion table:
//   success paths  : dry-run plan (exit 0), full --execute in D-5 order
//   FAIL modes     : write failure injected at each step -> exit 1 + exact ledger
//   BLOCKED        : missing spec fields, invalid picklist value (with options),
//                    dup found w/o --allow-duplicate, DUP CHECK ERROR (fails
//                    CLOSED), parent not a User Story, no evidence w/o waiver
//   safety rules   : zero writes in dry run, created IDs always in the JSON,
//                    sentinel PAT in zero bytes of output, no child_process,
//                    no process.exit (exitCode + event-loop drain)
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('./create-bug.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const SENTINEL_PAT = 'SENTINEL-PAT-createbug-00112233445566778899';
for (const n of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'AZURE_URL', 'AZURE_PROJECT']) delete process.env[n];

// A structurally valid PNG > 2KB (signature + IHDR with real dimensions + noise).
function fakePng() {
  const head = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]), Buffer.from('IHDR'),
    Buffer.from([0x00, 0x00, 0x05, 0x00]), // width 1280
    Buffer.from([0x00, 0x00, 0x03, 0x00]), // height 768
    Buffer.from([0x08, 0x06, 0x00, 0x00, 0x00]),
  ]);
  const noise = Buffer.alloc(4096);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) % 251;
  return Buffer.concat([head, noise]);
}

let specSeq = 0;
function proj({ azureExtra = {}, withAttachment = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-cb-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
    azure: { org: 'exampleorg', project: 'Sample Project', assignee: 'qa.engineer@example.com', environment: 'QA', ...azureExtra },
  }));
  fs.writeFileSync(path.join(dir, '.env'), `AZURE_PAT=${SENTINEL_PAT}\n`);
  if (withAttachment) fs.writeFileSync(path.join(dir, 'evidence.png'), fakePng());
  return dir;
}

function writeSpec(dir, overrides = {}) {
  const spec = {
    title: `Payment fails at checkout ${++specSeq}`,
    severity: '2 - High',
    priority: 1,
    parentStoryId: 321,
    assignedTo: 'qa.engineer@example.com',
    summary: 'Clicking Pay shows a 500 page',
    steps: ['Open checkout', 'Fill the form', 'Click Pay'],
    expected: 'Order confirmation appears',
    actual: 'HTTP 500 error page',
    environment: 'QA',
    attachments: [path.join(dir, 'evidence.png')],
    ...overrides,
  };
  const file = path.join(dir, `spec-${specSeq}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  return file;
}

const BUG_FIELDS = {
  value: [
    { referenceName: 'System.Title', alwaysRequired: true },
    { referenceName: 'System.AreaPath' }, { referenceName: 'System.IterationPath' },
    { referenceName: 'System.AssignedTo' },
    { referenceName: 'Microsoft.VSTS.Common.Severity', allowedValues: ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'] },
    { referenceName: 'Microsoft.VSTS.Common.Priority', allowedValues: ['1', '2', '3', '4'] },
    { referenceName: 'Microsoft.VSTS.Common.ValueArea', allowedValues: ['Architectural', 'Business'] },
    { referenceName: 'Custom.Environment', allowedValues: ['QA', 'UAT', 'Prod'] },
    { referenceName: 'Microsoft.VSTS.TCM.ReproSteps' },
  ],
};
const PARENT = { id: 321, fields: { 'System.WorkItemType': 'User Story', 'System.Title': 'Checkout story', 'System.State': 'Active', 'System.AreaPath': 'Proj\\Area', 'System.IterationPath': 'Proj\\Sprint 9' } };

// Fake fetch with method + url-substring + optional body-substring matching.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', body: opts.body, headers: opts.headers || {} };
    calls.push(call);
    for (const r of routes) {
      if ((r.method || 'GET') !== call.method) continue;
      if (!call.url.includes(r.match)) continue;
      if (r.bodyMatch && !(typeof call.body === 'string' && call.body.includes(r.bodyMatch))) continue;
      const status = r.status || 200;
      return { ok: status < 300, status, text: async () => (r.text !== undefined ? r.text : JSON.stringify(r.json || {})) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

// The happy-path route table; override/prepend entries to inject failures.
function happyRoutes(extra = []) {
  return [
    ...extra,
    { match: '/wit/workitems/321', json: PARENT },
    { method: 'POST', match: '/wiql', json: { workItems: [] } },
    { match: '/wit/workitemtypes/Bug/fields', json: BUG_FIELDS },
    { method: 'POST', match: 'validateOnly=true', json: {} },
    { method: 'POST', match: '/_apis/wit/attachments', json: { id: 'att-1', url: 'https://dev.azure.com/exampleorg/att/1' } },
    { method: 'POST', match: '/workitems/$Bug', json: { id: 4711 } },
    { method: 'PATCH', match: '/workitems/4711', json: { id: 4711, rev: 2 } },
  ];
}

const isWrite = (c) =>
  (c.method === 'POST' && (c.url.includes('/attachments') || (c.url.includes('/workitems/$') && !c.url.includes('validateOnly=true')))) ||
  c.method === 'PATCH';

(async () => {
  await test('dry run: full plan JSON, exit 0 — and ZERO writes leave the machine', async () => {
    const dir = proj();
    const f = fakeFetch(happyRoutes());
    const { code, out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.mode, 'plan');
    assert.strictEqual(out.validation.parent.id, 321);
    assert.strictEqual(out.validation.parent.type, 'User Story');
    assert.deepStrictEqual(out.validation.duplicates, []);
    assert.strictEqual(out.validation.validateOnly, 'passed');
    assert.ok(out.validation.attachments[0].ok);
    assert.deepStrictEqual(out.plan.map((p) => p.step),
      ['upload-attachment', 'create-bug', 'link-parent', 'set-repro-and-evidence']);
    for (const p of out.plan) assert.ok(p.request && p.request.method && p.request.url, `plan step ${p.step} names its route`);
    assert.ok(out.cache && out.cache.file.includes('tracker-fields-ado.json'));
    assert.strictEqual(f.calls.filter(isWrite).length, 0, 'dry run must write nothing');
  });

  await test('missing required spec fields exit 2 and are never inferred', async () => {
    const dir = proj();
    const f = fakeFetch(happyRoutes());
    const { code, out } = await run(['--spec', writeSpec(dir, { severity: '', assignedTo: null })], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2);
    assert.strictEqual(out.ok, false);
    const reasons = JSON.stringify(out.blocked);
    assert.match(reasons, /severity/);
    assert.match(reasons, /assignedTo/);
    assert.strictEqual(f.calls.length, 0, 'blocked before any read');
  });

  await test('invalid severity vs the project cache exits 2 WITH the valid options', async () => {
    const dir = proj();
    const { code, out } = await run(['--spec', writeSpec(dir, { severity: 'Catastrophic' })], { cwd: dir, fetch: fakeFetch(happyRoutes()) });
    assert.strictEqual(code, 2);
    const bad = out.blocked.find((b) => b.field === 'Microsoft.VSTS.Common.Severity');
    assert.ok(bad, JSON.stringify(out.blocked));
    assert.deepStrictEqual(bad.allowedValues, ['1 - Critical', '2 - High', '3 - Medium', '4 - Low']);
  });

  await test('a config-supplied value invalid for the project blocks too (config never rewritten)', async () => {
    const dir = proj({ azureExtra: { environment: 'Staging' } });
    const before = fs.readFileSync(path.join(dir, 'config', 'project.json'), 'utf8');
    const { code, out } = await run(['--spec', writeSpec(dir, { environment: undefined })], { cwd: dir, fetch: fakeFetch(happyRoutes()) });
    assert.strictEqual(code, 2);
    const bad = out.blocked.find((b) => b.field === 'Custom.Environment');
    assert.deepStrictEqual(bad.allowedValues, ['QA', 'UAT', 'Prod']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config', 'project.json'), 'utf8'), before, 'invariant 11');
  });

  await test('DUP CHECK FAILS CLOSED: a WIQL server error exits 2 with zero writes', async () => {
    const dir = proj();
    const f = fakeFetch(happyRoutes([{ method: 'POST', match: '/wiql', status: 500, text: 'internal error' }]));
    const { code, out } = await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2);
    assert.match(JSON.stringify(out.blocked), /duplicate check failed/i);
    assert.strictEqual(f.calls.filter(isWrite).length, 0, 'a failed dup check must block, never proceed');
  });

  await test('dup found without --allow-duplicate exits 2; with the flag it proceeds', async () => {
    const dir = proj();
    const dup = [{ method: 'POST', match: '/wiql', json: { workItems: [{ id: 4000 }] } }];
    const r1 = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: fakeFetch(happyRoutes(dup)) });
    assert.strictEqual(r1.code, 2);
    assert.match(JSON.stringify(r1.out.blocked), /4000/);
    const r2 = await run(['--spec', writeSpec(dir), '--allow-duplicate'], { cwd: dir, fetch: fakeFetch(happyRoutes(dup)) });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    assert.deepStrictEqual(r2.out.validation.duplicates, [4000], 'still surfaced for the consolidated screen');
  });

  await test('parent that is not a User Story exits 2', async () => {
    const dir = proj();
    const f = fakeFetch(happyRoutes([{ match: '/wit/workitems/321', json: { id: 321, fields: { 'System.WorkItemType': 'Task', 'System.Title': 'x' } } }]));
    const { code, out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2);
    assert.match(JSON.stringify(out.blocked), /User Story/);
  });

  await test('no attachments without --no-screenshots blocks; the waiver lets it plan', async () => {
    const dir = proj();
    const r1 = await run(['--spec', writeSpec(dir, { attachments: [] })], { cwd: dir, fetch: fakeFetch(happyRoutes()) });
    assert.strictEqual(r1.code, 2);
    assert.match(JSON.stringify(r1.out.blocked), /screenshot|evidence/i);
    const r2 = await run(['--spec', writeSpec(dir, { attachments: [] }), '--no-screenshots'], { cwd: dir, fetch: fakeFetch(happyRoutes()) });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    assert.deepStrictEqual(r2.out.plan.map((p) => p.step), ['create-bug', 'link-parent', 'set-repro-and-evidence']);
  });

  await test('a structurally invalid attachment blocks without --force', async () => {
    const dir = proj();
    const bad = path.join(dir, 'broken.png');
    fs.writeFileSync(bad, Buffer.alloc(5000)); // no PNG/JPEG magic
    const r1 = await run(['--spec', writeSpec(dir, { attachments: [bad] })], { cwd: dir, fetch: fakeFetch(happyRoutes()) });
    assert.strictEqual(r1.code, 2);
    assert.match(JSON.stringify(r1.out.blocked), /not-an-image/);
    const r2 = await run(['--spec', writeSpec(dir, { attachments: [bad] }), '--force'], { cwd: dir, fetch: fakeFetch(happyRoutes()) });
    assert.strictEqual(r2.code, 0, 'the deliberate override still plans');
  });

  await test('--execute happy path writes in D-5 order: attachments -> create -> link -> repro patch', async () => {
    const dir = proj();
    const f = fakeFetch(happyRoutes());
    const { code, out } = await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.mode, 'executed');
    assert.strictEqual(out.created.bugId, 4711);
    assert.ok(out.created.url.includes('4711'));
    assert.ok(out.ledger.every((l) => l.status === 'done'));
    const writes = f.calls.filter(isWrite);
    assert.deepStrictEqual(writes.map((c) => c.method), ['POST', 'POST', 'PATCH', 'PATCH']);
    assert.ok(writes[0].url.includes('/attachments'), 'attachments first');
    assert.ok(writes[1].url.includes('/workitems/$Bug'), 'then the create');
    assert.match(writes[2].body, /Hierarchy-Reverse/, 'then the parent link');
    assert.match(writes[3].body, /ReproSteps/, 'then the repro+evidence patch');
    assert.match(writes[3].body, /AttachedFile/, 'evidence relations ride the same patch');
    // validateOnly is NOT re-proven during execute (D-5: proven in the dry run)
    assert.ok(!f.calls.some((c) => c.url.includes('validateOnly=true')));
  });

  await test('failure at the CREATE step: exit 1, exact ledger, nothing after it attempted', async () => {
    const dir = proj();
    const f = fakeFetch(happyRoutes([{ method: 'POST', match: '/workitems/$Bug', status: 500, text: 'boom' }]));
    const { code, out } = await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 1);
    assert.strictEqual(out.ok, false);
    const byStep = Object.fromEntries(out.ledger.map((l) => [l.step, l]));
    assert.strictEqual(byStep['upload-attachment'].status, 'done');
    assert.ok(byStep['upload-attachment'].id, 'uploaded attachment id is in the ledger');
    assert.strictEqual(byStep['create-bug'].status, 'failed');
    assert.strictEqual(byStep['link-parent'].status, 'not-attempted');
    assert.strictEqual(byStep['set-repro-and-evidence'].status, 'not-attempted');
    assert.strictEqual(out.created.bugId, undefined, 'no bug id was ever produced');
  });

  await test('failure at the LINK step: exit 1 and the created Bug ID is STILL in the JSON', async () => {
    const dir = proj();
    const f = fakeFetch(happyRoutes([{ method: 'PATCH', match: '/workitems/4711', bodyMatch: 'Hierarchy-Reverse', status: 403, text: JSON.stringify({ message: 'no link permission' }) }]));
    const { code, out } = await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 1);
    assert.strictEqual(out.ok, false, 'a partial write is never a success');
    assert.strictEqual(out.created.bugId, 4711, 'the orphan is named');
    const byStep = Object.fromEntries(out.ledger.map((l) => [l.step, l]));
    assert.strictEqual(byStep['create-bug'].status, 'done');
    assert.strictEqual(byStep['create-bug'].id, 4711);
    assert.strictEqual(byStep['link-parent'].status, 'failed');
    assert.match(byStep['link-parent'].reason, /no link permission/);
    assert.strictEqual(byStep['set-repro-and-evidence'].status, 'not-attempted');
    // no retry: the failing route was hit exactly once
    assert.strictEqual(f.calls.filter((c) => c.method === 'PATCH' && String(c.body).includes('Hierarchy-Reverse')).length, 1);
  });

  await test('failure at the REPRO PATCH step: exit 1, ledger names it, bug + link already done', async () => {
    const dir = proj();
    const f = fakeFetch(happyRoutes([{ method: 'PATCH', match: '/workitems/4711', bodyMatch: 'ReproSteps', status: 500, text: 'x' }]));
    const { code, out } = await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 1);
    const byStep = Object.fromEntries(out.ledger.map((l) => [l.step, l]));
    assert.strictEqual(byStep['link-parent'].status, 'done');
    assert.strictEqual(byStep['set-repro-and-evidence'].status, 'failed');
    assert.strictEqual(out.created.bugId, 4711);
  });

  await test('stale cache: server rejection despite cache pass -> real allowedValues + cacheStale:true', async () => {
    const dir = proj();
    // cache says QA is fine; the org has since renamed the values, so validateOnly rejects
    const f = fakeFetch([
      { method: 'POST', match: 'validateOnly=true', status: 400, text: JSON.stringify({ message: 'The field Environment has an invalid value QA' }) },
      { match: '/wit/workitems/321', json: PARENT },
      { method: 'POST', match: '/wiql', json: { workItems: [] } },
      // first fields read builds the cache (old values); the LIVE re-fetch answers second
      { match: '/wit/workitemtypes/Bug/fields', json: BUG_FIELDS, times: 1 },
      { match: '/wit/workitemtypes/Bug/fields', json: { value: [{ referenceName: 'Custom.Environment', allowedValues: ['QA-2', 'UAT-2'] }] } },
    ]);
    // make the route table stateful for `times`:
    const original = f.calls;
    let fieldReads = 0;
    const stateful = async (url, opts = {}) => {
      if (String(url).includes('/wit/workitemtypes/Bug/fields')) {
        fieldReads++;
        const json = fieldReads === 1 ? BUG_FIELDS : { value: [{ referenceName: 'Custom.Environment', allowedValues: ['QA-2', 'UAT-2'] }] };
        original.push({ url: String(url), method: 'GET' });
        return { ok: true, status: 200, text: async () => JSON.stringify(json) };
      }
      return f(url, opts);
    };
    const { code, out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: stateful });
    assert.strictEqual(code, 2);
    assert.strictEqual(out.cacheStale, true);
    const blocked = JSON.stringify(out.blocked);
    assert.match(blocked, /QA-2/, 'the REAL current options are surfaced');
    assert.match(blocked, /invalid value QA/, 'the server message is relayed');
    assert.strictEqual(fieldReads, 2, 'live re-fetch happened exactly once — no auto-retry of the write');
  });

  await test('--refresh-fields forces a cache rebuild', async () => {
    const dir = proj();
    let fieldReads = 0;
    const f = fakeFetch(happyRoutes());
    const counting = async (url, opts) => {
      if (String(url).includes('/fields?')) fieldReads++;
      return f(url, opts);
    };
    await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: counting });
    await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: counting });
    assert.strictEqual(fieldReads, 1, 'second run reads the cache');
    const { out } = await run(['--spec', writeSpec(dir), '--refresh-fields'], { cwd: dir, fetch: counting });
    assert.strictEqual(fieldReads, 2, '--refresh-fields rebuilds');
    assert.strictEqual(out.cache.rebuilt, true);
  });

  await test('sentinel PAT is absent from the JSON out of every mode', async () => {
    const dir = proj();
    const outs = [];
    outs.push(await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: fakeFetch(happyRoutes()) }));
    outs.push(await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: fakeFetch(happyRoutes()) }));
    outs.push(await run(['--spec', writeSpec(dir, { severity: 'nope' })], { cwd: dir, fetch: fakeFetch(happyRoutes()) }));
    const all = JSON.stringify(outs);
    assert.ok(!all.includes(SENTINEL_PAT));
    assert.ok(!all.includes(Buffer.from(':' + SENTINEL_PAT).toString('base64')));
  });

  await test('CLI: exactly one JSON line on stdout, exit 2, sentinel absent (spawned, zero network)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-cb-'));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'create-bug.js')], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, AZURE_PAT: SENTINEL_PAT },
    });
    assert.strictEqual(r.status, 2, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1, `stdout was:\n${r.stdout}`);
    assert.strictEqual(JSON.parse(lines[0]).ok, false);
    assert.ok(!r.stdout.includes(SENTINEL_PAT) && !r.stderr.includes(SENTINEL_PAT));
  });

  await test('no child_process in any delivered bug-skill script (structural source read)', async () => {
    for (const name of ['create-bug.js', 'read-workitem.js']) {
      const src = fs.readFileSync(path.join(__dirname, name), 'utf8');
      assert.ok(!/child_process|spawnSync|execSync/.test(src), `${name} must not spawn processes`);
    }
  });

  await test('no process.exit in any delivered bug-skill script (structural source read)', async () => {
    // Force-exiting after fetch trips a libuv assertion on Windows/Node 24 and can
    // corrupt the exit code; print, set process.exitCode, and let the loop drain
    // (the run_api.js doctrine).
    for (const name of ['create-bug.js', 'read-workitem.js']) {
      const src = fs.readFileSync(path.join(__dirname, name), 'utf8');
      assert.ok(!src.includes('process.exit('), `${name} must not force-exit`);
    }
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
