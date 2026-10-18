'use strict';
// Tests for the configurable-estimation surface of create-tasks.js, through
// run() on ADO and Jira projects with an INJECTED fake fetch (offline):
//   - the `estimation` subcommand (file present / invalid / first-run proposal)
//   - the ratings spec mode of the dry run (derivation, the estimation block,
//     the create-file plan entry, the basis)
//   - --execute in ratings mode (basis guard, file pre-check, the create-file
//     intent first in the one WritePlan, the race, partial failure)
// The legacy `tasks` spec path is pinned by create-tasks.test.js and the golden
// suite; nothing here changes it.
// Run: node skills/task-estimation/scripts/create-tasks.estimation.test.js
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./create-tasks.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

for (const k of Object.keys(process.env)) {
  if (k.startsWith('AZURE_') || k.startsWith('JIRA_') || k === 'AGENTEX_CI') delete process.env[k];
}

const FILE = 'config/estimation.json';
const NOW = () => new Date(2026, 9, 18, 9, 30); // local 2026-10-18
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ── fake fetch: method + url substring (+ body substring); respond(call, n) ──
function fakeFetch(routes, { onCall } = {}) {
  const calls = []; const hits = new Map();
  const fn = async (url, opts = {}) => {
    const call = { method: opts.method || 'GET', url: String(url), body: opts.body === undefined ? null : opts.body };
    calls.push(call);
    if (onCall) onCall(call);
    for (const r of routes) {
      if ((r.method || 'GET') !== call.method || !call.url.includes(r.match)) continue;
      if (r.bodyMatch && !(typeof call.body === 'string' && call.body.includes(r.bodyMatch))) continue;
      const n = (hits.get(r) || 0) + 1; hits.set(r, n);
      const resp = r.respond ? r.respond(call, n) : r;
      const status = resp.status || 200;
      const text = resp.text !== undefined ? resp.text : JSON.stringify(resp.json ?? {});
      return { ok: status < 300, status, text: async () => text };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

// ── projects ────────────────────────────────────────────────────────────────
function adoProject({ azure = {}, estimation } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-est-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
    azure: { org: 'exampleorg', project: 'Sample Project', team: 'Sample Team', assignee: 'qa.engineer@example.com', ...azure },
  }));
  fs.writeFileSync(path.join(dir, '.env'), 'AZURE_PAT=SENTINEL-est-pat\n');
  if (estimation !== undefined) writeFile(dir, estimation);
  return dir;
}
function jiraProject({ jira = {}, estimation } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-est-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
    jira: { site: 'example', project: 'PROJ', assignee: 'qa.engineer@example.com', ...jira },
  }));
  fs.writeFileSync(path.join(dir, '.env'), 'JIRA_EMAIL=qa.engineer@example.com\nJIRA_API_TOKEN=SENTINEL-est-token\n');
  if (estimation !== undefined) writeFile(dir, estimation);
  return dir;
}
function writeFile(dir, estimation) {
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), typeof estimation === 'string' ? estimation : JSON.stringify(estimation, null, 2) + '\n');
}
const fileBytes = (dir) => fs.readFileSync(path.join(dir, FILE));
const outFile = (dir) => path.join(dir, '..', `${path.basename(dir)}-proposal.json`); // OS temp, outside the project

// ── one history dataset, served by both providers (Q9) ──────────────────────
// Sprints 40–42 are closed (42 newest), 43 is current. Stories 1–2 sit in
// Sprint 41, 3–4 in Sprint 42, 5 in Sprint 40 (outside the default N = 2).
const SPRINTS = [
  { n: 40, name: 'Sprint 40', finish: '2026-08-31T00:00:00Z', state: 'past' },
  { n: 41, name: 'Sprint 41', finish: '2026-09-14T00:00:00Z', state: 'past' },
  { n: 42, name: 'Sprint 42', finish: '2026-09-28T00:00:00Z', state: 'past' },
  { n: 43, name: 'Sprint 43', finish: '2026-10-12T00:00:00Z', state: 'current' },
];
const STORIES = [
  { n: 1, sprint: 41, title: 'Contact preferences' },
  { n: 2, sprint: 41, title: 'Checkout address form' },
  { n: 3, sprint: 42, title: 'Notification settings' },
  { n: 4, sprint: 42, title: 'Order history filters' },
  { n: 5, sprint: 40, title: 'Saved addresses' },
];
const CHILDREN = [
  [1, '[Testing] Requirement Review', 1], [1, '[Testing] Test Creation', 2], [1, '[Testing] Test Execution', 2], [1, 'Build the form', 5],
  [2, '[Testing] Requirement Review', 1], [2, '[Testing] Test Creation', 1.5], [2, '[Testing] Test Execution', 12], [2, '[Testing] Automation', null],
  [3, '[Testing] Requirement Review', 0.5], [3, '[Testing]  test creation ', 3], [3, '[Testing] Test Execution', 3],
  [4, '[Testing] Requirement Review', 2], [4, '[Testing] Test Execution', 1], [4, '[Testing] Smoke Pass', 1],
  [5, '[Testing] Requirement Review', 9], [5, '[Testing] Test Execution', 9],
].map(([story, title, hours], i) => ({ i, story, title, hours }));
const PROPOSED_TASKS = [
  { name: 'Requirement Review', enabled: true, minHours: 0.5, maxHours: 2 },
  { name: 'Test Creation', enabled: true, minHours: 1.5, maxHours: 3 },
  { name: 'Test Execution', enabled: true, minHours: 1, maxHours: 3 },
  { name: 'Smoke Pass', enabled: true, minHours: 1, maxHours: 1 },
];

// ADO: ids 2100+n (stories), 4500+i (children); the outlier is task 4506 on story 2102.
function adoHistoryRoutes({ sprints = SPRINTS, children = CHILDREN, noEstimates = false } = {}) {
  const storyIds = (q) => STORIES.filter((s) => q.includes(`Sprint ${s.sprint}'`)).map((s) => 2100 + s.n);
  const items = {};
  for (const s of STORIES) items[2100 + s.n] = { id: 2100 + s.n, fields: { 'System.Id': 2100 + s.n, 'System.Title': s.title } };
  for (const c of children) {
    items[4500 + c.i] = { id: 4500 + c.i, fields: {
      'System.Id': 4500 + c.i, 'System.Title': c.title, 'System.Parent': 2100 + c.story,
      ...(c.hours !== null && !noEstimates ? { 'Microsoft.VSTS.Scheduling.OriginalEstimate': c.hours } : {}),
    } };
  }
  return [
    { match: '/Sample%20Team/_apis/work/teamsettings/iterations', json: { value: sprints.map((s) => ({
      id: `it-${s.n}`, name: s.name, path: `Sample Project\\${s.name}`, attributes: { timeFrame: s.state, startDate: null, finishDate: s.finish },
    })) } },
    { method: 'POST', match: '/wiql', bodyMatch: '[System.Parent]', respond: (call) => {
      const q = JSON.parse(call.body).query;
      const parents = (/IN \(([^)]*)\)/.exec(q)[1]).split(',').map((x) => Number(x.trim()));
      return { json: { workItems: children.filter((c) => parents.includes(2100 + c.story)).map((c) => ({ id: 4500 + c.i })) } };
    } },
    { method: 'POST', match: '/wiql', bodyMatch: '[System.IterationPath] IN', respond: (call) => ({ json: { workItems: storyIds(JSON.parse(call.body).query).map((id) => ({ id })) } }) },
    { method: 'POST', match: '/workitemsbatch', respond: (call) => ({ json: { value: JSON.parse(call.body).ids.map((id) => items[id]) } }) },
  ];
}

// Jira: story keys PROJ-10n (ids 10100+n), sub-task keys PROJ-5xx (ids 10500+i).
function jiraHistoryRoutes({ boards = [{ id: 7, name: 'PROJ board', type: 'scrum' }], children = CHILDREN, noEstimates = false } = {}) {
  return [
    { match: '/rest/agile/1.0/board?projectKeyOrId=', json: { values: boards } },
    { match: '/rest/agile/1.0/board/', respond: () => ({ json: { values: SPRINTS.filter((s) => s.state === 'past')
      .map((s) => ({ id: s.n, name: s.name, state: 'closed', completeDate: s.finish })) } }) },
    { method: 'POST', match: '/search/jql', bodyMatch: 'sprint in (', respond: (call) => {
      const ids = (/sprint in \(([^)]*)\)/.exec(JSON.parse(call.body).jql)[1]).split(',').map((x) => Number(x.trim()));
      return { json: { issues: STORIES.filter((s) => ids.includes(s.sprint)).map((s) => ({ id: String(10100 + s.n), key: `PROJ-${100 + s.n}`, fields: { summary: s.title } })) } };
    } },
    { method: 'POST', match: '/search/jql', bodyMatch: 'parent in (', respond: (call) => {
      const jql = JSON.parse(call.body).jql;
      return { json: { issues: children.filter((c) => jql.includes(`"PROJ-${100 + c.story}"`)).map((c) => ({
        id: String(10500 + c.i), key: `PROJ-${500 + c.i}`,
        fields: { summary: c.title, parent: { key: `PROJ-${100 + c.story}` }, ...(c.hours !== null && !noEstimates ? { timeoriginalestimate: c.hours * 3600 } : {}) },
      })) } };
    } },
  ];
}

const isAdoWrite = (c) => c.method !== 'GET' && !(c.method === 'POST' && (c.url.includes('/wiql') || c.url.includes('/workitemsbatch'))) && !c.url.includes('validateOnly=true');
const isJiraWrite = (c) => c.method !== 'GET' && !(c.method === 'POST' && c.url.includes('/search/jql'));

async function estimation(dir, routes, extraArgs = []) {
  const f = fakeFetch(routes);
  const outPath = outFile(dir);
  const r = await run(['estimation', '--out', outPath, ...extraArgs], { cwd: dir, fetch: f, now: NOW });
  return { ...r, calls: f.calls, outPath };
}

const VALID_FILE = () => ({
  schemaVersion: 1,
  tasks: [
    { name: 'Requirement Review', enabled: true, minHours: 0.5, maxHours: 2 },
    { name: 'Exploratory Pass', enabled: true, minHours: 1, maxHours: 3 },
    { name: 'Test Execution', enabled: true, minHours: 1, maxHours: 3 },
    { name: 'Automation', enabled: false, minHours: 1, maxHours: 3 },
  ],
  factors: { 'Scenarios / ACs': 1, 'UI elements': 1, 'Data setup': 2 },
  source: { kind: 'history', sprints: 2, note: 'hand-edited' },
});

// ── the validate / create path (stories 2201, 2202 / PROJ-201, PROJ-202) ────
const ADO_STORY = (id) => ({ id, fields: {
  'System.WorkItemType': 'User Story', 'System.Title': `Story ${id}`, 'System.State': 'Active',
  'Microsoft.VSTS.Scheduling.StoryPoints': 3,
  'System.IterationPath': 'Sample Project\\Sprint 43', 'System.AreaPath': 'Sample Project\\Team Area',
} });
const TASK_FIELDS = { value: [
  { referenceName: 'System.Title', alwaysRequired: true },
  { referenceName: 'Microsoft.VSTS.Common.Activity', allowedValues: ['Development', 'Testing'] },
  { referenceName: 'Microsoft.VSTS.Scheduling.OriginalEstimate' },
  { referenceName: 'Microsoft.VSTS.Scheduling.RemainingWork' },
] };
function adoCreateRoutes(extra = []) {
  let created = 9000;
  return [
    ...extra,
    { match: '/wit/workitems/2201?', json: ADO_STORY(2201) },
    { match: '/wit/workitems/2202?', json: ADO_STORY(2202) },
    { match: '/wit/workitemtypes/Task/fields', json: TASK_FIELDS },
    { method: 'POST', match: 'validateOnly=true', json: {} },
    { method: 'POST', match: '/workitems/$Task', respond: () => ({ json: { id: ++created } }) },
  ];
}
const JIRA_STORY = (key) => ({ key, fields: {
  issuetype: { name: 'Story' }, summary: `Story ${key}`, status: { name: 'In Progress' }, customfield_10016: 3,
  customfield_10020: [{ id: 43, name: 'Sprint 43', state: 'active' }], subtasks: [],
} });
function jiraCreateRoutes(extra = []) {
  let created = 700;
  return [
    ...extra,
    { match: '/rest/api/3/field', json: [{ id: 'customfield_10016', name: 'Story Points' }, { id: 'customfield_10020', name: 'Sprint' }] },
    { match: '/rest/api/3/issue/PROJ-201?', json: JIRA_STORY('PROJ-201') },
    { match: '/rest/api/3/issue/PROJ-202?', json: JIRA_STORY('PROJ-202') },
    { match: '/issue/createmeta/PROJ/issuetypes/10002', json: { total: 5, fields: ['summary', 'timetracking', 'labels', 'assignee', 'parent']
      .map((fieldId) => ({ fieldId, name: fieldId, required: fieldId === 'summary' })) } },
    { match: '/issue/createmeta/PROJ/issuetypes', json: { issueTypes: [
      { id: '10001', name: 'Story', subtask: false }, { id: '10002', name: 'Sub-task', subtask: true }] } },
    { match: '/rest/api/3/user/search', json: [{ accountId: 'acc-1', emailAddress: 'qa.engineer@example.com', displayName: 'QA Engineer' }] },
    { method: 'POST', match: '/rest/api/3/issue', respond: () => ({ json: { key: `PROJ-${++created}` } }) },
  ];
}

let specSeq = 0;
function writeSpec(dir, spec) {
  const file = path.join(dir, '..', `${path.basename(dir)}-spec-${++specSeq}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  return file;
}
const ratingsFor = (factors, r) => Object.fromEntries(Object.keys(factors).map((f) => [f, r]));
const RATINGS_SPEC = (factors, ids = [2201, 2202], extra = {}) => ({
  assignee: 'qa.engineer@example.com',
  stories: [
    { id: ids[0], ratings: ratingsFor(factors, 0) },
    { id: ids[1], ratings: { ...ratingsFor(factors, 2), [Object.keys(factors)[0]]: 4 } },
  ],
  ...extra,
});
async function dryRun(dir, spec, routes, args = []) {
  const f = fakeFetch(routes);
  const r = await run(['--spec', writeSpec(dir, spec), ...args], { cwd: dir, fetch: f, now: NOW });
  return { ...r, calls: f.calls };
}
// A first run on ADO: Phase A writes the proposal; the spec points at it.
async function firstRun(dir = adoProject(), routes = adoHistoryRoutes()) {
  const est = await estimation(dir, routes);
  assert.strictEqual(est.code, 0, JSON.stringify(est.out));
  return { dir, proposalFile: est.outPath, est: est.out };
}

(async () => {
  // ════ the `estimation` subcommand ═════════════════════════════════════════
  await test('estimation, first run (ADO): proposal from the last 2 closed sprints — --out written, summary, nothing created, history reads only', async () => {
    const dir = adoProject();
    const { code, out, calls, outPath } = await estimation(dir, adoHistoryRoutes());
    const r = out;
    assert.strictEqual(code, 0, JSON.stringify(r));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'estimation');
    assert.strictEqual(r.source, 'proposal');
    assert.strictEqual(r.kind, 'history');
    assert.strictEqual(r.file, FILE);
    assert.strictEqual(r.proposalFile, outPath);
    assert.deepStrictEqual(r.content.tasks, PROPOSED_TASKS);
    assert.deepStrictEqual(r.content.source.sprintsRead, ['Sprint 42', 'Sprint 41']);
    assert.strictEqual(r.content.source.createdOn, '2026-10-18');
    assert.deepStrictEqual(r.provenance, {
      sprintsRequested: 2, sprintsRead: ['Sprint 42', 'Sprint 41'], storiesRead: 4, tasksCounted: 12, tasksSkipped: 1,
      namesWithoutEstimates: ['Automation'], truncated: false, reason: null, reasonMessage: null,
    });
    assert.deepStrictEqual(r.groups, [
      { name: 'Requirement Review', stories: 4, min: 0.5, max: 2 }, { name: 'Test Creation', stories: 3, min: 1.5, max: 3 },
      { name: 'Test Execution', stories: 4, min: 1, max: 3 }, { name: 'Smoke Pass', stories: 1, min: 1, max: 1 },
    ]);
    assert.deepStrictEqual(r.outliers, [{
      ref: 4506, task: 'Test Execution', story: { ref: 2102, title: 'Checkout address form', url: 'https://dev.azure.com/exampleorg/Sample%20Project/_workitems/edit/2102' },
      hours: 12, side: 'high', normalRange: [1, 3], suggested: 3, choice: 'suggested', used: 3,
    }]);
    assert.deepStrictEqual(r.threshold, { ratio: 3, minSample: 3 });
    const proposal = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(proposal.proposalVersion, 1);
    assert.deepStrictEqual(proposal.content, r.content);
    assert.ok(!fs.existsSync(path.join(dir, FILE)), 'Phase A never writes config/estimation.json');
    assert.strictEqual(calls.length, 5, 'iterations + story WIQL + story batch + child WIQL + child batch');
    assert.deepStrictEqual(calls.filter(isAdoWrite), []);
  });

  await test('estimation, first run (Jira): the same data points give the same file content (Q9)', async () => {
    const ado = await estimation(adoProject(), adoHistoryRoutes());
    const jira = await estimation(jiraProject(), jiraHistoryRoutes());
    assert.strictEqual(jira.code, 0, JSON.stringify(jira.out));
    assert.deepStrictEqual(jira.out.content, ado.out.content);
    assert.deepStrictEqual(jira.out.groups, ado.out.groups);
    assert.deepStrictEqual(jira.out.outliers.map((o) => [o.task, o.hours, o.side, o.suggested, o.story.title]),
      ado.out.outliers.map((o) => [o.task, o.hours, o.side, o.suggested, o.story.title]));
    assert.strictEqual(jira.calls.length, 4, 'boards + closed sprints + story JQL + sub-task JQL');
    assert.deepStrictEqual(jira.calls.filter(isJiraWrite), []);
  });

  await test('estimation --sprints 3 reads three closed sprints and records the count', async () => {
    const r = await estimation(adoProject(), adoHistoryRoutes(), ['--sprints', '3']);
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.provenance.sprintsRead, ['Sprint 42', 'Sprint 41', 'Sprint 40']);
    assert.strictEqual(r.out.content.source.sprints, 3);
    // Sprint 40 adds 9 h to Requirement Review (flagged: > 3 × median 1) and to
    // Test Execution (median 3: 9 is not above 9, so it is normal and becomes the max).
    assert.deepStrictEqual(r.out.outliers.map((o) => [o.task, o.hours]), [['Requirement Review', 9], ['Test Execution', 12]]);
    assert.strictEqual(r.out.content.tasks.find((t) => t.name === 'Requirement Review').maxHours, 2);
    assert.strictEqual(r.out.content.tasks.find((t) => t.name === 'Test Execution').maxHours, 9);
  });

  await test('estimation usage errors exit 2 with ZERO requests: --out missing, --sprints not a positive whole number', async () => {
    const dir = adoProject();
    for (const argv of [['estimation'], ['estimation', '--out'], ['estimation', '--out', outFile(dir), '--sprints', '0'],
      ['estimation', '--out', outFile(dir), '--sprints', '-1'], ['estimation', '--out', outFile(dir), '--sprints', '1.5'],
      ['estimation', '--out', outFile(dir), '--sprints', 'two'], ['estimation', '--out', outFile(dir), '--sprints']]) {
      const f = fakeFetch(adoHistoryRoutes());
      const { code, out } = await run(argv, { cwd: dir, fetch: f, now: NOW });
      assert.strictEqual(code, 2, `${argv.join(' ')}: ${JSON.stringify(out)}`);
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.mode, 'estimation');
      assert.match(out.error.message, /estimation --out <file>/);
      assert.strictEqual(f.calls.length, 0, argv.join(' '));
    }
  });

  await test('estimation --out pointing at config/estimation.json is refused (the file is written only on approval)', async () => {
    const dir = adoProject();
    const f = fakeFetch(adoHistoryRoutes());
    const { code, out } = await run(['estimation', '--out', path.join(dir, 'config', 'estimation.json')], { cwd: dir, fetch: f, now: NOW });
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.strictEqual(f.calls.length, 0);
    assert.ok(!fs.existsSync(path.join(dir, FILE)));
  });

  await test('estimation with a valid file: source file, the enabled tasks, ZERO requests — the tracker is not even resolved', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-est-')); // no tracker configured at all
    writeFile(dir, VALID_FILE());
    const before = sha(fileBytes(dir));
    const f = fakeFetch([]);
    const { code, out } = await run(['estimation', '--out', outFile(dir)], { cwd: dir, fetch: f, now: NOW });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.source, 'file');
    assert.strictEqual(out.file, FILE);
    assert.deepStrictEqual(out.enabledTasks.map((t) => t.name), ['Requirement Review', 'Exploratory Pass', 'Test Execution']);
    assert.deepStrictEqual(Object.keys(out.content.factors), ['Scenarios / ACs', 'UI elements', 'Data setup']);
    assert.strictEqual(out.note, undefined);
    assert.strictEqual(f.calls.length, 0);
    assert.strictEqual(sha(fileBytes(dir)), before);
    assert.ok(!fs.existsSync(outFile(dir)), 'no proposal is written when the file exists');
    const s = await run(['estimation', '--out', outFile(dir), '--sprints', '3'], { cwd: dir, fetch: f, now: NOW });
    assert.strictEqual(s.code, 0);
    assert.match(s.out.note, /history is read only when there is no file/);
    assert.match(s.out.note, /delete or move/);
    assert.strictEqual(f.calls.length, 0, 'once the file exists, no run reads past sprints');
  });

  await test('estimation with an invalid file: exit 2 naming every problem, ZERO requests, bytes unchanged, never repaired', async () => {
    const bad = VALID_FILE();
    bad.tasks[2].minHours = 4; bad.tasks[2].maxHours = 2;
    bad.tasks.push({ name: 'test execution', enabled: true, minHours: 1, maxHours: 2 });
    const dir = adoProject({ estimation: bad });
    const before = sha(fileBytes(dir));
    const f = fakeFetch(adoHistoryRoutes());
    const { code, out } = await run(['estimation', '--out', outFile(dir)], { cwd: dir, fetch: f, now: NOW });
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.source, 'invalid');
    assert.strictEqual(out.file, FILE);
    assert.deepStrictEqual(out.problems.map((p) => p.code), ['min-greater-than-max', 'name-duplicate']);
    assert.match(out.message, /nothing was read or written/);
    assert.match(out.message, /never repairs/);
    assert.strictEqual(f.calls.length, 0);
    assert.strictEqual(sha(fileBytes(dir)), before);
    const parse = adoProject({ estimation: '{ "schemaVersion": 1, ' });
    const p = await run(['estimation', '--out', outFile(parse)], { cwd: parse, fetch: f, now: NOW });
    assert.strictEqual(p.code, 2);
    assert.deepStrictEqual(p.out.problems.map((x) => x.code), ['parse-error']);
  });

  await test('starter defaults for each reason (ADO), labelled with the reason and its message', async () => {
    const noPast = adoHistoryRoutes({ sprints: SPRINTS.filter((s) => s.state === 'current') });
    const noTesting = adoHistoryRoutes({ children: CHILDREN.filter((c) => !c.title.toLowerCase().startsWith('[testing]')) });
    const noEstimates = adoHistoryRoutes({ noEstimates: true });
    for (const [reason, routes, pattern] of [['no-closed-sprints', noPast, /no past iteration/], ['no-testing-tasks', noTesting, /no \[Testing\] task/],
      ['no-estimates', noEstimates, /Original Estimate/]]) {
      const r = await estimation(adoProject(), routes);
      assert.strictEqual(r.code, 0, JSON.stringify(r.out));
      assert.strictEqual(r.out.kind, 'starter-defaults', reason);
      assert.strictEqual(r.out.provenance.reason, reason);
      assert.match(r.out.provenance.reasonMessage, pattern);
      assert.strictEqual(r.out.content.source.kind, 'starter-defaults');
      assert.strictEqual(r.out.content.source.reason, reason);
      assert.deepStrictEqual(r.out.content.tasks.map((t) => t.name), ['Requirement Review', 'Test Creation', 'Test Execution', 'Bug Review and Retest', 'Automation']);
      assert.strictEqual(r.out.content.tasks.reduce((s, t) => s + t.minHours, 0), 3);
      assert.strictEqual(r.out.content.tasks.reduce((s, t) => s + t.maxHours, 0), 5);
      assert.deepStrictEqual(r.out.outliers, []);
    }
  });

  await test('Jira hours mode none: past sub-tasks without time tracking → starter defaults, the cause named, descriptions never read', async () => {
    const r = await estimation(jiraProject(), jiraHistoryRoutes({ noEstimates: true }));
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.strictEqual(r.out.kind, 'starter-defaults');
    assert.strictEqual(r.out.provenance.reason, 'no-estimates');
    assert.match(r.out.provenance.reasonMessage, /time tracking is not on the sub-task screen/);
    assert.match(r.out.provenance.reasonMessage, /hours mode `none`/);
    assert.match(r.out.provenance.reasonMessage, /never reads descriptions/);
    for (const c of r.calls) assert.ok(!/description|renderedFields/i.test(`${c.url} ${c.body || ''}`), `description requested: ${c.url}`);
  });

  await test('ADO history read without a team: exit 2 naming --team / azure.team / AZURE_TEAM, ZERO requests', async () => {
    const dir = adoProject({ azure: { team: undefined } });
    const r = await estimation(dir, adoHistoryRoutes());
    assert.strictEqual(r.code, 2, JSON.stringify(r.out));
    for (const name of ['--team', 'azure.team', 'AZURE_TEAM']) assert.ok(r.out.error.message.includes(name), name);
    assert.strictEqual(r.calls.length, 0);
    const withTeam = await estimation(dir, adoHistoryRoutes(), ['--team', 'Sample Team']);
    assert.strictEqual(withTeam.code, 0, 'a run-only --team answers it');
  });

  await test('Jira: several boards with sprints → history-board-ambiguous with the real options (the bundled round); --board answers it', async () => {
    const boards = [{ id: 7, name: 'PROJ board', type: 'scrum' }, { id: 8, name: 'Mobile board', type: 'scrum' }, { id: 9, name: 'Flow', type: 'kanban' }];
    const dir = jiraProject();
    const r = await estimation(dir, jiraHistoryRoutes({ boards }));
    assert.strictEqual(r.code, 2, JSON.stringify(r.out));
    const b = r.out.blocked.find((x) => x.reason === 'history-board-ambiguous');
    assert.deepStrictEqual(b.options, ['PROJ board (id 7)', 'Mobile board (id 8)']);
    assert.match(b.message, /--board/);
    assert.match(b.message, /jira\.board/);
    const ok = await estimation(dir, jiraHistoryRoutes({ boards }), ['--board', 'PROJ board']);
    assert.strictEqual(ok.code, 0, JSON.stringify(ok.out));
  });

  // ════ the ratings spec mode — dry run ═════════════════════════════════════
  await test('ratings dry run with a file (ADO): exactly the file\'s enabled tasks, in file order, hours placed from the ratings; the estimation block last', async () => {
    const file = VALID_FILE();
    const dir = adoProject({ estimation: file });
    const before = sha(fileBytes(dir));
    const { code, out, calls } = await dryRun(dir, RATINGS_SPEC(file.factors), adoCreateRoutes());
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.mode, 'plan');
    assert.deepStrictEqual(Object.keys(out), ['ok', 'mode', 'validation', 'plan', 'cache', 'estimation']);
    assert.ok(out.plan.every((p) => p.step === 'create-task'), 'no create-file entry when the file exists');
    assert.deepStrictEqual(out.plan.map((p) => [p.story, p.title]), [
      [2201, '[Testing] Requirement Review'], [2201, '[Testing] Exploratory Pass'], [2201, '[Testing] Test Execution'],
      [2202, '[Testing] Requirement Review'], [2202, '[Testing] Exploratory Pass'], [2202, '[Testing] Test Execution'],
    ]);
    const hoursOf = (p) => p.request.body.find((op) => op.path === '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate').value;
    assert.deepStrictEqual(out.plan.map(hoursOf), [0.5, 1, 1, 1.5, 2.5, 2.5], 'all-0 → every min; story 2 score 0.625');
    const e = out.estimation;
    assert.deepStrictEqual(Object.keys(e), ['source', 'file', 'create', 'content', 'perStory', 'total', 'basis']);
    assert.strictEqual(e.source, 'file');
    assert.strictEqual(e.create, false);
    assert.deepStrictEqual(e.perStory.map((x) => [x.id, x.score, x.scorePct, x.total]), [[2201, 0, 0, 2.5], [2202, 0.625, 63, 6.5]]);
    assert.deepStrictEqual(e.perStory[1].ratings, { 'Scenarios / ACs': 4, 'UI elements': 2, 'Data setup': 2 });
    assert.strictEqual(e.total, 9);
    assert.match(e.basis, /^[0-9a-f]{64}$/);
    assert.strictEqual(sha(fileBytes(dir)), before, 'a dry run never touches the file');
    assert.deepStrictEqual(calls.filter(isAdoWrite), []);
  });

  await test('the task count follows the file: 3 enabled tasks → 3 per story; 7 → 7 per story', async () => {
    for (const n of [3, 7]) {
      const file = { schemaVersion: 1, factors: { Scope: 1 },
        tasks: Array.from({ length: n }, (_, i) => ({ name: `Step ${i + 1}`, enabled: true, minHours: 0.5, maxHours: 2 })).concat([{ name: 'Off', enabled: false, minHours: 1, maxHours: 1 }]) };
      const dir = adoProject({ estimation: file });
      const { code, out } = await dryRun(dir, RATINGS_SPEC(file.factors), adoCreateRoutes());
      assert.strictEqual(code, 0, JSON.stringify(out));
      assert.strictEqual(out.plan.filter((p) => p.story === 2201).length, n);
      assert.deepStrictEqual(out.plan.filter((p) => p.story === 2201).map((p) => p.title), Array.from({ length: n }, (_, i) => `[Testing] Step ${i + 1}`));
      assert.ok(!out.plan.some((p) => p.title === '[Testing] Off'), 'a disabled task is never proposed');
    }
  });

  await test('first run: create-file is plan[0], then the task creates; the dry run never writes the file; the estimation block carries the proposal', async () => {
    const { dir, proposalFile, est } = await firstRun();
    const spec = RATINGS_SPEC(est.content.factors, [2201, 2202], { estimation: { proposalFile } });
    const { code, out, calls } = await dryRun(dir, spec, adoCreateRoutes());
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.plan[0], {
      step: 'create-file', path: 'config/estimation.json',
      describe: 'create config/estimation.json — a new file, written only if none exists (never replaces one)',
    });
    assert.deepStrictEqual(out.plan.slice(1).map((p) => p.title), [
      '[Testing] Requirement Review', '[Testing] Test Creation', '[Testing] Test Execution', '[Testing] Smoke Pass',
      '[Testing] Requirement Review', '[Testing] Test Creation', '[Testing] Test Execution', '[Testing] Smoke Pass',
    ]);
    const e = out.estimation;
    assert.deepStrictEqual(Object.keys(e), ['source', 'file', 'create', 'content', 'provenance', 'groups', 'outliers', 'threshold', 'perStory', 'total', 'basis']);
    assert.strictEqual(e.source, 'history');
    assert.strictEqual(e.create, true);
    assert.deepStrictEqual(e.content, est.content);
    assert.deepStrictEqual(e.outliers.map((o) => [o.ref, o.choice, o.used]), [[4506, 'suggested', 3]]);
    assert.deepStrictEqual(e.perStory[0].tasks.map((t) => t.hours), [0.5, 1.5, 1, 1], 'all-0 → each proposed min');
    assert.ok(!fs.existsSync(path.join(dir, FILE)), 'the dry run never writes config/estimation.json');
    assert.deepStrictEqual(calls.filter(isAdoWrite), []);
  });

  await test('first run with no usable history: the starter defaults are the proposal (create-file + the five starter tasks)', async () => {
    const { dir, proposalFile, est } = await firstRun(adoProject(), adoHistoryRoutes({ noEstimates: true }));
    const { code, out } = await dryRun(dir, RATINGS_SPEC(est.content.factors, [2201, 2202], { estimation: { proposalFile } }), adoCreateRoutes());
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.estimation.source, 'starter-defaults');
    assert.strictEqual(out.estimation.provenance.reason, 'no-estimates');
    assert.strictEqual(out.plan[0].step, 'create-file');
    assert.strictEqual(out.plan.length, 1 + 10);
    // story 2: score 18/32 = 0.5625 → 1 · 1 · 1.5 · 1 · 0.5 (Automation's range is 0.5–0.5)
    assert.deepStrictEqual(out.estimation.perStory.map((x) => x.total), [3, 5]);
  });

  await test('outlier choices and gate edits recompute the proposal, the hours and the basis (still one dry run)', async () => {
    const { dir, proposalFile, est } = await firstRun();
    const base = await dryRun(dir, RATINGS_SPEC(est.content.factors, [2201, 2202], { estimation: { proposalFile } }), adoCreateRoutes());
    const counted = await dryRun(dir, RATINGS_SPEC(est.content.factors, [2201, 2202], {
      estimation: { proposalFile, outlierChoices: { 4506: 'count' }, taskEdits: { 'Smoke Pass': { enabled: false } } },
    }), adoCreateRoutes());
    assert.strictEqual(counted.code, 0, JSON.stringify(counted.out));
    const te = (o) => o.estimation.content.tasks.find((t) => t.name === 'Test Execution');
    assert.strictEqual(te(base.out).maxHours, 3);
    assert.strictEqual(te(counted.out).maxHours, 12);
    assert.strictEqual(counted.out.estimation.outliers[0].used, 12);
    assert.ok(!counted.out.plan.some((p) => p.title === '[Testing] Smoke Pass'), 'the disabled task is gone from the plan');
    assert.notStrictEqual(counted.out.estimation.basis, base.out.estimation.basis);
    const typed = await dryRun(dir, RATINGS_SPEC(est.content.factors, [2201, 2202], { estimation: { proposalFile, outlierChoices: { 4506: 4 } } }), adoCreateRoutes());
    assert.strictEqual(te(typed.out).maxHours, 4);
  });

  await test('a legacy tasks spec on a project WITH the file → tasks-not-from-file (exit 2, zero requests); an invalid file → estimation-file-invalid', async () => {
    const legacy = { assignee: 'qa.engineer@example.com', stories: [{ id: 2201, tasks: [{ title: '[Testing] Requirement Review', estimate: 1 }] }] };
    const dir = adoProject({ estimation: VALID_FILE() });
    const r = await dryRun(dir, legacy, adoCreateRoutes());
    assert.strictEqual(r.code, 2, JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.blocked.map((b) => b.reason), ['tasks-not-from-file']);
    assert.match(r.out.blocked[0].message, /config\/estimation\.json/);
    assert.match(r.out.blocked[0].message, /send ratings, not tasks/);
    assert.strictEqual(r.calls.length, 0);
    const bad = VALID_FILE(); bad.schemaVersion = 9;
    const r2 = await dryRun(adoProject({ estimation: bad }), legacy, adoCreateRoutes());
    assert.strictEqual(r2.code, 2);
    assert.deepStrictEqual(r2.out.blocked.map((b) => b.reason), ['estimation-file-invalid']);
    assert.deepStrictEqual(r2.out.blocked[0].problems.map((p) => p.code), ['schema-version']);
    assert.strictEqual(r2.calls.length, 0);
  });

  await test('every derivation block exits 2 with ZERO requests', async () => {
    const file = VALID_FILE();
    const { dir: firstDir, proposalFile, est } = await firstRun();
    const F = est.content.factors;
    const badFile = VALID_FILE(); badFile.tasks[0].minHours = 9;
    const garbage = path.join(firstDir, '..', `${path.basename(firstDir)}-garbage.json`);
    fs.writeFileSync(garbage, '{ not json');
    const malformed = path.join(firstDir, '..', `${path.basename(firstDir)}-malformed.json`);
    fs.writeFileSync(malformed, JSON.stringify({ proposalVersion: 1, kind: 'history', groups: 'x' }));
    const cases = [
      ['estimation-file-invalid', adoProject({ estimation: badFile }), RATINGS_SPEC(file.factors)],
      ['estimation-file-exists', adoProject({ estimation: file }), RATINGS_SPEC(file.factors, [2201, 2202], { estimation: { proposalFile } })],
      ['estimation-file-exists', adoProject({ estimation: file }), RATINGS_SPEC(file.factors, [2201, 2202], { estimation: { outlierChoices: {} } })],
      ['estimation-proposal-required', adoProject(), RATINGS_SPEC(F)],
      ['proposal-unreadable', adoProject(), RATINGS_SPEC(F, [2201, 2202], { estimation: { proposalFile: path.join(firstDir, 'nope.json') } })],
      ['proposal-unreadable', adoProject(), RATINGS_SPEC(F, [2201, 2202], { estimation: { proposalFile: garbage } })],
      ['proposal-unreadable', adoProject(), RATINGS_SPEC(F, [2201, 2202], { estimation: { proposalFile: malformed } })],
      ['bad-outlier-choice', adoProject(), RATINGS_SPEC(F, [2201, 2202], { estimation: { proposalFile, outlierChoices: { 4506: 'maybe' } } })],
      ['bad-task-edit', adoProject(), RATINGS_SPEC(F, [2201, 2202], { estimation: { proposalFile, taskEdits: { Nope: { enabled: false } } } })],
      ['estimation-proposal-invalid', adoProject(), RATINGS_SPEC(F, [2201, 2202], { estimation: { proposalFile, taskEdits: { 'Test Execution': { minHours: 9 } } } })],
      ['missing-rating', adoProject({ estimation: file }), { stories: [{ id: 2201, ratings: { 'Scenarios / ACs': 1, 'UI elements': 1 } }] }],
      ['unknown-factor', adoProject({ estimation: file }), { stories: [{ id: 2201, ratings: { ...ratingsFor(file.factors, 1), Extra: 1 } }] }],
      ['bad-rating', adoProject({ estimation: file }), { stories: [{ id: 2201, ratings: { ...ratingsFor(file.factors, 1), 'UI elements': 7 } }] }],
      ['bad-adjustment', adoProject({ estimation: file }), { stories: [{ id: 2201, ratings: ratingsFor(file.factors, 1), adjust: { 'Test Execution': 'later' } }] }],
      ['no-tasks-left', adoProject({ estimation: file }), { stories: [{ id: 2201, ratings: ratingsFor(file.factors, 1),
        adjust: { 'Requirement Review': 'skip', 'Exploratory Pass': 'skip', 'Test Execution': 'skip' } }] }],
      ['tasks-not-from-file', adoProject({ estimation: file }), { stories: [{ id: 2201, ratings: ratingsFor(file.factors, 1), tasks: [{ title: '[Testing] X', estimate: 1 }] }] }],
      ['missing-required-field', adoProject({ estimation: file }), { estimation: {}, stories: [] }],
    ];
    for (const [reason, dir, spec] of cases) {
      for (const extra of [[], ['--execute', '--basis', 'x']]) {
        const r = await dryRun(dir, spec, adoCreateRoutes(), extra);
        assert.strictEqual(r.code, 2, `${reason}: ${JSON.stringify(r.out)}`);
        assert.ok(r.out.blocked.some((b) => b.reason === reason), `${reason}: ${JSON.stringify(r.out.blocked)}`);
        assert.strictEqual(r.calls.length, 0, `${reason}: zero requests`);
      }
    }
  });

  await test('adjust at the gate: a run-only override (labelled adjusted, even outside the range) and a skip — the file stays byte-identical', async () => {
    const file = VALID_FILE();
    const dir = adoProject({ estimation: file });
    const before = sha(fileBytes(dir));
    const spec = { assignee: 'qa.engineer@example.com', stories: [{ id: 2201, ratings: ratingsFor(file.factors, 0),
      adjust: { 'Exploratory Pass': 6, 'Test Execution': 'skip' } }] };
    const { code, out } = await dryRun(dir, spec, adoCreateRoutes());
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.plan.map((p) => p.title), ['[Testing] Requirement Review', '[Testing] Exploratory Pass']);
    assert.deepStrictEqual(out.estimation.perStory[0].tasks.map((t) => [t.name, t.hours, Boolean(t.adjusted)]),
      [['Requirement Review', 0.5, false], ['Exploratory Pass', 6, true]]);
    assert.strictEqual(sha(fileBytes(dir)), before);
  });

  await test('a hand edit of the file takes effect on the next run, with no prompt and no new proposal', async () => {
    const file = VALID_FILE();
    const dir = adoProject({ estimation: file });
    const first = await dryRun(dir, RATINGS_SPEC(file.factors), adoCreateRoutes());
    const edited = VALID_FILE();
    edited.tasks = [edited.tasks[2], { name: 'Accessibility Check', enabled: true, minHours: 1, maxHours: 2 }, edited.tasks[0]];
    edited.tasks[0].maxHours = 5;
    edited.factors = { 'Scenarios / ACs': 3, 'Accessibility': 1 };
    writeFile(dir, edited);
    const blocked = await dryRun(dir, RATINGS_SPEC(file.factors), adoCreateRoutes());
    assert.strictEqual(blocked.code, 2, 'the old ratings no longer match the edited factors');
    assert.deepStrictEqual(blocked.out.blocked.map((b) => b.reason).sort(), ['missing-rating', 'missing-rating', 'unknown-factor', 'unknown-factor', 'unknown-factor', 'unknown-factor'].sort());
    const r = await dryRun(dir, RATINGS_SPEC(edited.factors), adoCreateRoutes());
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.plan.filter((p) => p.story === 2201).map((p) => p.title),
      ['[Testing] Test Execution', '[Testing] Accessibility Check', '[Testing] Requirement Review']);
    // story 2: score 14/16 = 0.875 → Test Execution 1–5 → 4.5; Accessibility Check 1–2 → 2; Requirement Review 0.5–2 → 2
    assert.deepStrictEqual(r.out.estimation.perStory[1].tasks.map((t) => t.hours), [4.5, 2, 2]);
    assert.notStrictEqual(r.out.estimation.basis, first.out.estimation.basis);
  });

  await test('Jira ratings dry run: sub-task creates with exactly the hours ADO gets for the same file and ratings (Q9)', async () => {
    const file = VALID_FILE();
    const ado = await dryRun(adoProject({ estimation: file }), RATINGS_SPEC(file.factors), adoCreateRoutes());
    const jira = await dryRun(jiraProject({ estimation: file }), RATINGS_SPEC(file.factors, ['PROJ-201', 'PROJ-202']), jiraCreateRoutes());
    assert.strictEqual(jira.code, 0, JSON.stringify(jira.out));
    assert.deepStrictEqual(jira.out.plan.map((p) => [p.title, p.request.body.fields.timetracking.originalEstimate]),
      ado.out.plan.map((p) => [p.title, `${p.request.body.find((op) => op.path === '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate').value}h`]));
    assert.deepStrictEqual(jira.out.estimation.perStory.map((x) => x.tasks), ado.out.estimation.perStory.map((x) => x.tasks));
    assert.deepStrictEqual(jira.calls.filter(isJiraWrite), []);
  });

  // ════ the ratings spec mode — --execute ═══════════════════════════════════
  const isTaskCreate = (c) => c.method === 'POST' && c.url.includes('/workitems/$Task') && !c.url.includes('validateOnly=true');
  async function execute(dir, specFile, routes, basis, { onCall } = {}) {
    const f = fakeFetch(routes, { onCall });
    const r = await run(['--spec', specFile, '--execute', ...(basis === undefined ? [] : ['--basis', basis])], { cwd: dir, fetch: f, now: NOW });
    return { ...r, calls: f.calls };
  }
  async function planThenSpec(dir, spec, routes) {
    const specFile = writeSpec(dir, spec);
    const f = fakeFetch(routes);
    const plan = await run(['--spec', specFile], { cwd: dir, fetch: f, now: NOW });
    assert.strictEqual(plan.code, 0, JSON.stringify(plan.out));
    return { specFile, plan: plan.out };
  }

  await test('--execute without --basis, or with a different one → exit 2, ZERO requests, nothing written', async () => {
    const { dir, proposalFile, est } = await firstRun();
    const { specFile, plan } = await planThenSpec(dir, RATINGS_SPEC(est.content.factors, [2201, 2202], { estimation: { proposalFile } }), adoCreateRoutes());
    for (const [basis, reason] of [[undefined, 'missing-basis'], ['0'.repeat(64), 'basis-mismatch'], [plan.estimation.basis.slice(1), 'basis-mismatch']]) {
      const r = await execute(dir, specFile, adoCreateRoutes(), basis);
      assert.strictEqual(r.code, 2, JSON.stringify(r.out));
      assert.deepStrictEqual(r.out.blocked.map((b) => b.reason), [reason]);
      assert.strictEqual(r.calls.length, 0);
      assert.ok(!fs.existsSync(path.join(dir, FILE)));
    }
  });

  await test('first run, approved: ONE ledger — create-file first (no id), then every task create; the file is exactly the content shown', async () => {
    const { dir, proposalFile, est } = await firstRun();
    const { specFile, plan } = await planThenSpec(dir, RATINGS_SPEC(est.content.factors, [2201, 2202], { estimation: { proposalFile } }), adoCreateRoutes());
    let fileExistedAtFirstCreate = null;
    const r = await execute(dir, specFile, adoCreateRoutes(), plan.estimation.basis, {
      onCall: (c) => { if (isTaskCreate(c) && fileExistedAtFirstCreate === null) fileExistedAtFirstCreate = fs.existsSync(path.join(dir, FILE)); },
    });
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.strictEqual(r.out.ok, true);
    assert.strictEqual(r.out.ledger.length, plan.plan.length, 'one ledger entry per planned write');
    assert.deepStrictEqual(r.out.ledger[0], { step: 'create-file', describe: plan.plan[0].describe, status: 'done' });
    assert.ok(r.out.ledger.slice(1).every((l) => l.step === 'create-task' && l.status === 'done' && l.id));
    assert.strictEqual(fileExistedAtFirstCreate, true, 'the file is written before any task');
    assert.strictEqual(fs.readFileSync(path.join(dir, FILE), 'utf8'), JSON.stringify(plan.estimation.content, null, 2) + '\n');
    assert.strictEqual(r.out.created.file, 'config/estimation.json');
    assert.strictEqual(r.out.created.tasks.length, 8);
    assert.strictEqual(r.calls.filter(isTaskCreate).length, 8);
  });

  await test('a hand edit between the dry run and --execute → basis-mismatch, exit 2, zero writes', async () => {
    const file = VALID_FILE();
    const dir = adoProject({ estimation: file });
    const { specFile, plan } = await planThenSpec(dir, RATINGS_SPEC(file.factors), adoCreateRoutes());
    const edited = VALID_FILE(); edited.tasks[1].maxHours = 4;
    writeFile(dir, edited);
    const r = await execute(dir, specFile, adoCreateRoutes(), plan.estimation.basis);
    assert.strictEqual(r.code, 2, JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.blocked.map((b) => b.reason), ['basis-mismatch']);
    assert.strictEqual(r.calls.length, 0);
  });

  await test('the file appeared after the dry run → estimation-file-exists, exit 2, zero writes, the file untouched', async () => {
    const { dir, proposalFile, est } = await firstRun();
    const { specFile, plan } = await planThenSpec(dir, RATINGS_SPEC(est.content.factors, [2201, 2202], { estimation: { proposalFile } }), adoCreateRoutes());
    const theirs = JSON.stringify(VALID_FILE(), null, 2) + '\n';
    writeFile(dir, theirs);
    const r = await execute(dir, specFile, adoCreateRoutes(), plan.estimation.basis);
    assert.strictEqual(r.code, 2, JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.blocked.map((b) => b.reason), ['estimation-file-exists']);
    assert.strictEqual(r.calls.length, 0);
    assert.strictEqual(fs.readFileSync(path.join(dir, FILE), 'utf8'), theirs);
  });

  await test('RACE: the file appears while the validation reads run → create-file fails (not replaced), every task not-attempted, zero task requests', async () => {
    const { dir, proposalFile, est } = await firstRun();
    const { specFile, plan } = await planThenSpec(dir, RATINGS_SPEC(est.content.factors, [2201, 2202], { estimation: { proposalFile } }), adoCreateRoutes());
    const theirs = '{"written": "by someone else"}\n';
    const r = await execute(dir, specFile, adoCreateRoutes(), plan.estimation.basis, {
      onCall: (c) => { if (c.url.includes('/wit/workitems/2201?') && !fs.existsSync(path.join(dir, FILE))) writeFile(dir, theirs); },
    });
    assert.strictEqual(r.code, 1, JSON.stringify(r.out));
    assert.strictEqual(r.out.ok, false);
    assert.deepStrictEqual(r.out.ledger[0], { step: 'create-file', describe: plan.plan[0].describe, status: 'failed',
      reason: "config/estimation.json appeared after this run's checks — not replaced" });
    assert.ok(r.out.ledger.slice(1).every((l) => l.status === 'not-attempted'));
    assert.strictEqual(r.calls.filter(isTaskCreate).length, 0, 'no task request is sent — the board is untouched');
    assert.strictEqual(fs.readFileSync(path.join(dir, FILE), 'utf8'), theirs, 'the file that appeared is never replaced');
    assert.deepStrictEqual(r.out.created, { tasks: [], file: null });
  });

  await test('a task create fails after the file was written: exact ledger, the file stays (it is what the user approved)', async () => {
    const { dir, proposalFile, est } = await firstRun();
    const { specFile, plan } = await planThenSpec(dir, RATINGS_SPEC(est.content.factors, [2201, 2202], { estimation: { proposalFile } }), adoCreateRoutes());
    let creates = 0;
    const failing = [{ method: 'POST', match: '/workitems/$Task', respond: () => (++creates === 2 ? { status: 500, text: JSON.stringify({ message: 'server exploded' }) } : { json: { id: 9100 + creates } }) }];
    const r = await execute(dir, specFile, adoCreateRoutes(failing), plan.estimation.basis);
    assert.strictEqual(r.code, 1, JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.ledger.map((l) => l.status), ['done', 'done', 'failed', ...Array(6).fill('not-attempted')]);
    assert.strictEqual(r.out.ledger[0].id, undefined, 'the file line never carries a tracker id');
    assert.match(r.out.ledger[2].reason, /server exploded/);
    assert.deepStrictEqual(r.out.created, { tasks: [{ id: 9101, url: r.out.created.tasks[0].url, storyId: 2201, title: '[Testing] Requirement Review' }], file: 'config/estimation.json' });
    assert.strictEqual(fs.readFileSync(path.join(dir, FILE), 'utf8'), JSON.stringify(plan.estimation.content, null, 2) + '\n');
  });

  await test('with the file present: no create-file intent, created.file null; a run-only adjust leaves the file byte-identical', async () => {
    const file = VALID_FILE();
    const dir = adoProject({ estimation: file });
    const before = sha(fileBytes(dir));
    const spec = { assignee: 'qa.engineer@example.com', stories: [{ id: 2201, ratings: ratingsFor(file.factors, 4), adjust: { 'Test Execution': 1.5 } }] };
    const { specFile, plan } = await planThenSpec(dir, spec, adoCreateRoutes());
    const r = await execute(dir, specFile, adoCreateRoutes(), plan.estimation.basis);
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.ok(r.out.ledger.every((l) => l.step === 'create-task'));
    assert.strictEqual(r.out.created.file, null);
    const hours = r.calls.filter(isTaskCreate).map((c) => JSON.parse(c.body).find((op) => op.path === '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate').value);
    assert.deepStrictEqual(hours, [2, 3, 1.5], 'all-4 → each max; the adjusted task carries the run-only value');
    assert.strictEqual(sha(fileBytes(dir)), before);
  });

  await test('the same file and ratings give identical hours on an ADO and a Jira project (--execute)', async () => {
    const file = VALID_FILE();
    const adoDir = adoProject({ estimation: file });
    const a = await planThenSpec(adoDir, RATINGS_SPEC(file.factors), adoCreateRoutes());
    const ado = await execute(adoDir, a.specFile, adoCreateRoutes(), a.plan.estimation.basis);
    const jiraDir = jiraProject({ estimation: file });
    const j = await planThenSpec(jiraDir, RATINGS_SPEC(file.factors, ['PROJ-201', 'PROJ-202']), jiraCreateRoutes());
    const jira = await execute(jiraDir, j.specFile, jiraCreateRoutes(), j.plan.estimation.basis);
    assert.strictEqual(ado.code, 0, JSON.stringify(ado.out));
    assert.strictEqual(jira.code, 0, JSON.stringify(jira.out));
    const adoHours = ado.calls.filter(isTaskCreate).map((c) => JSON.parse(c.body).find((op) => op.path === '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate').value);
    const jiraHours = jira.calls.filter((c) => c.method === 'POST' && /\/rest\/api\/3\/issue$/.test(c.url))
      .map((c) => Number(JSON.parse(c.body).fields.timetracking.originalEstimate.replace('h', '')));
    assert.deepStrictEqual(jiraHours, adoHours);
    assert.deepStrictEqual(adoHours, [0.5, 1, 1, 1.5, 2.5, 2.5]);
    assert.strictEqual(j.plan.estimation.basis.length, 64);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
