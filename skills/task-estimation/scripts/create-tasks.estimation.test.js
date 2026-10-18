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

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
