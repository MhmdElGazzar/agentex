'use strict';
// Self-contained tests for create-tasks.js — the task-estimation flow's
// mechanics: sprint/story reads, fail-closed dry-run validation, and the
// one-atomic-create-per-task write phase, all through the tracker lib with an
// INJECTED fake fetch. Offline: no network, no ADO org, no az CLI. One spawned
// run proves the one-JSON-line CLI contract.
// Run: node skills/task-estimation/scripts/create-tasks.test.js
//
// Coverage per the Phase-2 design's assertion table:
//   stories        : WIQL carries @CurrentIteration('[<project>]\<team>') with
//                    escaped names; missing team -> exit 2 naming the keys;
//                    --ids skips WIQL; existing [Testing] children detected;
//                    read-only by construction (zero write calls, ever)
//   dry run        : plan JSON with N×5 creates, parent relation inline,
//                    iteration/area from the STORY (never the spec); title/
//                    estimate/assignee structural blocks; story-type check;
//                    existing-children block + --allow-existing; children-check
//                    FAILS CLOSED; Activity vs cache + allowedValues; cache
//                    types:['Task'] additive merge; --refresh-fields;
//                    validateOnly probe exactly once, dry run only
//   execute        : creates in story order; failure at task k -> exit 1 with
//                    exact ledger (1..k-1 done with ids+urls, k failed, rest
//                    not-attempted), created IDs in the JSON, no retry
//   safety         : sentinel PAT in zero bytes of output, one JSON line,
//                    no child_process or process.exit in the delivered script
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run, currentIterationWiql, currentSprintJql, PARENT_LINK } = require('./create-tasks.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const SENTINEL_PAT = 'SENTINEL-PAT-createtasks-00112233445566778899';
for (const n of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'AZURE_URL', 'AZURE_PROJECT', 'AZURE_TEAM', 'AZURE_ASSIGNEE']) delete process.env[n];

let specSeq = 0;
function proj({ azure = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ct-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
    azure: {
      org: 'exampleorg', project: 'Sample Project', team: 'Sample Team',
      assignee: 'qa.engineer@example.com', ...azure,
    },
  }));
  fs.writeFileSync(path.join(dir, '.env'), `AZURE_PAT=${SENTINEL_PAT}\n`);
  return dir;
}

const FIVE_TASKS = [
  { title: '[Testing] Requirement Review', estimate: 1 },
  { title: '[Testing] Test Creation', estimate: 1 },
  { title: '[Testing] Test Execution', estimate: 1 },
  { title: '[Testing] Bug Review and Retest', estimate: 1 },
  { title: '[Testing] Automation', estimate: 1 },
];

function writeSpec(dir, overrides = {}) {
  const spec = {
    assignee: 'qa.engineer@example.com',
    stories: [
      // Decoy iteration/area in the spec MUST be ignored — always re-read from the story.
      { id: 101, complexity: 'Simple', iterationPath: 'WRONG\\FromSpec', areaPath: 'WRONG\\FromSpec', tasks: FIVE_TASKS },
      { id: 103, complexity: 'Medium', tasks: FIVE_TASKS },
    ],
    ...overrides,
  };
  const file = path.join(dir, `spec-${++specSeq}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  return file;
}

const STORY = (id, extra = {}, fields = {}) => ({
  id,
  fields: {
    'System.WorkItemType': 'User Story',
    'System.Title': `Story ${id}`,
    'System.State': 'Active',
    'Microsoft.VSTS.Scheduling.StoryPoints': 3,
    'System.IterationPath': 'Sample Project\\Sprint 9',
    'System.AreaPath': 'Sample Project\\Team Area',
    'System.Description': '<div>desc</div>',
    'Microsoft.VSTS.Common.AcceptanceCriteria': '<div>ACs</div>',
    ...fields,
  },
  ...extra,
});
const STORY_101 = STORY(101);
const STORY_102 = STORY(102, {
  relations: [
    { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/exampleorg/_apis/wit/workItems/555' },
    { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/exampleorg/_apis/wit/workItems/556' },
    { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/exampleorg/_apis/wit/workItems/9' },
  ],
});
const STORY_103 = STORY(103);
const CHILD_555 = { id: 555, fields: { 'System.WorkItemType': 'Task', 'System.Title': '[Testing] Test Execution', 'System.State': 'Active' } };
const CHILD_556 = { id: 556, fields: { 'System.WorkItemType': 'Task', 'System.Title': 'Implement the API', 'System.State': 'Active' } };

const TASK_FIELDS = {
  value: [
    { referenceName: 'System.Title', alwaysRequired: true },
    { referenceName: 'System.AreaPath' }, { referenceName: 'System.IterationPath' },
    { referenceName: 'System.AssignedTo' },
    { referenceName: 'Microsoft.VSTS.Common.Activity', allowedValues: ['Deployment', 'Design', 'Development', 'Documentation', 'Requirements', 'Testing'] },
    { referenceName: 'Microsoft.VSTS.Scheduling.OriginalEstimate' },
    { referenceName: 'Microsoft.VSTS.Scheduling.RemainingWork' },
  ],
};

// Fake fetch with method + url-substring + optional body-substring matching;
// r.json may be a function of the recorded call (stateful create ids).
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

// Happy route table; prepend entries to inject failures/overrides.
function routes(extra = []) {
  let created = 9000;
  return [
    ...extra,
    { match: '/wit/workitems/101?', json: STORY_101 },
    { match: '/wit/workitems/102?', json: STORY_102 },
    { match: '/wit/workitems/103?', json: STORY_103 },
    { match: '/wit/workitems/555?', json: CHILD_555 },
    { match: '/wit/workitems/556?', json: CHILD_556 },
    { method: 'POST', match: '/wiql', json: { workItems: [{ id: 101 }, { id: 102 }, { id: 103 }] } },
    { match: '/wit/workitemtypes/Task/fields', json: TASK_FIELDS },
    { method: 'POST', match: 'validateOnly=true', json: {} },
    { method: 'POST', match: '/workitems/$Task', json: () => ({ id: ++created }) },
  ];
}

const isWrite = (c) => c.method !== 'GET' && !(c.method === 'POST' && c.url.includes('/wiql')) && !c.url.includes('validateOnly=true');

(async () => {
  // ── pinned constants ────────────────────────────────────────────────────────
  await test('PINNED: parent link is System.LinkTypes.Hierarchy-Reverse on the child', async () => {
    assert.strictEqual(PARENT_LINK, 'System.LinkTypes.Hierarchy-Reverse');
  });

  await test('PINNED: current-sprint WIQL uses @CurrentIteration(\'[<project>]\\<team>\') with \'\' escaping', async () => {
    const wiql = currentIterationWiql("O'Neil Project", "QA 'A' Team");
    assert.ok(wiql.includes("@CurrentIteration('[O''Neil Project]\\QA ''A'' Team')"), wiql);
    assert.ok(wiql.includes("[System.WorkItemType]='User Story'"), wiql);
  });

  // ── stories (read-only) ─────────────────────────────────────────────────────
  await test('stories --current-sprint: WIQL carries the macro with the config team; per-story facts + children', async () => {
    const dir = proj();
    const f = fakeFetch(routes());
    const { code, out } = await run(['stories', '--current-sprint'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.ok, true);
    const wiqlCall = f.calls.find((c) => c.url.includes('/wiql'));
    assert.ok(wiqlCall, 'the WIQL query was sent');
    const wiql = JSON.parse(wiqlCall.body).query;
    assert.ok(wiql.includes("@CurrentIteration('[Sample Project]\\Sample Team')"), wiql);
    assert.strictEqual(out.stories.length, 3);
    const s101 = out.stories.find((s) => s.id === 101);
    assert.strictEqual(s101.title, 'Story 101');
    assert.strictEqual(s101.storyPoints, 3);
    assert.strictEqual(s101.iterationPath, 'Sample Project\\Sprint 9');
    assert.strictEqual(s101.areaPath, 'Sample Project\\Team Area');
    assert.ok(s101.url.includes('/_workitems/edit/101'));
    assert.deepStrictEqual(s101.existingTestingTasks, []);
    assert.strictEqual(s101.description, undefined, 'no --full: HTML stays out');
    const s102 = out.stories.find((s) => s.id === 102);
    assert.strictEqual(s102.existingTestingTasks.length, 1, 'only the [Testing]-titled child counts');
    assert.strictEqual(s102.existingTestingTasks[0].id, 555);
    assert.match(s102.existingTestingTasks[0].title, /^\[Testing\]/);
  });

  await test('stories: --team overrides config and is WIQL-escaped', async () => {
    const dir = proj();
    const f = fakeFetch(routes());
    const { code } = await run(['stories', '--current-sprint', '--team', "QA 'A' Team"], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0);
    const wiqlCall = f.calls.find((c) => c.url.includes('/wiql'));
    const wiql = JSON.parse(wiqlCall.body).query;
    assert.ok(wiql.includes("@CurrentIteration('[Sample Project]\\QA ''A'' Team')"), wiql);
  });

  await test('stories: missing team exits 2 naming --team / azure.team / AZURE_TEAM', async () => {
    const dir = proj({ azure: { team: undefined } });
    const f = fakeFetch(routes());
    const { code, out } = await run(['stories', '--current-sprint'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2, JSON.stringify(out));
    for (const name of ['--team', 'azure.team', 'AZURE_TEAM']) assert.ok(out.error.message.includes(name), name);
    assert.strictEqual(f.calls.length, 0, 'blocked before any request');
  });

  await test('stories --ids skips WIQL and reads exactly the named stories', async () => {
    const dir = proj();
    const f = fakeFetch(routes());
    const { code, out } = await run(['stories', '--ids', '101,103'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0);
    assert.ok(!f.calls.some((c) => c.url.includes('/wiql')), 'no WIQL on the --ids path');
    assert.deepStrictEqual(out.stories.map((s) => s.id), [101, 103]);
  });

  await test('stories --full adds description + acceptanceCriteria (the analysis input)', async () => {
    const dir = proj();
    const { out } = await run(['stories', '--ids', '101', '--full'], { cwd: dir, fetch: fakeFetch(routes()) });
    assert.strictEqual(out.stories[0].description, '<div>desc</div>');
    assert.strictEqual(out.stories[0].acceptanceCriteria, '<div>ACs</div>');
  });

  await test('stories: a non-User-Story id gets a per-story warning (the dry run is the blocking layer)', async () => {
    const dir = proj();
    const f = fakeFetch(routes([{ match: '/wit/workitems/101?', json: { id: 101, fields: { 'System.WorkItemType': 'Bug', 'System.Title': 'x' } } }]));
    const { code, out } = await run(['stories', '--ids', '101'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0);
    assert.match(out.stories[0].warning, /not a User Story/);
  });

  await test('stories is read-only by construction — even with a stray --execute flag', async () => {
    const dir = proj();
    const f = fakeFetch(routes());
    await run(['stories', '--current-sprint', '--execute'], { cwd: dir, fetch: f });
    assert.strictEqual(f.calls.filter(isWrite).length, 0, 'no write route was ever hit');
    assert.ok(f.calls.every((c) => c.method === 'GET' || c.url.includes('/wiql')), 'GETs and the WIQL read only');
  });

  // ── dry run (default) ───────────────────────────────────────────────────────
  await test('dry run: valid spec -> exit 0, N×5 creates with the parent relation inline and iteration/area from the STORY, not the spec', async () => {
    const dir = proj();
    const f = fakeFetch(routes());
    const { code, out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.mode, 'plan');
    assert.strictEqual(out.plan.length, 10, '2 stories × 5 tasks');
    for (const p of out.plan) {
      assert.strictEqual(p.step, 'create-task');
      assert.ok(p.request && p.request.method === 'POST' && p.request.url.includes('/workitems/$Task'), 'each plan step names its route');
      const body = JSON.stringify(p.request.body);
      assert.match(body, /System.LinkTypes.Hierarchy-Reverse/, 'parent link rides the create (atomic)');
      assert.ok(body.includes(`workItems/${p.story}`), 'the relation targets the task\'s own story');
      assert.ok(body.includes('Sample Project\\\\Sprint 9'), 'iteration inherited fresh from the story');
      assert.ok(body.includes('Sample Project\\\\Team Area'), 'area inherited fresh from the story');
      assert.ok(!body.includes('WRONG'), 'spec-supplied paths are never trusted');
      assert.match(body, /"Testing"/);
    }
    assert.deepStrictEqual(out.plan.map((p) => p.story), [101, 101, 101, 101, 101, 103, 103, 103, 103, 103], 'story-ordered');
    assert.strictEqual(out.validation.perStory.length, 2);
    assert.strictEqual(out.validation.perStory[0].type, 'User Story');
    assert.strictEqual(out.validation.assignee, 'qa.engineer@example.com');
    assert.ok(out.cache && out.cache.file.includes('tracker-fields-ado.json'));
    assert.strictEqual(f.calls.filter(isWrite).length, 0, 'dry run must write nothing');
    assert.strictEqual(f.calls.filter((c) => c.url.includes('validateOnly=true')).length, 1, 'exactly ONE representative validateOnly probe');
  });

  await test('a task title without the "[Testing] " prefix blocks (exit 2)', async () => {
    const dir = proj();
    const spec = writeSpec(dir, { stories: [{ id: 101, tasks: [{ title: 'Test Creation', estimate: 1 }] }] });
    const { code, out } = await run(['--spec', spec], { cwd: dir, fetch: fakeFetch(routes()) });
    assert.strictEqual(code, 2);
    assert.match(JSON.stringify(out.blocked), /bad-task-title/);
  });

  await test('a non-numeric or non-positive estimate blocks (exit 2)', async () => {
    const dir = proj();
    const spec = writeSpec(dir, { stories: [{ id: 101, tasks: [{ title: '[Testing] A', estimate: '2h' }, { title: '[Testing] B', estimate: 0 }] }] });
    const { code, out } = await run(['--spec', spec], { cwd: dir, fetch: fakeFetch(routes()) });
    assert.strictEqual(code, 2);
    const blocked = JSON.stringify(out.blocked);
    assert.match(blocked, /bad-estimate/);
    assert.ok(blocked.includes('[Testing] A') && blocked.includes('[Testing] B'), 'every bad task is named at once');
  });

  await test('no assignee anywhere blocks; multiple configured assignees without a spec pick block too (never invented)', async () => {
    const dir1 = proj({ azure: { assignee: undefined } });
    const r1 = await run(['--spec', writeSpec(dir1, { assignee: '' })], { cwd: dir1, fetch: fakeFetch(routes()) });
    assert.strictEqual(r1.code, 2);
    assert.match(JSON.stringify(r1.out.blocked), /missing-assignee/);
    const dir2 = proj({ azure: { assignee: 'a@example.com, b@example.com' } });
    const r2 = await run(['--spec', writeSpec(dir2, { assignee: undefined })], { cwd: dir2, fetch: fakeFetch(routes()) });
    assert.strictEqual(r2.code, 2);
    assert.match(JSON.stringify(r2.out.blocked), /a@example.com/, 'the options are surfaced for the bundled ask');
    // a single configured assignee resolves without a spec value
    const dir3 = proj();
    const r3 = await run(['--spec', writeSpec(dir3, { assignee: undefined })], { cwd: dir3, fetch: fakeFetch(routes()) });
    assert.strictEqual(r3.code, 0, JSON.stringify(r3.out));
    assert.strictEqual(r3.out.validation.assignee, 'qa.engineer@example.com');
  });

  await test('a story that is not a User Story blocks (fail closed)', async () => {
    const dir = proj();
    const f = fakeFetch(routes([{ match: '/wit/workitems/101?', json: { id: 101, fields: { 'System.WorkItemType': 'Bug', 'System.Title': 'x' } } }]));
    const { code, out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2);
    assert.match(JSON.stringify(out.blocked), /story-not-a-user-story/);
  });

  await test('an unreadable story blocks (fail closed)', async () => {
    const dir = proj();
    const f = fakeFetch(routes([{ match: '/wit/workitems/101?', status: 404, text: JSON.stringify({ message: 'not found' }) }]));
    const { code, out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2);
    assert.match(JSON.stringify(out.blocked), /story-not-found/);
  });

  await test('existing [Testing] children block without --allow-existing (ids listed) and pass with it', async () => {
    const dir = proj();
    const spec = writeSpec(dir, { stories: [{ id: 102, tasks: FIVE_TASKS }] });
    const r1 = await run(['--spec', spec], { cwd: dir, fetch: fakeFetch(routes()) });
    assert.strictEqual(r1.code, 2);
    const bad = r1.out.blocked.find((b) => b.reason === 'existing-testing-tasks');
    assert.ok(bad, JSON.stringify(r1.out.blocked));
    assert.deepStrictEqual(bad.ids, [555]);
    const r2 = await run(['--spec', spec, '--allow-existing'], { cwd: dir, fetch: fakeFetch(routes()) });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    assert.strictEqual(r2.out.validation.perStory[0].existingTestingTasks.length, 1, 'still surfaced for the consolidated screen');
  });

  await test('CHILDREN CHECK FAILS CLOSED: an unreadable child blocks the story', async () => {
    const dir = proj();
    const spec = writeSpec(dir, { stories: [{ id: 102, tasks: FIVE_TASKS }] });
    const f = fakeFetch(routes([{ match: '/wit/workitems/555?', status: 500, text: 'boom' }]));
    const { code, out } = await run(['--spec', spec, '--allow-existing'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.match(JSON.stringify(out.blocked), /children-check-failed/);
    assert.strictEqual(f.calls.filter(isWrite).length, 0);
  });

  await test('Activity value invalid vs the project cache blocks WITH allowedValues', async () => {
    const dir = proj();
    const noTesting = { value: TASK_FIELDS.value.map((f) => (f.referenceName === 'Microsoft.VSTS.Common.Activity' ? { ...f, allowedValues: ['Development', 'Design'] } : f)) };
    const f = fakeFetch(routes([{ match: '/wit/workitemtypes/Task/fields', json: noTesting }]));
    const { code, out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2);
    const bad = out.blocked.find((b) => b.field === 'Microsoft.VSTS.Common.Activity');
    assert.ok(bad, JSON.stringify(out.blocked));
    assert.deepStrictEqual(bad.allowedValues, ['Development', 'Design']);
  });

  await test('a field missing from the project\'s Task type blocks (never emitted blind)', async () => {
    const dir = proj();
    const noEstimate = { value: TASK_FIELDS.value.filter((f) => f.referenceName !== 'Microsoft.VSTS.Scheduling.OriginalEstimate') };
    const f = fakeFetch(routes([{ match: '/wit/workitemtypes/Task/fields', json: noEstimate }]));
    const { code, out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2);
    const bad = out.blocked.find((b) => b.reason === 'field-not-on-type');
    assert.strictEqual(bad.field, 'Microsoft.VSTS.Scheduling.OriginalEstimate');
  });

  await test('cache is built with types:[Task] and merges ADDITIVELY next to a pre-seeded Bug type', async () => {
    const dir = proj();
    const cacheFile = path.join(dir, '.agentex', 'cache', 'tracker-fields-ado.json');
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      schemaVersion: 1, provider: 'ado', org: 'https://dev.azure.com/exampleorg', project: 'Sample Project',
      apiVersion: '7.1', builtAt: '2026-08-25T09:00:00Z',
      types: { Bug: { fields: { 'System.Title': { required: true } } } },
    }));
    let taskFieldReads = 0;
    const base = fakeFetch(routes());
    const counting = async (url, opts) => {
      if (String(url).includes('/wit/workitemtypes/Task/fields')) taskFieldReads++;
      if (String(url).includes('/wit/workitemtypes/Bug/fields')) throw new Error('the Bug type must come from the cache, not a re-fetch');
      return base(url, opts);
    };
    const { code } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: counting });
    assert.strictEqual(code, 0);
    assert.strictEqual(taskFieldReads, 1, 'listFields called for Task exactly once');
    const disk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.ok(disk.types.Bug, 'the pre-seeded Bug type survived the merge');
    assert.ok(disk.types.Task, 'the Task type was added');
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

  await test('stale cache: server rejection despite a cache pass -> live allowedValues + cacheStale:true, no retry', async () => {
    const dir = proj();
    let fieldReads = 0;
    const base = fakeFetch(routes([{ method: 'POST', match: 'validateOnly=true', status: 400, text: JSON.stringify({ message: 'The field Activity has an invalid value Testing' }) }]));
    const stateful = async (url, opts = {}) => {
      if (String(url).includes('/wit/workitemtypes/Task/fields')) {
        fieldReads++;
        const json = fieldReads === 1 ? TASK_FIELDS : { value: [{ referenceName: 'Microsoft.VSTS.Common.Activity', allowedValues: ['QA-Verification'] }] };
        base.calls.push({ url: String(url), method: 'GET' });
        return { ok: true, status: 200, text: async () => JSON.stringify(json) };
      }
      return base(url, opts);
    };
    const { code, out } = await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: stateful });
    assert.strictEqual(code, 2);
    assert.strictEqual(out.cacheStale, true);
    const blocked = JSON.stringify(out.blocked);
    assert.match(blocked, /QA-Verification/, 'the REAL current options are surfaced');
    assert.match(blocked, /invalid value Testing/, 'the server message is relayed');
    assert.strictEqual(fieldReads, 2, 'one live re-fetch, no auto-retry of the write');
  });

  // ── execute ─────────────────────────────────────────────────────────────────
  await test('--execute: one atomic create per task, in story order, ledger all done, ids+urls surfaced', async () => {
    const dir = proj();
    const f = fakeFetch(routes());
    const { code, out } = await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.mode, 'executed');
    assert.strictEqual(out.ledger.length, 10);
    assert.ok(out.ledger.every((l) => l.status === 'done' && l.id && l.url));
    const writes = f.calls.filter(isWrite);
    assert.strictEqual(writes.length, 10, 'exactly one write per task — the parent link is inline, not a second write');
    assert.ok(writes.every((c) => c.method === 'POST' && c.url.includes('/workitems/$Task')));
    const storyOrder = writes.map((c) => (c.body.includes('workItems/101') ? 101 : 103));
    assert.deepStrictEqual(storyOrder, [101, 101, 101, 101, 101, 103, 103, 103, 103, 103], 'story-ordered creates');
    assert.strictEqual(out.created.tasks.length, 10);
    assert.ok(out.created.tasks.every((t) => t.id && t.url && t.storyId && t.title));
    assert.ok(!f.calls.some((c) => c.url.includes('validateOnly=true')), 'the probe is dry-run only');
  });

  await test('--execute failure at task 3: exit 1, tasks 1-2 done with ids, 3 failed, rest not-attempted, no retry', async () => {
    const dir = proj();
    let creates = 0;
    const base = fakeFetch(routes());
    const failing = async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'POST' && String(url).includes('/workitems/$Task') && !String(url).includes('validateOnly=true')) {
        creates++;
        base.calls.push({ url: String(url), method: 'POST', body: opts.body });
        if (creates === 3) return { ok: false, status: 500, text: async () => JSON.stringify({ message: 'server exploded' }) };
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 9000 + creates }) };
      }
      return base(url, opts);
    };
    const { code, out } = await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: failing });
    assert.strictEqual(code, 1);
    assert.strictEqual(out.ok, false, 'a partial write is never a success');
    assert.strictEqual(out.ledger.filter((l) => l.status === 'done').length, 2);
    assert.ok(out.ledger.slice(0, 2).every((l) => l.id && l.url), 'created ids+urls are in the ledger');
    assert.strictEqual(out.ledger[2].status, 'failed');
    assert.match(out.ledger[2].reason, /server exploded/);
    assert.strictEqual(out.ledger.filter((l) => l.status === 'not-attempted').length, 7);
    assert.deepStrictEqual(out.created.tasks.map((t) => t.id), [9001, 9002], 'created IDs always in the JSON');
    assert.strictEqual(creates, 3, 'nothing after the failure was attempted, nothing retried');
  });

  await test('--execute refuses before any write when validation blocks (exit 2)', async () => {
    const dir = proj();
    const spec = writeSpec(dir, { stories: [{ id: 102, tasks: FIVE_TASKS }] });
    const f = fakeFetch(routes());
    const { code } = await run(['--spec', spec, '--execute'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2);
    assert.strictEqual(f.calls.filter(isWrite).length, 0, 'refused before any write');
  });

  // ── safety ──────────────────────────────────────────────────────────────────
  await test('a malformed spec (no stories / empty tasks) blocks before any read', async () => {
    const dir = proj();
    const f = fakeFetch(routes());
    const r1 = await run(['--spec', writeSpec(dir, { stories: [] })], { cwd: dir, fetch: f });
    assert.strictEqual(r1.code, 2);
    const r2 = await run(['--spec', writeSpec(dir, { stories: [{ id: 101, tasks: [] }] })], { cwd: dir, fetch: f });
    assert.strictEqual(r2.code, 2);
    assert.strictEqual(f.calls.length, 0, 'blocked before any request');
  });

  await test('sentinel PAT is absent from the JSON out of every mode', async () => {
    const dir = proj();
    const outs = [];
    outs.push(await run(['stories', '--current-sprint'], { cwd: dir, fetch: fakeFetch(routes()) }));
    outs.push(await run(['--spec', writeSpec(dir)], { cwd: dir, fetch: fakeFetch(routes()) }));
    outs.push(await run(['--spec', writeSpec(dir), '--execute'], { cwd: dir, fetch: fakeFetch(routes()) }));
    const all = JSON.stringify(outs);
    assert.ok(!all.includes(SENTINEL_PAT));
    assert.ok(!all.includes(Buffer.from(':' + SENTINEL_PAT).toString('base64')));
  });

  await test('CLI: exactly one JSON line on stdout, exit 2, sentinel absent (spawned, zero network)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ct-'));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'create-tasks.js')], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, AZURE_PAT: SENTINEL_PAT },
    });
    assert.strictEqual(r.status, 2, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1, `stdout was:\n${r.stdout}`);
    assert.strictEqual(JSON.parse(lines[0]).ok, false);
    assert.ok(!r.stdout.includes(SENTINEL_PAT) && !r.stderr.includes(SENTINEL_PAT));
  });

  await test('no child_process in the delivered task-estimation script (structural source read)', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'create-tasks.js'), 'utf8');
    assert.ok(!/child_process|spawnSync|execSync/.test(src), 'create-tasks.js must not spawn processes');
  });

  await test('no process.exit in the delivered task-estimation script (structural source read)', async () => {
    // Force-exiting after fetch trips a libuv assertion on Windows/Node 24 and can
    // corrupt the exit code; print, set process.exitCode, and let the loop drain
    // (the run_api.js doctrine).
    const src = fs.readFileSync(path.join(__dirname, 'create-tasks.js'), 'utf8');
    assert.ok(!src.includes('process.exit('), 'create-tasks.js must not force-exit');
  });

  // ════ Jira strategy (design §5.6) — the ADO suite above is untouched ══════
  const SENTINEL_JT = 'SENTINEL-JIRA-TOKEN-ct-22334455';
  for (const n of ['JIRA_EMAIL', 'JIRA_API_TOKEN']) delete process.env[n];

  function jproj({ jira = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ct-'));
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
      jira: { site: 'example', project: 'PROJ', assignee: 'qa.engineer@example.com', ...jira },
    }));
    fs.writeFileSync(path.join(dir, '.env'), `JIRA_EMAIL=qa.engineer@example.com\nJIRA_API_TOKEN=${SENTINEL_JT}\n`);
    return dir;
  }

  const ALL_FIELDS = [
    { id: 'customfield_10016', name: 'Story Points' },
    { id: 'customfield_10020', name: 'Sprint' },
  ];
  const J_ISSUE_TYPES = { issueTypes: [
    { id: '10001', name: 'Story', subtask: false },
    { id: '10002', name: 'Sub-task', subtask: true },
    { id: '10003', name: 'Bug', subtask: false },
  ] };
  const SUBTASK_META = { total: 5, fields: [
    { fieldId: 'summary', name: 'Summary', required: true },
    { fieldId: 'timetracking', name: 'Time tracking', required: false },
    { fieldId: 'labels', name: 'Labels', required: false },
    { fieldId: 'assignee', name: 'Assignee', required: false },
    { fieldId: 'parent', name: 'Parent', required: false },
  ] };
  const J_USER = { accountId: 'acc-123', emailAddress: 'qa.engineer@example.com', displayName: 'QA Engineer' };
  const JSTORY = (key, { sprints, subtasks = [], type = 'Story' } = {}) => ({
    key,
    fields: {
      issuetype: { name: type },
      summary: `Story ${key}`,
      status: { name: 'In Progress' },
      customfield_10016: 3,
      customfield_10020: sprints || [{ id: 7, name: 'Sprint 7', state: 'active' }],
      subtasks,
    },
    renderedFields: { description: '<div>desc</div>' },
  });
  const JSTORY_1 = JSTORY('PROJ-1');
  const JSTORY_2 = JSTORY('PROJ-2', {
    subtasks: [
      { key: 'PROJ-55', fields: { summary: '[Testing] Test Execution', status: { name: 'To Do' } } },
      { key: 'PROJ-56', fields: { summary: 'Implement the API', status: { name: 'To Do' } } },
    ],
  });
  const JSTORY_3 = JSTORY('PROJ-3');

  function jroutes(extra = []) {
    let created = 100;
    return [
      ...extra,
      { match: '/rest/api/3/field', json: ALL_FIELDS },
      { method: 'POST', match: '/search/jql', json: { issues: [JSTORY_1, JSTORY_3] } },
      { match: '/rest/api/3/issue/PROJ-1?', json: JSTORY_1 },
      { match: '/rest/api/3/issue/PROJ-2?', json: JSTORY_2 },
      { match: '/rest/api/3/issue/PROJ-3?', json: JSTORY_3 },
      { match: '/issue/createmeta/PROJ/issuetypes/10002', json: SUBTASK_META },
      { match: '/issue/createmeta/PROJ/issuetypes', json: J_ISSUE_TYPES },
      { match: '/rest/api/3/user/search', json: [J_USER] },
      { method: 'POST', match: '/rest/api/3/issue', json: () => ({ key: `PROJ-${++created}` }) },
    ];
  }
  const jSpec = (dir, stories = [{ id: 'PROJ-1', complexity: 'Simple', tasks: FIVE_TASKS }, { id: 'PROJ-3', complexity: 'Medium', tasks: FIVE_TASKS }], overrides = {}) => {
    const file = path.join(dir, `jspec-${++specSeq}.json`);
    fs.writeFileSync(file, JSON.stringify({ assignee: 'qa.engineer@example.com', stories, ...overrides }));
    return file;
  };
  const isJiraWrite = (c) => c.method !== 'GET' && !(c.method === 'POST' && c.url.includes('/search/jql'));

  await test('PINNED: the Jira current-sprint JQL — openSprints(), quoted values, ORDER BY key', async () => {
    assert.strictEqual(
      currentSprintJql('PROJ', 'Story'),
      'project = "PROJ" AND issuetype = "Story" AND sprint in openSprints() ORDER BY key');
    assert.strictEqual(
      currentSprintJql('My "Q" Proj', 'User Story'),
      'project = "My \\"Q\\" Proj" AND issuetype = "User Story" AND sprint in openSprints() ORDER BY key');
  });

  await test('jira stories --current-sprint: pinned JQL sent, per-story facts, children from inline subtasks (no per-child reads)', async () => {
    const f = fakeFetch(jroutes());
    const { code, out } = await run(['stories', '--current-sprint', '--full'], { cwd: jproj(), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    const search = f.calls.find((c) => c.url.includes('/search/jql'));
    const body = JSON.parse(search.body);
    assert.strictEqual(body.jql, currentSprintJql('PROJ', 'Story'));
    assert.ok(body.fields.includes('customfield_10020'), 'the discovered Sprint field rides the query');
    assert.strictEqual(out.stories.length, 2);
    const s1 = out.stories.find((s) => s.id === 'PROJ-1');
    assert.strictEqual(s1.title, 'Story PROJ-1');
    assert.strictEqual(s1.state, 'In Progress');
    assert.strictEqual(s1.storyPoints, 3, 'Story Points resolved by field-name discovery');
    assert.strictEqual(s1.url, 'https://example.atlassian.net/browse/PROJ-1');
    assert.deepStrictEqual(s1.existingTestingTasks, []);
    assert.strictEqual(s1.description, '<div>desc</div>', '--full surfaces the server-rendered HTML');
    assert.ok(!f.calls.some((c) => c.url.includes('/issue/PROJ-55')), 'children come inline — no per-child reads');
  });

  await test('jira stories: existing [Testing] children detected from fields.subtasks', async () => {
    const f = fakeFetch(jroutes());
    const { out } = await run(['stories', '--ids', 'PROJ-2'], { cwd: jproj(), fetch: f });
    assert.strictEqual(out.stories[0].existingTestingTasks.length, 1, 'only the [Testing]-titled subtask counts');
    assert.strictEqual(out.stories[0].existingTestingTasks[0].id, 'PROJ-55');
  });

  await test('jira stories: no Story Points field resolved → null + a loud note naming jira.storyPointsField (never guessed)', async () => {
    const f = fakeFetch(jroutes([{ match: '/rest/api/3/field', json: [{ id: 'customfield_10020', name: 'Sprint' }] }]));
    const { out } = await run(['stories', '--ids', 'PROJ-1'], { cwd: jproj(), fetch: f });
    assert.strictEqual(out.stories[0].storyPoints, null);
    assert.match(JSON.stringify(out), /jira\.storyPointsField/);
  });

  await test('jira stories: MORE THAN ONE open sprint and no jira.board → blocked with the sprint options (the bundle ask)', async () => {
    const twoSprints = [
      JSTORY('PROJ-1', { sprints: [{ id: 7, name: 'Sprint 7', state: 'active' }] }),
      JSTORY('PROJ-9', { sprints: [{ id: 8, name: 'Sprint 8', state: 'active' }] }),
    ];
    const f = fakeFetch(jroutes([{ method: 'POST', match: '/search/jql', json: { issues: twoSprints } }]));
    const { code, out } = await run(['stories', '--current-sprint'], { cwd: jproj(), fetch: f });
    assert.strictEqual(code, 2, JSON.stringify(out));
    const b = out.blocked.find((x) => x.reason === 'multiple-open-sprints');
    assert.ok(b, JSON.stringify(out));
    assert.deepStrictEqual([...b.options].sort(), ['Sprint 7', 'Sprint 8']);
    assert.match(b.message, /--sprint|jira\.board/);
  });

  await test('jira stories: --sprint scopes a multi-sprint result for the run (the bundled answer\'s mechanical surface)', async () => {
    const twoSprints = [
      JSTORY('PROJ-1', { sprints: [{ id: 7, name: 'Sprint 7', state: 'active' }] }),
      JSTORY('PROJ-9', { sprints: [{ id: 8, name: 'Sprint 8', state: 'active' }] }),
    ];
    const f = fakeFetch(jroutes([{ method: 'POST', match: '/search/jql', json: { issues: twoSprints } }]));
    const { code, out } = await run(['stories', '--current-sprint', '--sprint', 'Sprint 8'], { cwd: jproj(), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.stories.map((s) => s.id), ['PROJ-9']);
  });

  await test('jira stories: NO open-sprint Story (kanban board / sprints off / nothing started) → blocked with the fix, never an empty ok', async () => {
    const f = fakeFetch(jroutes([{ method: 'POST', match: '/search/jql', json: { issues: [] } }]));
    const { code, out } = await run(['stories', '--current-sprint'], { cwd: jproj(), fetch: f });
    assert.strictEqual(code, 2, JSON.stringify(out));
    const b = out.blocked.find((x) => x.reason === 'no-open-sprint');
    assert.ok(b, JSON.stringify(out));
    assert.match(b.message, /--ids/);
    assert.match(b.message, /Sprints/);
    assert.match(b.message, /jira-boards\.md/);
  });

  await test('jira stories: a configured jira.board steers multi-sprint discovery through the agile API (O3)', async () => {
    const twoSprints = [
      JSTORY('PROJ-1', { sprints: [{ id: 7, name: 'Sprint 7', state: 'active' }] }),
      JSTORY('PROJ-9', { sprints: [{ id: 8, name: 'Sprint 8', state: 'active' }] }),
    ];
    const f = fakeFetch(jroutes([
      { method: 'POST', match: '/search/jql', json: { issues: twoSprints } },
      { match: '/rest/agile/1.0/board/42/sprint', json: { values: [{ id: 8, name: 'Sprint 8', state: 'active' }] } },
      { match: '/rest/agile/1.0/board?projectKeyOrId=', json: { values: [{ id: 42, name: 'PROJ board' }] } },
    ]));
    const { code, out } = await run(['stories', '--current-sprint'], { cwd: jproj({ jira: { board: '42' } }), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.stories.map((s) => s.id), ['PROJ-9'], 'scoped to the board\'s one active sprint');
  });

  await test('jira dry run: N×5 sub-task creates — parent inline, timetracking hours, labels [testing], assignee accountId', async () => {
    const dir = jproj();
    const f = fakeFetch(jroutes());
    const { code, out } = await run(['--spec', jSpec(dir)], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.mode, 'plan');
    assert.strictEqual(out.plan.length, 10, '2 stories × 5 tasks');
    for (const p of out.plan) {
      const body = p.request.body;
      assert.strictEqual(body.fields.issuetype.name, 'Sub-task', 'discovered sub-task type');
      assert.deepStrictEqual(body.fields.project, { key: 'PROJ' });
      assert.ok(body.fields.parent && body.fields.parent.key === p.story, 'parent folds inline — atomic');
      assert.deepStrictEqual(body.fields.timetracking, { originalEstimate: '1h', remainingEstimate: '1h' });
      assert.deepStrictEqual(body.fields.labels, ['testing']);
      assert.deepStrictEqual(body.fields.assignee, { accountId: 'acc-123' }, 'email resolved to accountId (O5)');
    }
    assert.deepStrictEqual(out.plan.map((p) => p.story),
      ['PROJ-1', 'PROJ-1', 'PROJ-1', 'PROJ-1', 'PROJ-1', 'PROJ-3', 'PROJ-3', 'PROJ-3', 'PROJ-3', 'PROJ-3'], 'story-ordered');
    assert.strictEqual(out.validation.assignee, 'qa.engineer@example.com');
    assert.strictEqual(out.validation.assigneeAccountId, 'acc-123', 'the resolution is carried into the plan');
    assert.strictEqual(out.validation.validateOnly, 'unsupported-on-jira', 'the screen is honest about what was proven');
    assert.match(JSON.stringify(out.validation.notes || out.notes || ''), /sprint/i, 'the no-iteration/area fact is said explicitly');
    assert.ok(out.cache.file.includes('tracker-fields-jira.json'));
    assert.strictEqual(f.calls.filter(isJiraWrite).length, 0, 'dry run writes nothing');
    assert.strictEqual(f.calls.filter((c) => c.url.includes('/user/search')).length, 1, 'ONE accountId read per run');
  });

  await test('jira: several sub-task types block with the options (the bundle round); jira.subtaskType pins it', async () => {
    const twoSubtaskTypes = { issueTypes: [
      { id: '10001', name: 'Story', subtask: false },
      { id: '10002', name: 'Sub-task', subtask: true },
      { id: '10009', name: 'QA Sub-task', subtask: true },
    ] };
    const dir1 = jproj();
    const r1 = await run(['--spec', jSpec(dir1)], {
      cwd: dir1,
      fetch: fakeFetch(jroutes([
        { match: '/issue/createmeta/PROJ/issuetypes/10009', json: SUBTASK_META },
        { match: '/issue/createmeta/PROJ/issuetypes', json: twoSubtaskTypes }])),
    });
    assert.strictEqual(r1.code, 2);
    const b = r1.out.blocked.find((x) => x.reason === 'subtask-type-ambiguous');
    assert.deepStrictEqual([...b.options].sort(), ['QA Sub-task', 'Sub-task']);
    const dir2 = jproj({ jira: { subtaskType: 'QA Sub-task' } });
    const r2 = await run(['--spec', jSpec(dir2)], {
      cwd: dir2,
      fetch: fakeFetch(jroutes([
        { match: '/issue/createmeta/PROJ/issuetypes/10009', json: SUBTASK_META },
        { match: '/issue/createmeta/PROJ/issuetypes', json: twoSubtaskTypes }])),
    });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    assert.strictEqual(r2.out.plan[0].request.body.fields.issuetype.name, 'QA Sub-task');
  });

  await test('jira: a story whose issue type is not the configured storyType blocks WITH the real type list', async () => {
    const f = fakeFetch(jroutes([{ match: '/rest/api/3/issue/PROJ-1?', json: JSTORY('PROJ-1', { type: 'Task' }) }]));
    const dir = jproj();
    const { code, out } = await run(['--spec', jSpec(dir)], { cwd: dir, fetch: f });
    assert.strictEqual(code, 2);
    const b = out.blocked.find((x) => x.reason === 'story-not-a-story');
    assert.ok(b, JSON.stringify(out.blocked));
    assert.match(b.message, /Story/);
    assert.match(b.message, /Sub-task/);
  });

  await test('jira: existing [Testing] sub-tasks block without --allow-existing and pass with it', async () => {
    const dir = jproj();
    const spec = jSpec(dir, [{ id: 'PROJ-2', tasks: FIVE_TASKS }]);
    const r1 = await run(['--spec', spec], { cwd: dir, fetch: fakeFetch(jroutes()) });
    assert.strictEqual(r1.code, 2);
    const bad = r1.out.blocked.find((b) => b.reason === 'existing-testing-tasks');
    assert.deepStrictEqual(bad.ids, ['PROJ-55']);
    const r2 = await run(['--spec', spec, '--allow-existing'], { cwd: dir, fetch: fakeFetch(jroutes()) });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
  });

  await test('jira: timetracking absent from the Sub-task create screen blocks BEFORE any write (field-not-on-type)', async () => {
    const noTT = { total: 4, fields: SUBTASK_META.fields.filter((x) => x.fieldId !== 'timetracking') };
    const dir = jproj();
    const { code, out } = await run(['--spec', jSpec(dir)], {
      cwd: dir, fetch: fakeFetch(jroutes([{ match: '/issue/createmeta/PROJ/issuetypes/10002', json: noTT }])),
    });
    assert.strictEqual(code, 2);
    const b = out.blocked.find((x) => x.reason === 'field-not-on-type' && x.field === 'timetracking');
    assert.ok(b, JSON.stringify(out.blocked));
    assert.match(b.message, /time tracking/i);
    assert.match(b.message, /jira-boards\.md/, 'points at the how-to-enable reference');
  });

  await test('jira --execute: one atomic sub-task create per task in story order; ledger + created keys/urls surfaced', async () => {
    const dir = jproj();
    const f = fakeFetch(jroutes());
    const { code, out } = await run(['--spec', jSpec(dir), '--execute'], { cwd: dir, fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.ledger.length, 10);
    assert.ok(out.ledger.every((l) => l.status === 'done' && l.id && l.url));
    const writes = f.calls.filter(isJiraWrite);
    assert.strictEqual(writes.length, 10, 'exactly one write per task — the parent rides the create');
    assert.ok(writes.every((c) => c.method === 'POST' && /\/rest\/api\/3\/issue(\?|$)/.test(c.url)));
    const parents = writes.map((c) => JSON.parse(c.body).fields.parent.key);
    assert.deepStrictEqual(parents, ['PROJ-1', 'PROJ-1', 'PROJ-1', 'PROJ-1', 'PROJ-1', 'PROJ-3', 'PROJ-3', 'PROJ-3', 'PROJ-3', 'PROJ-3']);
    assert.strictEqual(out.created.tasks.length, 10);
    assert.ok(out.created.tasks.every((t) => String(t.id).startsWith('PROJ-') && t.url.includes('/browse/')));
  });

  await test('jira --execute failure mid-plan: exit 1, exact ledger, created keys still surfaced, no retry', async () => {
    const dir = jproj();
    let creates = 0;
    const base = fakeFetch(jroutes());
    const failing = async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'POST' && /\/rest\/api\/3\/issue(\?|$)/.test(String(url))) {
        creates++;
        base.calls.push({ url: String(url), method: 'POST', body: opts.body });
        if (creates === 3) return { ok: false, status: 400, text: async () => JSON.stringify({ errorMessages: ['boom'] }) };
        return { ok: true, status: 200, text: async () => JSON.stringify({ key: `PROJ-${200 + creates}` }) };
      }
      return base(url, opts);
    };
    const { code, out } = await run(['--spec', jSpec(dir), '--execute'], { cwd: dir, fetch: failing });
    assert.strictEqual(code, 1);
    assert.strictEqual(out.ledger.filter((l) => l.status === 'done').length, 2);
    assert.strictEqual(out.ledger[2].status, 'failed');
    assert.match(out.ledger[2].reason, /boom/);
    assert.strictEqual(out.ledger.filter((l) => l.status === 'not-attempted').length, 7);
    assert.deepStrictEqual(out.created.tasks.map((t) => t.id), ['PROJ-201', 'PROJ-202']);
    assert.strictEqual(creates, 3, 'nothing after the failure, nothing retried');
  });

  await test('jira: sentinel credentials absent from the JSON out of every mode', async () => {
    const dir = jproj();
    const outs = [];
    outs.push(await run(['stories', '--current-sprint'], { cwd: dir, fetch: fakeFetch(jroutes()) }));
    outs.push(await run(['--spec', jSpec(dir)], { cwd: dir, fetch: fakeFetch(jroutes()) }));
    outs.push(await run(['--spec', jSpec(dir), '--execute'], { cwd: dir, fetch: fakeFetch(jroutes()) }));
    const all = JSON.stringify(outs);
    assert.ok(!all.includes(SENTINEL_JT));
    assert.ok(!all.includes(Buffer.from(`qa.engineer@example.com:${SENTINEL_JT}`).toString('base64')));
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
