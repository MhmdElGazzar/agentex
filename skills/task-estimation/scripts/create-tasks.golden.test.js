'use strict';
// Golden (characterization) suite for create-tasks.js — recorded ONCE from the
// unmodified script at 319619c, before any refactor, and never re-recorded.
// Every case pins, byte for byte: JSON.stringify(out), the exit code, and the
// ordered request sequence the script sent to the fake fetch (method, url, body).
//
// Self-contained on purpose: it imports only node: modules and ./create-tasks.js
// `run` — its own fake fetch and fixtures (copied from create-tasks.test.js, not
// imported), so a later edit to the unit test or to any module this delivery
// touches can never move an expectation.
//
// Run (check mode, the default):  node skills/task-estimation/scripts/create-tasks.golden.test.js
// Record missing expectations:    GOLDEN_RECORD=1 node skills/task-estimation/scripts/create-tasks.golden.test.js
//   Record mode writes ONLY missing files and never overwrites one. In check
//   mode a missing expected file is a FAIL, never a skip; so is an expected
//   file with no case.
//
// Normalization — exactly two substitutions, nothing else (design R6 / DA-1):
//   (1) the case's temp project dir inside any string value -> "<CWD>" (the
//       remainder of that path with path.sep -> "/");
//   (2) the value under any key named "builtAt" -> "<BUILT_AT>".
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./create-tasks.js');

const GOLDEN_DIR = path.join(__dirname, 'golden');
const RECORD = process.env.GOLDEN_RECORD === '1';

let passed = 0; const failures = []; const recorded = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// ── environment hygiene ──────────────────────────────────────────────────────
for (const k of Object.keys(process.env)) {
  if (k.startsWith('AZURE_') || k.startsWith('JIRA_') || k === 'AGENTEX_CI') delete process.env[k];
}

const SENTINEL_PAT = 'SENTINEL-PAT-golden-00112233445566778899';
const SENTINEL_JT = 'SENTINEL-JIRA-TOKEN-golden-22334455';

// ── fake fetch ───────────────────────────────────────────────────────────────
// Route: { method='GET', match: urlSubstring, bodyMatch?, status?, json?, text?,
//          seq?: [response…] (nth match -> nth entry, the last repeats),
//          respond?: (call, n) => response }.
// Unmatched requests answer 200 '{}' and are still recorded.
function fakeFetch(routes) {
  const calls = [];
  const hits = new Map();
  const fn = async (url, opts = {}) => {
    const call = { method: opts.method || 'GET', url: String(url), body: opts.body === undefined ? null : opts.body };
    calls.push(call);
    for (const r of routes) {
      if ((r.method || 'GET') !== call.method) continue;
      if (!call.url.includes(r.match)) continue;
      if (r.bodyMatch && !(typeof call.body === 'string' && call.body.includes(r.bodyMatch))) continue;
      const n = (hits.get(r) || 0) + 1; hits.set(r, n);
      let resp = r;
      if (r.seq) resp = r.seq[Math.min(n, r.seq.length) - 1];
      if (r.respond) resp = r.respond(call, n);
      const status = resp.status || 200;
      const json = typeof resp.json === 'function' ? resp.json(call, n) : resp.json;
      const text = resp.text !== undefined ? resp.text : JSON.stringify(json ?? {});
      return { ok: status < 300, status, text: async () => text };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

// ── normalization ────────────────────────────────────────────────────────────
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normalizer(dir) {
  const re = new RegExp(escRe(dir) + '([^\\s"\']*)', 'g');
  const str = (s) => s.replace(re, (_, rest) => '<CWD>' + rest.split(path.sep).join('/'));
  const walk = (v) => {
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = k === 'builtAt' ? '<BUILT_AT>' : walk(val);
      return o;
    }
    return v;
  };
  return walk;
}

// ── shared fixtures ──────────────────────────────────────────────────────────
// Varied estimates so a task→estimate mix-up shows as a byte diff.
const FIVE_TASKS = [
  { title: '[Testing] Requirement Review', estimate: 1 },
  { title: '[Testing] Test Creation', estimate: 2 },
  { title: '[Testing] Test Execution', estimate: 3 },
  { title: '[Testing] Bug Review and Retest', estimate: 1.5 },
  { title: '[Testing] Automation', estimate: 0.5 },
];

// ── ADO fixtures ─────────────────────────────────────────────────────────────
const AZ = { org: 'exampleorg', project: 'Sample Project', team: 'Sample Team', assignee: 'qa.engineer@example.com' };
const STORY = (id, extra = {}, fields = {}) => ({
  id,
  fields: {
    'System.WorkItemType': 'User Story',
    'System.Title': `Story ${id}`,
    'System.State': 'Active',
    'Microsoft.VSTS.Scheduling.StoryPoints': 3,
    'System.IterationPath': 'Sample Project\\Sprint 9',
    'System.AreaPath': 'Sample Project\\Team Area',
    'System.Description': `<div>desc ${id}</div>`,
    'Microsoft.VSTS.Common.AcceptanceCriteria': `<div>ACs ${id}</div>`,
    ...fields,
  },
  ...extra,
});
const REL = (rel, id) => ({ rel, url: `https://dev.azure.com/exampleorg/_apis/wit/workItems/${id}` });
const STORY_101 = STORY(101);
const STORY_102 = STORY(102, {
  relations: [
    REL('System.LinkTypes.Hierarchy-Forward', 555),
    REL('System.LinkTypes.Hierarchy-Forward', 556),
    { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/exampleorg/_apis/wit/workItems/not-a-number' },
    REL('System.LinkTypes.Hierarchy-Reverse', 9),
  ],
});
const STORY_103 = STORY(103, {}, { 'Microsoft.VSTS.Scheduling.StoryPoints': undefined, 'System.AreaPath': undefined });
const BUG_101 = { id: 101, fields: { 'System.WorkItemType': 'Bug', 'System.Title': 'A bug', 'System.State': 'New' } };
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
const TASK_FIELDS_LIVE_CHANGED = { value: [{ referenceName: 'Microsoft.VSTS.Common.Activity', allowedValues: ['QA-Verification'] }] };

function adoRoutes(extra = []) {
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
const ADO_SPEC = {
  assignee: 'qa.engineer@example.com',
  stories: [
    { id: 101, complexity: 'Simple', iterationPath: 'WRONG\\FromSpec', areaPath: 'WRONG\\FromSpec', tasks: FIVE_TASKS },
    { id: 103, complexity: 'Medium', tasks: FIVE_TASKS },
  ],
};
const ADO_CACHE = (types) => ({
  schemaVersion: 1, provider: 'ado', org: 'https://dev.azure.com/exampleorg', project: 'Sample Project',
  apiVersion: '7.1', builtAt: '2026-08-25T09:00:00Z', types,
});
const seedCache = (provider, content) => (dir) => {
  const file = path.join(dir, '.agentex', 'cache', `tracker-fields-${provider}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(content));
};

// ── Jira fixtures ────────────────────────────────────────────────────────────
const JI = { site: 'example', project: 'PROJ', assignee: 'qa.engineer@example.com' };
const ALL_FIELDS = [
  { id: 'summary', name: 'Summary' },
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
const SUBTASK_META_NO_TT = { total: 4, fields: SUBTASK_META.fields.filter((x) => x.fieldId !== 'timetracking') };
const J_USER = { accountId: 'acc-123', emailAddress: 'qa.engineer@example.com', displayName: 'QA Engineer' };
const S7 = { id: 7, name: 'Sprint 7', state: 'active' };
const S8 = { id: 8, name: 'Sprint 8', state: 'active' };
const JSTORY = (key, { sprints, subtasks = [], type = 'Story', fields = {}, rendered = {} } = {}) => ({
  key,
  fields: {
    issuetype: { name: type },
    summary: `Story ${key}`,
    status: { name: 'In Progress' },
    customfield_10016: 3,
    customfield_10020: sprints || [S7],
    subtasks,
    ...fields,
  },
  renderedFields: { description: `<div>desc ${key}</div>`, ...rendered },
});
const JSTORY_1 = JSTORY('PROJ-1');
const JSTORY_2 = JSTORY('PROJ-2', {
  subtasks: [
    { key: 'PROJ-55', fields: { summary: '[Testing] Test Execution', status: { name: 'To Do' } } },
    { key: 'PROJ-56', fields: { summary: 'Implement the API', status: { name: 'To Do' } } },
    { key: 'PROJ-57', fields: { summary: '[Testing] Automation' } },
  ],
});
const JSTORY_3 = JSTORY('PROJ-3', { fields: { customfield_10016: null } });
const JSTORY_9 = JSTORY('PROJ-9', { sprints: [S8] });
const TWO_SPRINTS = [
  JSTORY('PROJ-9', { sprints: [{ id: 6, name: 'Sprint 6', state: 'closed' }, S8] }),
  JSTORY('PROJ-1', { sprints: [S7] }),
  JSTORY('PROJ-3', { sprints: [S8] }),
];

function jiraRoutes(extra = []) {
  let created = 100;
  return [
    ...extra,
    { match: '/rest/api/3/field', json: ALL_FIELDS },
    { method: 'POST', match: '/search/jql', json: { issues: [JSTORY_1, JSTORY_3] } },
    { match: '/rest/api/3/issue/PROJ-1?', json: JSTORY_1 },
    { match: '/rest/api/3/issue/PROJ-2?', json: JSTORY_2 },
    { match: '/rest/api/3/issue/PROJ-3?', json: JSTORY_3 },
    { match: '/rest/api/3/issue/PROJ-9?', json: JSTORY_9 },
    { match: '/issue/createmeta/PROJ/issuetypes/10002', json: SUBTASK_META },
    { match: '/issue/createmeta/PROJ/issuetypes', json: J_ISSUE_TYPES },
    { match: '/rest/api/3/user/search', json: [J_USER] },
    { method: 'POST', match: '/rest/api/3/issue', json: () => ({ key: `PROJ-${++created}` }) },
  ];
}
const JIRA_SPEC = {
  assignee: 'qa.engineer@example.com',
  stories: [
    { id: 'PROJ-1', complexity: 'Simple', tasks: FIVE_TASKS },
    { id: 'PROJ-3', complexity: 'Medium', tasks: FIVE_TASKS },
  ],
};
const SAMPLE_77 = { method: 'POST', match: '/search/jql', bodyMatch: 'ORDER BY created DESC', json: { issues: [{ key: 'PROJ-77' }] } };
const NO_TT_CREATE = { match: '/issue/createmeta/PROJ/issuetypes/10002', json: SUBTASK_META_NO_TT };
const EDIT_WITH_TT = { match: '/issue/PROJ-77/editmeta', json: { fields: { timetracking: { name: 'Time tracking' }, summary: { name: 'Summary' } } } };
const EDIT_WITHOUT_TT = { match: '/issue/PROJ-77/editmeta', json: { fields: { summary: { name: 'Summary' }, labels: { name: 'Labels' } } } };
const BOARDS = (values) => ({ match: '/rest/agile/1.0/board?projectKeyOrId=', json: { values } });
const BOARD_SPRINTS = (id, values) => ({ match: `/rest/agile/1.0/board/${id}/sprint`, json: { values } });
const TWO_SPRINT_SEARCH = { method: 'POST', match: '/search/jql', json: { issues: TWO_SPRINTS } };

// ── case builders ────────────────────────────────────────────────────────────
// argv placeholders: {SPEC} -> <dir>/spec.json, {DIR} -> <dir>.
const ado = (id, argv, o = {}) => ({
  id, provider: 'ado', argv,
  config: o.config || { azure: { ...AZ, ...(o.azure || {}) } },
  env: `AZURE_PAT=${SENTINEL_PAT}\n`,
  spec: o.spec, setup: o.setup,
  routes: () => adoRoutes(o.extra || []),
});
const jira = (id, argv, o = {}) => ({
  id, provider: 'jira', argv,
  config: o.config || { jira: { ...JI, ...(o.jira || {}) } },
  env: `JIRA_EMAIL=qa.engineer@example.com\nJIRA_API_TOKEN=${SENTINEL_JT}\n`,
  spec: o.spec, setup: o.setup,
  routes: () => jiraRoutes(o.extra || []),
});
const adoSpec = (over = {}) => ({ ...ADO_SPEC, ...over });
const jiraSpec = (over = {}) => ({ ...JIRA_SPEC, ...over });
const SPEC = ['--spec', '{SPEC}'];

const CASES = [
  // ════ ADO, stories ═════════════════════════════════════════════════════════
  ado('A01', ['stories', '--current-sprint']),
  ado('A01b', ['stories', '--current-sprint'], { extra: [{ method: 'POST', match: '/wiql', json: { workItems: [] } }] }),
  ado('A02', ['stories', '--current-sprint', '--team', "QA 'A' Team"], { azure: { project: "O'Neil Project" } }),
  ado('A03', ['stories', '--current-sprint'], { azure: { team: undefined } }),
  ado('A04', ['stories', '--ids', '101,103']),
  ado('A05', ['stories', '--ids', '101, 102', '--full']),
  ado('A06', ['stories', '--ids', '101'], { extra: [{ match: '/wit/workitems/101?', json: BUG_101 }] }),
  ado('A07', ['stories', '--ids', '102'], { extra: [{ match: '/wit/workitems/555?', status: 500, text: 'boom' }] }),
  ado('A08', ['stories', '--ids', '101,103'], { extra: [{ match: '/wit/workitems/101?', status: 404, text: JSON.stringify({ message: 'TF401232: Work item 101 does not exist' }) }] }),
  ado('A09', ['stories', '--ids', '102'], { extra: [
    { match: '/wit/workitems/102?', json: { ...STORY_102, fields: { ...STORY_102.fields, 'System.WorkItemType': 'Feature' } } },
    { match: '/wit/workitems/555?', status: 500, text: JSON.stringify({ message: 'child read failed' }) },
  ] }),
  ado('A10', ['stories', '--ids', '101'], { extra: [{ match: '/wit/workitems/101?', text: '' }] }),
  ado('A11', ['stories']),
  ado('A12', ['stories', '--current-sprint'], { extra: [{ method: 'POST', match: '/wiql', status: 401, text: 'unauthorized' }] }),

  // ════ ADO, dry run ═════════════════════════════════════════════════════════
  ado('A13', SPEC, { spec: adoSpec() }),
  ado('A14', SPEC, { spec: adoSpec({ assignee: undefined }) }),
  ado('A15', SPEC, { azure: { assignee: undefined }, spec: adoSpec({ assignee: '' }) }),
  ado('A16', SPEC, { azure: { assignee: 'a@example.com, b@example.com' }, spec: adoSpec({ assignee: undefined }) }),
  ado('A17', SPEC, { spec: adoSpec({ stories: [{ id: 101, tasks: [{ title: 'Test Creation', estimate: 1 }, { estimate: 2 }] }] }) }),
  ado('A18', SPEC, { spec: adoSpec({ stories: [{ id: 101, tasks: [{ title: '[Testing] A', estimate: '2h' }, { title: '[Testing] B', estimate: 0 }, { title: '[Testing] C' }] }] }) }),
  ado('A19', SPEC, { spec: adoSpec(), extra: [{ match: '/wit/workitems/101?', json: BUG_101 }] }),
  ado('A20', SPEC, { spec: adoSpec(), extra: [{ match: '/wit/workitems/101?', status: 404, text: JSON.stringify({ message: 'TF401232: Work item 101 does not exist' }) }] }),
  ado('A21', SPEC, { spec: adoSpec({ stories: [{ id: 102, complexity: 'Complex', tasks: FIVE_TASKS }] }) }),
  ado('A22', [...SPEC, '--allow-existing'], { spec: adoSpec({ stories: [{ id: 102, complexity: 'Complex', tasks: FIVE_TASKS }] }) }),
  ado('A23', [...SPEC, '--allow-existing'], { spec: adoSpec({ stories: [{ id: 102, tasks: FIVE_TASKS }] }), extra: [{ match: '/wit/workitems/555?', status: 500, text: 'boom' }] }),
  ado('A24', SPEC, { spec: adoSpec(), extra: [{ match: '/wit/workitemtypes/Task/fields', json: { value: TASK_FIELDS.value.filter((f) => f.referenceName !== 'Microsoft.VSTS.Scheduling.OriginalEstimate') } }] }),
  ado('A25', SPEC, { spec: adoSpec(), extra: [{ match: '/wit/workitemtypes/Task/fields', json: { value: TASK_FIELDS.value.map((f) => (f.referenceName === 'Microsoft.VSTS.Common.Activity' ? { ...f, allowedValues: ['Development', 'Design'] } : f)) } }] }),
  ado('A26', SPEC, { spec: adoSpec(), extra: [{ match: '/wit/workitemtypes/Task/fields', status: 500, text: JSON.stringify({ message: 'fields unavailable' }) }] }),
  ado('A27', SPEC, { spec: adoSpec(), extra: [
    { method: 'POST', match: 'validateOnly=true', status: 400, text: JSON.stringify({ message: 'The field Activity has an invalid value Testing' }) },
    { match: '/wit/workitemtypes/Task/fields', seq: [{ json: TASK_FIELDS }, { json: TASK_FIELDS_LIVE_CHANGED }] },
  ] }),
  ado('A28a', SPEC, { spec: adoSpec(), extra: [
    { method: 'POST', match: 'validateOnly=true', status: 400, text: JSON.stringify({ message: 'TF401320: Rule error for field Assigned To' }) },
  ] }),
  ado('A28b', SPEC, { spec: adoSpec(), extra: [
    { method: 'POST', match: 'validateOnly=true', status: 400, text: 'not json' },
    { match: '/wit/workitemtypes/Task/fields', seq: [{ json: TASK_FIELDS }, { status: 503, text: 'unavailable' }] },
  ] }),
  ado('A29a', SPEC, { spec: adoSpec(), setup: seedCache('ado', ADO_CACHE({ Bug: { fields: { 'System.Title': { required: true } } } })) }),
  ado('A29b', [...SPEC, '--refresh-fields'], { spec: adoSpec(), setup: seedCache('ado', ADO_CACHE({ Task: { fields: { 'System.Title': { required: true } } } })) }),
  ado('A29c', SPEC, { spec: adoSpec(), setup: seedCache('ado', ADO_CACHE({
    Task: { fields: Object.fromEntries(TASK_FIELDS.value.map((f) => [f.referenceName, { ...(f.allowedValues ? { allowedValues: f.allowedValues } : {}), required: Boolean(f.alwaysRequired) }])) },
  })) }),
  ado('A30', SPEC, {
    azure: { assignee: undefined },
    spec: adoSpec({ assignee: undefined, stories: [{ id: 101, tasks: [{ title: 'No prefix', estimate: -1 }] }, { id: 103, tasks: FIVE_TASKS }] }),
    extra: [{ match: '/wit/workitems/101?', json: BUG_101 }],
  }),
  ado('A31', SPEC, { spec: adoSpec(), extra: [{ match: '/wit/workitems/101?', text: '' }] }),

  // ════ spine paths (once, on an ADO project) ═══════════════════════════════
  ado('A32', []),
  ado('A33', ['--spec', '{DIR}/nope.json']),
  ado('A34a', SPEC, { spec: { assignee: 'qa.engineer@example.com', stories: [] } }),
  ado('A34b', SPEC, { spec: { assignee: 'qa.engineer@example.com', stories: [{ tasks: FIVE_TASKS }, { id: '', tasks: FIVE_TASKS }] } }),
  ado('A34c', SPEC, { spec: { assignee: 'qa.engineer@example.com', stories: [{ id: 101, tasks: [] }, { id: 103 }] } }),
  ado('A35', SPEC, { config: {}, spec: adoSpec() }),
  ado('A35b', ['stories', '--current-sprint'], { config: {} }),
  ado('A36', SPEC, { config: { azure: AZ, jira: JI }, spec: adoSpec() }),

  // ════ ADO, --execute ═══════════════════════════════════════════════════════
  ado('A37', [...SPEC, '--execute'], { spec: adoSpec() }),
  ado('A38', [...SPEC, '--execute'], { spec: adoSpec(), extra: [
    { method: 'POST', match: '/workitems/$Task', respond: (call, n) => (n === 3
      ? { status: 500, text: JSON.stringify({ message: 'server exploded' }) }
      : { json: { id: 9000 + n, _links: { html: { href: `https://dev.azure.com/exampleorg/Sample%20Project/_workitems/edit/${9000 + n}` } } } }) },
  ] }),
  ado('A39', [...SPEC, '--execute'], { spec: adoSpec({ stories: [{ id: 102, tasks: FIVE_TASKS }] }) }),

  // ════ Jira, stories ════════════════════════════════════════════════════════
  jira('J01', ['stories', '--current-sprint', '--full']),
  jira('J01b', ['stories', '--current-sprint'], { extra: [
    { match: '/rest/api/3/field', json: [{ id: 'customfield_10016', name: 'Story Points' }] },
    TWO_SPRINT_SEARCH,
  ] }),
  jira('J02', ['stories', '--ids', 'PROJ-2']),
  jira('J03', ['stories', '--ids', 'PROJ-1'], { extra: [{ match: '/rest/api/3/field', json: [{ id: 'customfield_10020', name: 'Sprint' }] }] }),
  jira('J04', ['stories', '--ids', 'PROJ-1'], { extra: [{ match: '/rest/api/3/field', json: [...ALL_FIELDS, { id: 'customfield_10030', name: 'Story point estimate' }] }] }),
  jira('J05a', ['stories', '--ids', 'PROJ-1'], { jira: { storyPointsField: 'Story point estimate' }, extra: [
    { match: '/rest/api/3/field', json: [...ALL_FIELDS, { id: 'customfield_10030', name: 'Story point estimate' }] },
    { match: '/rest/api/3/issue/PROJ-1?', json: JSTORY('PROJ-1', { fields: { customfield_10030: 5 } }) },
  ] }),
  jira('J05b', ['stories', '--ids', 'PROJ-1'], { jira: { storyPointsField: 'customfield_10031' }, extra: [
    { match: '/rest/api/3/issue/PROJ-1?', json: JSTORY('PROJ-1', { fields: { customfield_10031: 8 } }) },
  ] }),
  jira('J06', ['stories', '--ids', 'PROJ-1'], { extra: [{ match: '/rest/api/3/field', status: 500, text: JSON.stringify({ errorMessages: ['fields down'] }) }] }),
  jira('J07', ['stories', '--current-sprint'], { extra: [TWO_SPRINT_SEARCH] }),
  jira('J08', ['stories', '--current-sprint', '--sprint', ' Sprint 8 '], { extra: [TWO_SPRINT_SEARCH] }),
  jira('J08b', ['stories', '--current-sprint', '--sprint', '7']),
  jira('J09', ['stories', '--current-sprint'], { jira: { board: '42' }, extra: [
    TWO_SPRINT_SEARCH, BOARD_SPRINTS(42, [S8]), BOARDS([{ id: 41, name: 'Other board' }, { id: 42, name: 'PROJ board' }]),
  ] }),
  jira('J09b', ['stories', '--current-sprint'], { jira: { board: '42' } }),
  jira('J09c', ['stories', '--current-sprint'], { jira: { board: '42' }, extra: [
    TWO_SPRINT_SEARCH, BOARD_SPRINTS(42, [S8]), BOARD_SPRINTS(7, [S7]),
    BOARDS([{ id: 7, name: '42' }, { id: 42, name: 'Team board' }]),
  ] }),
  jira('J10', ['stories', '--current-sprint'], { jira: { board: 'Nope board' }, extra: [
    TWO_SPRINT_SEARCH, BOARDS([{ id: 42, name: 'PROJ board' }, { id: 43, name: 'Other board' }]),
  ] }),
  jira('J10a', ['stories', '--current-sprint'], { jira: { board: 'Nope board' }, extra: [TWO_SPRINT_SEARCH, BOARDS([])] }),
  jira('J10b', ['stories', '--current-sprint'], { jira: { board: '42' }, extra: [
    TWO_SPRINT_SEARCH, { match: '/rest/agile/1.0/board?projectKeyOrId=', status: 401, text: JSON.stringify({ errorMessages: ['Unauthorized'] }) },
  ] }),
  jira('J11', ['stories', '--current-sprint'], { jira: { board: 'PROJ board' }, extra: [
    TWO_SPRINT_SEARCH, BOARD_SPRINTS(42, [S8, S7]), BOARDS([{ id: 42, name: 'PROJ board' }]),
  ] }),
  jira('J11b', ['stories', '--current-sprint'], { jira: { board: '42' }, extra: [
    TWO_SPRINT_SEARCH, BOARD_SPRINTS(42, []), BOARDS([{ id: 42, name: 'PROJ board' }]),
  ] }),
  jira('J12a', ['stories', '--current-sprint'], { extra: [{ method: 'POST', match: '/search/jql', json: { issues: [] } }] }),
  jira('J12b', ['stories', '--current-sprint', '--sprint', 'Sprint 99'], { extra: [TWO_SPRINT_SEARCH] }),
  jira('J12c', ['stories', '--current-sprint'], { extra: [{ method: 'POST', match: '/search/jql', status: 401, text: JSON.stringify({ errorMessages: ['Unauthorized'] }) }] }),
  jira('J13a', ['stories', '--ids', 'PROJ-1', '--full']),
  jira('J13b', ['stories', '--ids', 'PROJ-1,PROJ-3', '--full'], { jira: { acceptanceCriteriaField: 'customfield_10050' }, extra: [
    { match: '/rest/api/3/issue/PROJ-1?', json: JSTORY('PROJ-1', { rendered: { customfield_10050: '<p>AC one</p>' } }) },
  ] }),
  jira('J14', ['stories', '--ids', 'PROJ-1'], { extra: [{ match: '/rest/api/3/issue/PROJ-1?', json: JSTORY('PROJ-1', { type: 'Task' }) }] }),
  jira('J15', ['stories', '--ids', 'PROJ-1'], { extra: [{ match: '/rest/api/3/issue/PROJ-1?', json: JSTORY('PROJ-1', { fields: { subtasks: undefined } }) }] }),
  jira('J15b', ['stories', '--ids', 'PROJ-1'], { extra: [{ match: '/rest/api/3/issue/PROJ-1?', json: JSTORY('PROJ-1', { type: 'Task', fields: { subtasks: undefined } }) }] }),
  jira('J16', ['stories', '--ids', 'PROJ-1,PROJ-3'], { extra: [{ match: '/rest/api/3/issue/PROJ-1?', status: 404, text: JSON.stringify({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }) }] }),
  jira('J17', ['stories', '--ids', 'PROJ-1'], { extra: [{ match: '/rest/api/3/issue/PROJ-1?', text: '' }] }),
  jira('J18', ['stories']),

  // ════ Jira, dry run ════════════════════════════════════════════════════════
  jira('J19', SPEC, { spec: jiraSpec() }),
  jira('J20', SPEC, { spec: jiraSpec(), extra: [NO_TT_CREATE, SAMPLE_77, EDIT_WITH_TT] }),
  jira('J21', SPEC, { spec: jiraSpec(), extra: [NO_TT_CREATE, SAMPLE_77, EDIT_WITHOUT_TT] }),
  jira('J22', SPEC, { spec: jiraSpec(), extra: [NO_TT_CREATE, { method: 'POST', match: '/search/jql', bodyMatch: 'ORDER BY created DESC', json: { issues: [] } }] }),
  jira('J23', SPEC, { spec: jiraSpec(), extra: [NO_TT_CREATE, { method: 'POST', match: '/search/jql', bodyMatch: 'ORDER BY created DESC', status: 400, text: JSON.stringify({ errorMessages: ['bad jql'] }) }] }),
  jira('J24', SPEC, { spec: jiraSpec(), extra: [NO_TT_CREATE, SAMPLE_77, { match: '/issue/PROJ-77/editmeta', status: 403, text: JSON.stringify({ errorMessages: ['no edit permission'] }) }] }),
  jira('J25', SPEC, { jira: { assignee: undefined }, spec: jiraSpec({ assignee: '' }) }),
  jira('J26', SPEC, { jira: { assignee: 'a@example.com, b@example.com' }, spec: jiraSpec({ assignee: undefined }) }),
  jira('J27', SPEC, { spec: jiraSpec(), extra: [{ match: '/rest/api/3/user/search', json: [] }] }),
  jira('J28', SPEC, { spec: jiraSpec(), extra: [{ match: '/rest/api/3/user/search', json: [
    { accountId: 'acc-1', displayName: 'QA One' }, { accountId: 'acc-2', displayName: 'QA Two' },
  ] }] }),
  jira('J28b', SPEC, { spec: jiraSpec({ assignee: 'QA.Engineer@Example.com' }), extra: [{ match: '/rest/api/3/user/search', json: [
    { accountId: 'acc-9', emailAddress: 'other@example.com', displayName: 'Other' }, J_USER,
  ] }] }),
  jira('J29', SPEC, { spec: jiraSpec(), extra: [{ match: '/rest/api/3/user/search', status: 500, text: JSON.stringify({ errorMessages: ['search down'] }) }] }),
  jira('J30', SPEC, { spec: jiraSpec({ stories: [{ id: 'PROJ-1', tasks: [{ title: 'Test Creation', estimate: 1 }, { title: null, estimate: 1 }] }] }) }),
  jira('J31', SPEC, { spec: jiraSpec({ stories: [{ id: 'PROJ-1', tasks: [{ title: '[Testing] A', estimate: '2h' }, { title: '[Testing] B', estimate: 0 }, { title: '[Testing] C', estimate: null }] }] }) }),
  jira('J32', SPEC, { spec: jiraSpec(), extra: [{ match: '/issue/createmeta/PROJ/issuetypes?', status: 500, text: JSON.stringify({ errorMessages: ['createmeta down'] }) }] }),
  jira('J33', SPEC, { jira: { subtaskType: 'QA Sub-task' }, spec: jiraSpec() }),
  jira('J34', SPEC, { jira: { subtaskType: 'sub-task' }, spec: jiraSpec() }),
  jira('J35', SPEC, { spec: jiraSpec(), extra: [{ match: '/issue/createmeta/PROJ/issuetypes?', json: { issueTypes: [{ id: '10001', name: 'Story', subtask: false }, { id: '10003', name: 'Bug', subtask: false }] } }] }),
  jira('J36', SPEC, { spec: jiraSpec(), extra: [
    { match: '/issue/createmeta/PROJ/issuetypes?', json: { issueTypes: [...J_ISSUE_TYPES.issueTypes, { id: '10009', name: 'QA Sub-task', subtask: true }] } },
  ] }),
  jira('J37', SPEC, { spec: jiraSpec(), extra: [{ match: '/rest/api/3/issue/PROJ-1?', json: JSTORY('PROJ-1', { type: 'Task' }) }] }),
  jira('J38', SPEC, { spec: jiraSpec(), extra: [{ match: '/rest/api/3/issue/PROJ-1?', json: JSTORY('PROJ-1', { fields: { subtasks: undefined } }) }] }),
  jira('J39', SPEC, { spec: jiraSpec({ stories: [{ id: 'PROJ-2', complexity: 'Complex', tasks: FIVE_TASKS }] }) }),
  jira('J40', [...SPEC, '--allow-existing'], { spec: jiraSpec({ stories: [{ id: 'PROJ-2', complexity: 'Complex', tasks: FIVE_TASKS }] }) }),
  jira('J41', SPEC, { spec: jiraSpec(), extra: [{ match: '/rest/api/3/issue/PROJ-1?', status: 404, text: JSON.stringify({ errorMessages: ['Issue does not exist'] }) }] }),
  jira('J42', SPEC, { spec: jiraSpec(), extra: [{ match: '/issue/createmeta/PROJ/issuetypes/10002', json: { total: 2, fields: SUBTASK_META.fields.filter((x) => ['summary', 'timetracking'].includes(x.fieldId)) } }] }),
  jira('J43', SPEC, { spec: jiraSpec(), extra: [{ match: '/issue/createmeta/PROJ/issuetypes/10002', status: 500, text: JSON.stringify({ errorMessages: ['meta down'] }) }] }),
  jira('J44', SPEC, { spec: jiraSpec(), extra: [{ match: '/rest/api/3/issue/PROJ-1?', text: '' }] }),
  jira('J45', SPEC, {
    spec: jiraSpec({ stories: [{ id: 'PROJ-1', tasks: [{ title: '[Testing] A', estimate: 'x' }] }, { id: 'PROJ-2', tasks: FIVE_TASKS }] }),
    extra: [
      { match: '/rest/api/3/user/search', json: [] },
      { match: '/rest/api/3/issue/PROJ-1?', json: JSTORY('PROJ-1', { type: 'Task' }) },
      { match: '/issue/createmeta/PROJ/issuetypes/10002', json: { total: 3, fields: SUBTASK_META.fields.filter((x) => x.fieldId !== 'labels') } },
    ],
  }),
  jira('J45b', SPEC, {
    jira: { assignee: undefined, subtaskType: 'Nope' },
    spec: jiraSpec({ assignee: undefined, stories: [{ id: 'PROJ-1', tasks: [{ title: 'bad', estimate: 1 }] }] }),
    extra: [{ match: '/rest/api/3/issue/PROJ-1?', json: JSTORY('PROJ-1', { fields: { subtasks: undefined } }) }],
  }),

  // ════ Jira, --execute ══════════════════════════════════════════════════════
  jira('J46', [...SPEC, '--execute'], { spec: jiraSpec() }),
  jira('J47', [...SPEC, '--execute'], { spec: jiraSpec(), extra: [NO_TT_CREATE, SAMPLE_77, EDIT_WITH_TT] }),
  jira('J48', [...SPEC, '--execute'], { spec: jiraSpec(), extra: [
    { method: 'POST', match: '/rest/api/3/issue', respond: (call, n) => (n === 3
      ? { status: 400, text: JSON.stringify({ errorMessages: ['boom'], errors: { summary: 'too long' } }) }
      : { json: { key: `PROJ-${200 + n}` } }) },
  ] }),
  jira('J49', [...SPEC, '--execute'], { spec: jiraSpec(), extra: [
    NO_TT_CREATE, SAMPLE_77, EDIT_WITH_TT,
    { method: 'PUT', match: '/rest/api/3/issue/PROJ-', respond: (call, n) => (n === 2
      ? { status: 400, text: JSON.stringify({ errors: { timetracking: 'Field cannot be set' } }) }
      : { text: '' }) },
  ] }),
  jira('J50', [...SPEC, '--execute'], { spec: jiraSpec(), extra: [NO_TT_CREATE, SAMPLE_77, EDIT_WITHOUT_TT] }),
  jira('J51', [...SPEC, '--execute'], { spec: jiraSpec({ stories: [{ id: 'PROJ-2', tasks: FIVE_TASKS }] }) }),
];

// ── one case ─────────────────────────────────────────────────────────────────
async function runCase(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-golden-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify(c.config));
  fs.writeFileSync(path.join(dir, '.env'), c.env);
  if (c.spec !== undefined) fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(c.spec));
  if (c.setup) c.setup(dir);
  const argv = c.argv.map((a) => a.replace('{SPEC}', path.join(dir, 'spec.json')).replace('{DIR}', dir));
  const f = fakeFetch(c.routes());
  const { code, out } = await run(argv, { cwd: dir, fetch: f });
  const norm = normalizer(dir);
  const result = { argv: c.argv, code, out: norm(out), requests: f.calls.map((r) => ({ method: r.method, url: r.url, body: r.body })) };
  const raw = JSON.stringify(out);
  assert.ok(!raw.includes(SENTINEL_PAT) && !raw.includes(SENTINEL_JT), 'a sentinel credential leaked into the output');
  return result;
}

(async () => {
  const ids = new Set();
  for (const c of CASES) {
    const key = `${c.provider}/${c.id}`;
    await test(key, async () => {
      assert.ok(!ids.has(key), `duplicate case id ${key}`);
      ids.add(key);
      const file = path.join(GOLDEN_DIR, c.provider, `${c.id}.json`);
      const actual = await runCase(c);
      if (!fs.existsSync(file)) {
        if (!RECORD) throw new Error(`no expected file ${path.relative(__dirname, file)} — a missing golden is a FAIL (record with GOLDEN_RECORD=1)`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n', { flag: 'wx' }); // never overwrites
        recorded.push(key);
        return;
      }
      const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepStrictEqual(actual.argv, expected.argv, 'argv differs from the recorded case');
      assert.strictEqual(actual.code, expected.code, `exit code ${actual.code} !== recorded ${expected.code}`);
      const a = JSON.stringify(actual.out); const e = JSON.stringify(expected.out);
      if (a !== e) {
        let i = 0; while (i < a.length && a[i] === e[i]) i++;
        throw new Error(`out differs at char ${i}:\n    actual  …${a.slice(Math.max(0, i - 80), i + 120)}\n    expected…${e.slice(Math.max(0, i - 80), i + 120)}`);
      }
      assert.deepStrictEqual(actual.requests, expected.requests, 'request sequence differs');
    });
  }

  await test('every golden file belongs to a case (no orphan expectations)', async () => {
    for (const provider of ['ado', 'jira']) {
      const d = path.join(GOLDEN_DIR, provider);
      if (!fs.existsSync(d)) continue;
      for (const name of fs.readdirSync(d)) {
        assert.ok(ids.has(`${provider}/${name.replace(/\.json$/, '')}`), `orphan golden file ${provider}/${name}`);
      }
    }
  });

  if (recorded.length) console.log(`\nrecorded ${recorded.length} new expectation file(s): ${recorded.join(', ')}`);
  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed (${CASES.length} golden cases)` : `\n${passed} passed (${CASES.length} golden cases)`);
  process.exitCode = failures.length ? 1 : 0;
})();
