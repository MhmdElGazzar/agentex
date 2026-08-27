'use strict';
// Self-contained tests for create-cases.js — the test-design flow's mechanics:
// story read, the Steps-XML builder, fail-closed dry-run validation, and the
// one-atomic-create-per-case write phase (Tested By inline), all through the
// tracker lib with an INJECTED fake fetch. Offline: no network, no ADO org,
// no az CLI. One spawned run proves the one-JSON-line CLI contract.
// Run: node skills/test-design/scripts/create-cases.test.js
//
// Coverage per the Phase-2 design's assertion table:
//   story          : happy / not-found / wrong-type; read-only
//   XML builder    : PINNED ID scheme (2,3,4… + last attr), ActionStep's second
//                    parameterizedString empty, ValidateStep text+expected,
//                    &<> escaped; the XML travels inside the JSON body
//   dry run        : dup-title blocks without --allow-duplicate; dup check
//                    FAILS CLOSED; duplicate titles WITHIN the spec block;
//                    story-type check; iteration/area inherited fresh from the
//                    story; cache types:['Test Case'] additive merge +
//                    --refresh-fields; validateOnly probe exactly once
//   execute        : one atomic create per case with the inline
//                    TestedBy-Reverse relation targeting the story; mid-plan
//                    failure -> exit 1 + partial ledger with created case IDs
//   safety         : sentinel PAT in zero bytes of output, one JSON line,
//                    no child_process in the delivered script
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run, buildStepsXml, TESTED_BY_LINK } = require('./create-cases.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const SENTINEL_PAT = 'SENTINEL-PAT-createcases-00112233445566778899';
for (const n of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'AZURE_URL', 'AZURE_PROJECT', 'AZURE_TEAM', 'AZURE_ASSIGNEE']) delete process.env[n];

let specSeq = 0;
function proj({ azure = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-cc-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
    azure: {
      org: 'exampleorg', project: 'Sample Project',
      assignee: 'qa.engineer@example.com', ...azure,
    },
  }));
  fs.writeFileSync(path.join(dir, '.env'), `AZURE_PAT=${SENTINEL_PAT}\n`);
  return dir;
}

const CASES = [
  {
    title: 'SME User || Step5 || user checks the page UI',
    steps: [
      { type: 'action', text: 'Open the design for reference: https://figma.example.com/f/1' },
      { type: 'action', text: 'Given the customer lands on the homepage and completes Steps 1-4' },
      { type: 'validate', text: 'user checks the stepper, header and content', expected: 'matches the design' },
    ],
  },
  {
    title: 'SME User || Step5 || user checks the page text',
    steps: [
      { type: 'action', text: 'Given the customer lands on the Step5 page' },
      { type: 'validate', text: 'user checks every label in EN', expected: 'labels match the copy table' },
      { type: 'validate', text: 'user checks every label in AR', expected: 'labels match the copy table' },
    ],
  },
];

function writeSpec(dir, overrides = {}) {
  const spec = {
    storyId: 210,
    assignee: 'qa.engineer@example.com',
    // Decoys that MUST be ignored — iteration/area always come from the story.
    iterationPath: 'WRONG\\FromSpec', areaPath: 'WRONG\\FromSpec',
    cases: CASES,
    ...overrides,
  };
  const file = path.join(dir, `spec-${++specSeq}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  return file;
}

const STORY_210 = {
  id: 210,
  fields: {
    'System.WorkItemType': 'User Story',
    'System.Title': 'Capture contact preferences',
    'System.State': 'Active',
    'System.IterationPath': 'Sample Project\\Sprint 9',
    'System.AreaPath': 'Sample Project\\Team Area',
    'System.Description': '<div>desc with <a href="https://figma.example.com/f/1">design</a></div>',
    'Microsoft.VSTS.Common.AcceptanceCriteria': '<div>ACs</div>',
  },
  relations: [{ rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/exampleorg/_apis/wit/workItems/555' }],
};

const TC_FIELDS = {
  value: [
    { referenceName: 'System.Title', alwaysRequired: true },
    { referenceName: 'System.AreaPath' }, { referenceName: 'System.IterationPath' },
    { referenceName: 'System.AssignedTo' },
    { referenceName: 'Microsoft.VSTS.TCM.Steps' },
  ],
};

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
      const json = typeof r.json === 'function' ? r.json(call) : r.json;
      return { ok: status < 300, status, text: async () => (r.text !== undefined ? r.text : JSON.stringify(json || {})) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

function routes(extra = []) {
  let created = 7000;
  return [
    ...extra,
    { match: '/wit/workitems/210?', json: STORY_210 },
    { method: 'POST', match: '/wiql', json: { workItems: [] } },
    { match: '/wit/workitemtypes/Test%20Case/fields', json: TC_FIELDS },
    { method: 'POST', match: 'validateOnly=true', json: {} },
    { method: 'POST', match: '/workitems/$Test%20Case', json: () => ({ id: ++created }) },
  ];
}

const isWrite = (c) => c.method !== 'GET' && !(c.method === 'POST' && c.url.includes('/wiql')) && !c.url.includes('validateOnly=true');

(async () => {
  // ── pinned constants ────────────────────────────────────────────────────────
  await test('PINNED: the Tested-By relation on the TC create is Microsoft.VSTS.Common.TestedBy-Reverse', async () => {
    assert.strictEqual(TESTED_BY_LINK, 'Microsoft.VSTS.Common.TestedBy-Reverse');
  });

  await test('PINNED: Steps XML — container id 0, step IDs 2,3,4…, last = highest ID', async () => {
    const xml = buildStepsXml([
      { type: 'action', text: 'Open the page' },
      { type: 'validate', text: 'check the title', expected: 'title shown' },
      { type: 'validate', text: 'check the footer', expected: 'footer shown' },
    ]);
    assert.strictEqual(xml,
      '<steps id="0" last="4">' +
      '<step id="2" type="ActionStep"><parameterizedString isformatted="true">Open the page</parameterizedString><parameterizedString isformatted="true"/></step>' +
      '<step id="3" type="ValidateStep"><parameterizedString isformatted="true">check the title</parameterizedString><parameterizedString isformatted="true">title shown</parameterizedString></step>' +
      '<step id="4" type="ValidateStep"><parameterizedString isformatted="true">check the footer</parameterizedString><parameterizedString isformatted="true">footer shown</parameterizedString></step>' +
      '</steps>');
  });

  await test('XML builder escapes & < > in step text and expected result', async () => {
    const xml = buildStepsXml([{ type: 'validate', text: 'a & b < c', expected: 'x > y & z' }]);
    assert.ok(xml.includes('a &amp; b &lt; c'), xml);
    assert.ok(xml.includes('x &gt; y &amp; z'), xml);
    assert.ok(!/[&][^agl]/.test(xml.replace(/&(amp|lt|gt);/g, '')), 'no raw reserved chars survive');
  });

  // ── story (read-only) ───────────────────────────────────────────────────────
  await test('story --id: happy path returns the analysis facts (HTML included) and stays read-only', async () => {
    const dir = proj();
    const f = fakeFetch(routes());
    const { code, out } = await run(['story', '--id', '210'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.story.id, 210);
    assert.strictEqual(out.story.type, 'User Story');
    assert.strictEqual(out.story.title, 'Capture contact preferences');
    assert.strictEqual(out.story.iterationPath, 'Sample Project\\Sprint 9');
    assert.match(out.story.description, /figma.example.com/);
    assert.match(out.story.acceptanceCriteria, /ACs/);
    assert.ok(Array.isArray(out.story.relations));
    assert.ok(out.story.url.includes('/_workitems/edit/210'));
    assert.ok(f.calls.every((c) => c.method === 'GET'), 'story is read-only');
  });

  await test('story --id: not-found exits 1; a non-User-Story id exits 1 naming the type', async () => {
    const dir = proj();
    const r1 = await run(['story', '--id', '210'], { cwd: dir, fetch: fakeFetch([{ match: '/wit/workitems/210?', status: 404, text: JSON.stringify({ message: 'not found' }) }]) });
    assert.strictEqual(r1.code, 1);
    const r2 = await run(['story', '--id', '210'], { cwd: dir, fetch: fakeFetch([{ match: '/wit/workitems/210?', json: { id: 210, fields: { 'System.WorkItemType': 'Bug', 'System.Title': 'x' } } }]) });
    assert.strictEqual(r2.code, 1);
    assert.match(r2.out.error.message, /"Bug", not a User Story/);
  });

  // ── dry run (default) ───────────────────────────────────────────────────────
  await test('dry run: valid spec -> exit 0, one atomic create per case, Steps XML + TestedBy-Reverse inline, story paths not spec paths', async () => {
    const dir = proj();
    const f = fakeFetch(routes());
    const { code, out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.mode, 'plan');
    assert.strictEqual(out.plan.length, 2, 'one create per case — the link is inline, not a second step');
    for (const p of out.plan) {
      assert.strictEqual(p.step, 'create-test-case');
      assert.ok(p.request.method === 'POST' && p.request.url.includes('/workitems/$Test%20Case'));
      const body = JSON.stringify(p.request.body);
      assert.match(body, /Microsoft.VSTS.Common.TestedBy-Reverse/, 'Tested By rides the create (atomic)');
      assert.ok(body.includes('workItems/210'), 'the relation targets the story');
      assert.ok(body.includes('Sample Project\\\\Sprint 9'), 'iteration inherited fresh from the story');
      assert.ok(body.includes('Sample Project\\\\Team Area'), 'area inherited fresh from the story');
      assert.ok(!body.includes('WRONG'), 'spec-supplied paths are never trusted');
    }
    assert.strictEqual(out.validation.story.type, 'User Story');
    assert.strictEqual(out.validation.validateOnly, 'passed');
    assert.strictEqual(f.calls.filter(isWrite).length, 0, 'dry run must write nothing');
    assert.strictEqual(f.calls.filter((c) => c.url.includes('validateOnly=true')).length, 1, 'exactly ONE representative validateOnly probe');
  });

  await test('the Steps XML travels INSIDE the JSON request body — no file, no shell', async () => {
    const dir = proj();
    const { out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: fakeFetch(routes()) });
    const body = out.plan[0].request.body;
    const stepsOp = body.find((op) => op.path === '/fields/Microsoft.VSTS.TCM.Steps');
    assert.ok(stepsOp, JSON.stringify(body));
    assert.match(String(stepsOp.value), /^<steps id="0" last="4">/);
  });

  await test('duplicate board title blocks without --allow-duplicate and passes with it', async () => {
    const dir = proj();
    const dup = [{ method: 'POST', match: '/wiql', bodyMatch: 'user checks the page UI', json: { workItems: [{ id: 4000 }] } }];
    const r1 = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: fakeFetch(routes(dup)) });
    assert.strictEqual(r1.code, 2);
    const bad = r1.out.blocked.find((b) => b.reason === 'duplicate-title');
    assert.deepStrictEqual(bad.ids, [4000]);
    const r2 = await run(['--spec', writeSpec(dir), '--allow-duplicate'], { cwd: dir, fetch: fakeFetch(routes(dup)) });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
  });

  await test('DUP CHECK FAILS CLOSED: a WIQL server error exits 2 with zero writes', async () => {
    const dir = proj();
    const f = fakeFetch(routes([{ method: 'POST', match: '/wiql', status: 500, text: 'internal error' }]));
    const { code, out } = await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2);
    assert.match(JSON.stringify(out.blocked), /dup-check-failed/);
    assert.strictEqual(f.calls.filter(isWrite).length, 0, 'a failed dup check must block, never proceed');
  });

  await test('duplicate titles WITHIN the spec block (exit 2)', async () => {
    const dir = proj();
    const spec = writeSpec(dir, { cases: [CASES[0], { ...CASES[1], title: CASES[0].title }] });
    const { code, out } = await run(['--spec', spec], { cwd: dir, fetch: fakeFetch(routes()) });
    assert.strictEqual(code, 2);
    assert.match(JSON.stringify(out.blocked), /duplicate-title-in-spec/);
  });

  await test('storyId that is not a User Story blocks; an unreadable story blocks (fail closed)', async () => {
    const dir = proj();
    const r1 = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: fakeFetch(routes([{ match: '/wit/workitems/210?', json: { id: 210, fields: { 'System.WorkItemType': 'Task' } } }])) });
    assert.strictEqual(r1.code, 2);
    assert.match(JSON.stringify(r1.out.blocked), /story-not-a-user-story/);
    const r2 = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: fakeFetch(routes([{ match: '/wit/workitems/210?', status: 404, text: '{}' }])) });
    assert.strictEqual(r2.code, 2);
    assert.match(JSON.stringify(r2.out.blocked), /story-not-found/);
  });

  await test('bad steps block: empty steps array, a step without text, a validate step without expected', async () => {
    const dir = proj();
    const spec = writeSpec(dir, {
      cases: [
        { title: 'A || B || no steps', steps: [] },
        { title: 'A || B || no text', steps: [{ type: 'action', text: '' }] },
        { title: 'A || B || no expected', steps: [{ type: 'validate', text: 'check it' }] },
      ],
    });
    const { code, out } = await run(['--spec', spec], { cwd: dir, fetch: fakeFetch(routes()) });
    assert.strictEqual(code, 2);
    const blocked = JSON.stringify(out.blocked);
    assert.match(blocked, /no steps/);
    assert.match(blocked, /no text/);
    assert.match(blocked, /no expected/);
  });

  await test('cache is built with types:[Test Case] and merges ADDITIVELY next to a pre-seeded Bug type', async () => {
    const dir = proj();
    const cacheFile = path.join(dir, '.agentex', 'cache', 'tracker-fields-ado.json');
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      schemaVersion: 1, provider: 'ado', org: 'https://dev.azure.com/exampleorg', project: 'Sample Project',
      apiVersion: '7.1', builtAt: '2026-08-25T09:00:00Z',
      types: { Bug: { fields: { 'System.Title': { required: true } } } },
    }));
    let tcFieldReads = 0;
    const base = fakeFetch(routes());
    const counting = async (url, opts) => {
      if (String(url).includes('/wit/workitemtypes/Test%20Case/fields')) tcFieldReads++;
      return base(url, opts);
    };
    const { code } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: counting });
    assert.strictEqual(code, 0);
    assert.strictEqual(tcFieldReads, 1, 'listFields called for Test Case exactly once');
    const disk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.ok(disk.types.Bug, 'the pre-seeded Bug type survived the merge');
    assert.ok(disk.types['Test Case'], 'the Test Case type was added');
  });

  await test('--refresh-fields forces a cache rebuild', async () => {
    const dir = proj();
    let fieldReads = 0;
    const base = fakeFetch(routes());
    const counting = async (url, opts) => {
      if (String(url).includes('/fields?')) fieldReads++;
      return base(url, opts);
    };
    await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: counting });
    await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: counting });
    assert.strictEqual(fieldReads, 1, 'second run reads the cache');
    const { out } = await run(['--spec', writeSpec(dir), '--refresh-fields'], { cwd: dir, fetch: counting });
    assert.strictEqual(fieldReads, 2, '--refresh-fields rebuilds');
    assert.strictEqual(out.cache.rebuilt, true);
  });

  await test('Steps field missing from the project\'s Test Case type blocks (never emitted blind)', async () => {
    const dir = proj();
    const noSteps = { value: TC_FIELDS.value.filter((f) => f.referenceName !== 'Microsoft.VSTS.TCM.Steps') };
    const f = fakeFetch(routes([{ match: '/wit/workitemtypes/Test%20Case/fields', json: noSteps }]));
    const { code, out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2);
    const bad = out.blocked.find((b) => b.reason === 'field-not-on-type');
    assert.strictEqual(bad.field, 'Microsoft.VSTS.TCM.Steps');
  });

  await test('stale cache: server rejection despite a cache pass -> cacheStale:true, no retry', async () => {
    const dir = proj();
    let fieldReads = 0;
    const base = fakeFetch(routes([{ method: 'POST', match: 'validateOnly=true', status: 400, text: JSON.stringify({ message: 'The field AssignedTo has an invalid value' }) }]));
    const stateful = async (url, opts = {}) => {
      if (String(url).includes('/wit/workitemtypes/Test%20Case/fields')) {
        fieldReads++;
        return { ok: true, status: 200, text: async () => JSON.stringify(TC_FIELDS) };
      }
      return base(url, opts);
    };
    const { code, out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: stateful });
    assert.strictEqual(code, 2);
    assert.match(JSON.stringify(out.blocked), /server-rejected-create/);
    assert.match(JSON.stringify(out.blocked), /invalid value/);
    assert.strictEqual(fieldReads, 2, 'one live re-fetch, no auto-retry of the write');
  });

  // ── execute ─────────────────────────────────────────────────────────────────
  await test('--execute: one atomic create per case, ledger all done, ids+urls surfaced', async () => {
    const dir = proj();
    const f = fakeFetch(routes());
    const { code, out } = await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.mode, 'executed');
    assert.strictEqual(out.ledger.length, 2);
    assert.ok(out.ledger.every((l) => l.status === 'done' && l.id && l.url));
    const writes = f.calls.filter(isWrite);
    assert.strictEqual(writes.length, 2, 'exactly one write per case — no separate link write');
    for (const w of writes) {
      assert.match(w.body, /TestedBy-Reverse/, 'the Tested-By relation rides the create');
      assert.ok(w.body.includes('workItems/210'));
      assert.match(w.body, /Microsoft.VSTS.TCM.Steps/);
    }
    assert.deepStrictEqual(out.created.testCases.map((t) => t.id), [7001, 7002]);
    assert.ok(!f.calls.some((c) => c.url.includes('validateOnly=true')), 'the probe is dry-run only');
  });

  await test('--execute failure at case 2: exit 1, case 1 done with id, case 2 failed, created IDs in the JSON, no retry', async () => {
    const dir = proj();
    let creates = 0;
    const base = fakeFetch(routes());
    const failing = async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'POST' && String(url).includes('/workitems/$Test%20Case') && !String(url).includes('validateOnly=true')) {
        creates++;
        base.calls.push({ url: String(url), method: 'POST', body: opts.body });
        if (creates === 2) return { ok: false, status: 503, text: async () => JSON.stringify({ message: 'busy' }) };
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 7000 + creates }) };
      }
      return base(url, opts);
    };
    const { code, out } = await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: failing });
    assert.strictEqual(code, 1);
    assert.strictEqual(out.ok, false, 'a partial write is never a success');
    assert.strictEqual(out.ledger[0].status, 'done');
    assert.strictEqual(out.ledger[0].id, 7001);
    assert.strictEqual(out.ledger[1].status, 'failed');
    assert.match(out.ledger[1].reason, /busy/);
    assert.deepStrictEqual(out.created.testCases.map((t) => t.id), [7001], 'created IDs always in the JSON');
    assert.strictEqual(creates, 2, 'nothing retried');
  });

  // ── safety ──────────────────────────────────────────────────────────────────
  await test('a malformed spec (no storyId / empty cases) blocks before any read', async () => {
    const dir = proj();
    const f = fakeFetch(routes());
    const r1 = await run(['--spec', writeSpec(dir, { storyId: undefined })], { cwd: dir, fetch: f });
    assert.strictEqual(r1.code, 2);
    const r2 = await run(['--spec', writeSpec(dir, { cases: [] })], { cwd: dir, fetch: f });
    assert.strictEqual(r2.code, 2);
    assert.strictEqual(f.calls.length, 0, 'blocked before any request');
  });

  await test('sentinel PAT is absent from the JSON out of every mode', async () => {
    const dir = proj();
    const outs = [];
    outs.push(await run(['story', '--id', '210'], { cwd: dir, fetch: fakeFetch(routes()) }));
    outs.push(await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: fakeFetch(routes()) }));
    outs.push(await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: fakeFetch(routes()) }));
    const all = JSON.stringify(outs);
    assert.ok(!all.includes(SENTINEL_PAT));
    assert.ok(!all.includes(Buffer.from(':' + SENTINEL_PAT).toString('base64')));
  });

  await test('CLI: exactly one JSON line on stdout, exit 2, sentinel absent (spawned, zero network)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-cc-'));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'create-cases.js')], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, AZURE_PAT: SENTINEL_PAT },
    });
    assert.strictEqual(r.status, 2, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1, `stdout was:\n${r.stdout}`);
    assert.strictEqual(JSON.parse(lines[0]).ok, false);
    assert.ok(!r.stdout.includes(SENTINEL_PAT) && !r.stderr.includes(SENTINEL_PAT));
  });

  await test('no child_process in the delivered test-design scripts (structural source read)', async () => {
    for (const name of ['create-cases.js', 'testplan.js']) {
      const src = fs.readFileSync(path.join(__dirname, name), 'utf8');
      assert.ok(!/child_process|spawnSync|execSync/.test(src), `${name} must not spawn processes`);
    }
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
