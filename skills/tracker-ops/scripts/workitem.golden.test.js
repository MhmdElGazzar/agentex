'use strict';
// Golden (characterization) suite for the tracker work-item CLI — recorded ONCE
// from the unmodified 0.23.0 script (release/1.0.0 @ 8ffedff), before the move
// and the strategy refactor, and never re-recorded. Every case pins, byte for
// byte: JSON.stringify(out), the exit code, and the ordered request sequence the
// script sent to the fake fetch (method, url, body).
//
// Self-contained on purpose: it imports only node: modules and the script's
// `run` — its own fake fetch and fixtures, so a later edit to the unit test or
// to any module this delivery touches can never move an expectation. The only
// expectation edits allowed are the design's NAMED changes, each in its own
// commit (R3.4).
//
// Run (check mode, the default):  node <this file>
// Record missing expectations:    GOLDEN_RECORD=1 node <this file>
//   Record mode writes ONLY missing files and never overwrites one. In check
//   mode a missing expected file is a FAIL, never a skip; so is an expected
//   file with no case.
//
// Normalization — exactly one substitution, nothing else: the case's temp
// project dir inside any string value -> "<CWD>" (the remainder of that path
// with path.sep -> "/").
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./workitem.js');

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

const SENTINEL_PAT = 'SENTINEL-PAT-trk-golden-00112233445566';
const SENTINEL_JT = 'SENTINEL-JIRA-TOKEN-trk-golden-778899';
const SENTINEL_JE = 'sentinel.golden@example.com';

// ── fake fetch ───────────────────────────────────────────────────────────────
// Route: { method='GET', match: urlSubstring, bodyMatch?, status?, json?, text?,
//          respond?: (call, n) => response }. Unmatched requests answer 200 '{}'
// and are still recorded.
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
      const resp = r.respond ? r.respond(call, n) : r;
      const status = resp.status || 200;
      const json = typeof resp.json === 'function' ? resp.json(call, n) : resp.json;
      const text = resp.text !== undefined ? resp.text : JSON.stringify(json ?? {});
      return { ok: status >= 200 && status < 300, status, text: async () => text };
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
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return walk;
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const AZ = { azure: { org: 'exampleorg', project: 'Sample Project' } };
const AZ_ENV = `AZURE_PAT=${SENTINEL_PAT}\n`;
const JI = { jira: { site: 'example', project: 'PROJ' } };
const JI_ENV = `JIRA_EMAIL=${SENTINEL_JE}\nJIRA_API_TOKEN=${SENTINEL_JT}\n`;

const ADO_WI_42 = {
  id: 42, rev: 3,
  fields: {
    'System.WorkItemType': 'User Story', 'System.Title': 'Checkout totals', 'System.State': 'Active',
    'System.Description': '<div>Totals include tax</div>',
  },
};
const ADO_WI_42_ALL = {
  ...ADO_WI_42,
  relations: [
    { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://dev.azure.com/exampleorg/_apis/wit/workItems/43', attributes: { isLocked: false } },
    { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/exampleorg/_apis/wit/workItems/7', attributes: { isLocked: false } },
  ],
};
function adoRoutes(extra = []) {
  return [
    ...extra,
    { match: '/wit/workitems/42?', json: (call) => (call.url.includes('expand') ? ADO_WI_42_ALL : ADO_WI_42) },
    { method: 'POST', match: '/wit/wiql', json: { queryType: 'flat', workItems: [{ id: 42, url: 'x' }, { id: 44, url: 'y' }] } },
    { method: 'POST', match: '/wit/workitems/$Task', json: { id: 501, _links: { html: { href: 'https://dev.azure.com/exampleorg/Sample%20Project/_workitems/edit/501' } } } },
    { method: 'PATCH', match: '/wit/workitems/42', json: { id: 42, rev: 4 } },
  ];
}

const J_ISSUE_1 = {
  key: 'PROJ-1', id: '10001',
  fields: { issuetype: { name: 'Story' }, summary: 'Checkout totals', status: { name: 'To Do' } },
  renderedFields: { description: '<p>Totals include tax</p>' },
};
const J_TRANSITIONS = { transitions: [
  { id: '11', name: 'In Progress', to: { name: 'In Progress' } },
  { id: '21', name: 'Done', to: { name: 'Done' } },
] };
function jiraRoutes(extra = []) {
  return [
    ...extra,
    { match: '/issue/PROJ-1/transitions', json: J_TRANSITIONS },
    { method: 'POST', match: '/issue/PROJ-1/transitions', status: 204, text: '' },
    { method: 'POST', match: '/issue/PROJ-1/comment', json: { id: '9001' } },
    { method: 'POST', match: '/rest/api/3/issueLink', status: 201, text: '' },
    { method: 'PUT', match: '/rest/api/3/issue/PROJ-1', status: 204, text: '' },
    { match: '/rest/api/3/issue/PROJ-1?', json: J_ISSUE_1 },
    { method: 'POST', match: '/search/jql', json: { issues: [{ key: 'PROJ-1', fields: { summary: 'Checkout totals' } }, { key: 'PROJ-2', fields: {} }] } },
    { method: 'POST', match: '/rest/api/3/issue', json: { id: '10002', key: 'PROJ-2' } },
  ];
}
const PAGED_SEARCH = {
  method: 'POST', match: '/search/jql',
  respond: (call, n) => ({ json: { issues: [{ key: `PROJ-${n}`, fields: { summary: `Item ${n}` } }], nextPageToken: `tok-${n}` } }),
};

const ADO_CREATE_SPEC = { fields: { 'System.Title': 'Ad-hoc task', 'System.Description': 'Ä — résumé — تجربة' }, relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', targetId: 42 }] };
const ADO_UPDATE_SPEC = { fields: { 'System.Title': 'Renamed' }, addRelations: [{ rel: 'System.LinkTypes.Related', targetId: 7 }] };
const J_CREATE_SPEC = { fields: { summary: 'Ad-hoc task', description: 'line one\n\nsecond paragraph — تجربة' }, relations: [{ rel: 'parent', targetId: 'PROJ-1' }] };
const J_UPDATE_SPEC = { fields: { summary: 'Renamed' } };

// Case builders. extra.routes is an EXTRA route prefix (matched first).
const A = (id, argv, extra = {}) => ({ provider: 'ado', id, argv, config: AZ, env: AZ_ENV, ...extra, routes: () => adoRoutes(extra.routes || []) });
const J = (id, argv, extra = {}) => ({ provider: 'jira', id, argv, config: JI, env: JI_ENV, ...extra, routes: () => jiraRoutes(extra.routes || []) });

const WRITE_CMDS_ADO = {
  create: ['create', '--type', 'Task', '--spec', '{SPEC}'],
  update: ['update', '--id', '42', '--spec', '{SPEC}'],
  transition: ['transition', '--id', '42', '--to', 'Resolved'],
  comment: ['comment', '--id', '42', '--body', 'x'],
  link: ['link', '--id', '42', '--type', 'System.LinkTypes.Related', '--target', '7'],
};
const WRITE_CMDS_JIRA = {
  create: ['create', '--type', 'Task', '--spec', '{SPEC}'],
  update: ['update', '--id', 'PROJ-1', '--spec', '{SPEC}'],
  transition: ['transition', '--id', 'PROJ-1', '--to', 'Done'],
  comment: ['comment', '--id', 'PROJ-1', '--body', 'x'],
  link: ['link', '--id', 'PROJ-1', '--type', 'Relates', '--target', 'PROJ-2'],
};

const CASES = [
  // ── ADO: reads ──
  A('A01', ['show', '--id', '42']),
  A('A02', ['show', '--id', '42', '--expand', 'all']),
  A('A03', ['show']),
  A('A04', ['search', '--query', "SELECT [System.Id] FROM workitems WHERE [System.State] = 'Active' ORDER BY [System.Id]"]),
  A('A05', ['search', '--query', "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = @project AND [System.State] = 'Active'"]),
  A('A06', ['search']),
  A('A07', ['show', '--id', '999'], { routes: [{ match: '/wit/workitems/999', status: 404, text: JSON.stringify({ message: 'TF401232: Work item 999 does not exist.' }) }] }),
  A('A08', ['show', '--id', '42'], { routes: [{ match: '/wit/workitems/42', status: 401, text: 'unauthorized' }] }),
  A('A09', ['show', '--id', '42'], { env: '' }),
  // ── ADO: writes, dry run + execute ──
  A('A10', ['create', '--type', 'Task', '--spec', '{SPEC}'], { spec: ADO_CREATE_SPEC }),
  A('A11', ['create', '--type', 'Task', '--spec', '{SPEC}', '--execute'], { spec: ADO_CREATE_SPEC }),
  A('A12', ['create', '--type', 'Task']),
  A('A13', ['create', '--type', 'Task', '--spec', '{DIR}/missing-spec.json']),
  A('A14', ['create', '--type', 'Task', '--spec', '{SPEC}', '--execute'], { spec: ADO_CREATE_SPEC, routes: [{ method: 'POST', match: '/wit/workitems/$Task', status: 400, text: JSON.stringify({ message: 'TF401320: Rule Error for field Title.' }) }] }),
  A('A15', ['update', '--id', '42', '--spec', '{SPEC}'], { spec: ADO_UPDATE_SPEC }),
  A('A16', ['update', '--id', '42', '--spec', '{SPEC}', '--execute'], { spec: ADO_UPDATE_SPEC }),
  A('A17', ['update', '--id', '42']),
  A('A18', ['update', '--id', '42', '--spec', '{SPEC}'], { specRaw: '{ not json' }),
  A('A19', ['transition', '--id', '42', '--to', 'Resolved']),
  A('A20', ['transition', '--id', '42', '--to', 'Resolved', '--execute']),
  A('A21', ['transition', '--id', '42']),
  A('A22', ['comment', '--id', '42', '--body', 'retested — passes']),
  A('A23', ['comment', '--id', '42', '--body', 'retested — passes', '--execute']),
  A('A24', ['comment', '--id', '42']),
  A('A25', ['link', '--id', '42', '--type', 'System.LinkTypes.Related', '--target', '7']),
  A('A26', ['link', '--id', '42', '--type', 'System.LinkTypes.Related', '--target', '7', '--execute']),
  A('A27', ['link', '--id', '42', '--type', 'Microsoft.VSTS.Common.TestedBy-Forward', '--target', '9', '--direction', 'inward', '--execute']),
  A('A28', ['link', '--id', '42', '--target', '7']),
  // ── ADO: CI refusal before any read, per write; reads + dry runs unaffected ──
  ...Object.entries(WRITE_CMDS_ADO).map(([cmd, argv], i) =>
    A(`A3${i}`, [...argv, '--execute'], { ci: true, spec: cmd === 'create' ? ADO_CREATE_SPEC : ADO_UPDATE_SPEC })),
  A('A35', ['show', '--id', '42'], { ci: true }),
  A('A36', ['update', '--id', '42', '--spec', '{SPEC}'], { ci: true, spec: ADO_UPDATE_SPEC }),
  // ── ADO: bad usage ──
  A('A37', []),
  A('A38', ['frobnicate', '--id', '42']),

  // ── Jira: reads ──
  J('J01', ['show', '--id', 'PROJ-1']),
  J('J02', ['show', '--id', 'PROJ-1', '--expand', 'all']),
  J('J03', ['show']),
  J('J04', ['search', '--query', 'project = "PROJ" AND status = "To Do"']),
  J('J05', ['search', '--query', 'project = "PROJ"'], { routes: [PAGED_SEARCH] }),
  J('J06', ['search']),
  J('J07', ['show', '--id', 'PROJ-404'], { routes: [{ match: '/rest/api/3/myself', json: { accountId: 'acc-1' } }, { match: '/issue/PROJ-404', status: 404, text: JSON.stringify({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }) }] }),
  J('J08', ['show', '--id', 'PROJ-404'], { routes: [{ match: '/rest/api/3/myself', status: 401, text: '' }, { match: '/issue/PROJ-404', status: 404, text: JSON.stringify({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }) }] }),
  J('J09', ['show', '--id', 'PROJ-1'], { env: `JIRA_EMAIL=${SENTINEL_JE}\n` }),
  // ── Jira: writes ──
  J('J10', ['create', '--type', 'Task', '--spec', '{SPEC}'], { spec: J_CREATE_SPEC }),
  J('J11', ['create', '--type', 'Task', '--spec', '{SPEC}', '--execute'], { spec: J_CREATE_SPEC }),
  J('J12', ['create', '--type', 'Task', '--spec', '{SPEC}'], { spec: { fields: { summary: 's' }, relations: [{ rel: 'Relates', targetId: 'PROJ-1' }] } }),
  J('J13', ['update', '--id', 'PROJ-1', '--spec', '{SPEC}'], { spec: J_UPDATE_SPEC }),
  J('J14', ['update', '--id', 'PROJ-1', '--spec', '{SPEC}', '--execute'], { spec: J_UPDATE_SPEC }),
  J('J15', ['update', '--spec', '{SPEC}'], { spec: J_UPDATE_SPEC }),
  J('J16', ['transition', '--id', 'PROJ-1', '--to', 'done']),
  J('J17', ['transition', '--id', 'PROJ-1', '--to', '21', '--execute']),
  J('J18', ['transition', '--id', 'PROJ-1', '--to', 'Nonexistent']),
  J('J19', ['transition', '--to', 'Done']),
  J('J20', ['comment', '--id', 'PROJ-1', '--body', 'retested on qc — passes <ok> & "quoted"\nsecond line']),
  J('J21', ['comment', '--id', 'PROJ-1', '--body', 'retested on qc — passes <ok> & "quoted"\nsecond line', '--execute']),
  J('J22', ['comment', '--body', 'x']),
  J('J23', ['link', '--id', 'PROJ-1', '--type', 'Relates', '--target', 'PROJ-2']),
  J('J24', ['link', '--id', 'PROJ-1', '--type', 'Relates', '--target', 'PROJ-2', '--execute']),
  J('J25', ['link', '--id', 'PROJ-1', '--type', 'Blocks', '--target', 'PROJ-2', '--direction', 'inward', '--execute']),
  J('J26', ['link', '--id', 'PROJ-1', '--type', 'parent', '--target', 'PROJ-9']),
  J('J27', ['link', '--id', 'PROJ-1', '--type', 'Relates']),
  // ── Jira: CI refusal before any read, per write; reads + dry runs unaffected ──
  ...Object.entries(WRITE_CMDS_JIRA).map(([cmd, argv], i) =>
    J(`J3${i}`, [...argv, '--execute'], { ci: true, spec: cmd === 'create' ? J_CREATE_SPEC : J_UPDATE_SPEC })),
  J('J35', ['show', '--id', 'PROJ-1'], { ci: true }),
  J('J36', ['transition', '--id', 'PROJ-1', '--to', 'Done'], { ci: true }),
  J('J37', ['comment', '--id', 'PROJ-1', '--body', 'x'], { ci: true }),
  // ── Jira: bad usage ──
  J('J38', []),

  // ── tracker resolution (no provider / two providers / legacy .env) ──
  { provider: 'none', id: 'N01', argv: ['show', '--id', '42'], config: {}, env: '', routes: () => [] },
  { provider: 'none', id: 'N02', argv: ['comment', '--id', '42', '--body', 'x', '--execute'], config: { ...AZ, ...JI }, env: AZ_ENV + JI_ENV, routes: () => [] },
  { provider: 'none', id: 'N03', argv: ['search', '--query', 'SELECT [System.Id] FROM workitems'], config: {}, env: `AZURE_URL=https://dev.azure.com/exampleorg\nAZURE_PROJECT=Sample Project\n${AZ_ENV}`, routes: () => adoRoutes() },
];

async function runCase(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-trk-golden-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify(c.config));
  fs.writeFileSync(path.join(dir, '.env'), c.env);
  if (c.spec !== undefined) fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(c.spec));
  if (c.specRaw !== undefined) fs.writeFileSync(path.join(dir, 'spec.json'), c.specRaw);
  const argv = c.argv.map((a) => a.replace('{SPEC}', path.join(dir, 'spec.json')).replace('{DIR}', dir));
  const f = fakeFetch(c.routes());
  if (c.ci) process.env.AGENTEX_CI = '1';
  let res;
  try { res = await run(argv, { cwd: dir, fetch: f }); }
  finally { delete process.env.AGENTEX_CI; }
  const { code, out } = res;
  const norm = normalizer(dir);
  const result = { argv: c.argv, code, out: norm(out), requests: f.calls.map((r) => ({ method: r.method, url: r.url, body: r.body })) };
  const raw = JSON.stringify(out);
  assert.ok(!raw.includes(SENTINEL_PAT) && !raw.includes(SENTINEL_JT) && !raw.includes(SENTINEL_JE),
    'a sentinel credential leaked into the output');
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
    for (const provider of ['ado', 'jira', 'none']) {
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
