'use strict';
// Golden (characterization) suite for testplan.js's two write flows that other
// skills depend on — `create-case` (bug-report-azure's new-case path) and
// `fail` (bug-report-azure's outcome-recording path). Recorded ONCE from the
// unmodified 0.23.0 script (release/1.0.0 @ 8ffedff) before `record` /
// `ensure-*` were added, and never re-recorded: the plan entries and the
// WritePlan ledger lines are pinned byte for byte, with the exit code and the
// ordered request sequence (method, url, body).
//
// Self-contained on purpose (node: modules + ./testplan.js only). The only
// expectation edits allowed are the design's NAMED changes, each in its own
// commit (R3.4 #4: the CLI CI guard; #5: USAGE lists record / ensure-plan /
// ensure-suite, which moves the bad-usage text in C08 and F10 only).
//
// Run (check mode, the default):  node skills/test-design/scripts/testplan.golden.test.js
// Record missing expectations:    GOLDEN_RECORD=1 node skills/test-design/scripts/testplan.golden.test.js
//
// Normalization — exactly two substitutions: the case's temp project dir inside
// any string -> "<CWD>", and the value under any key named "builtAt" ->
// "<BUILT_AT>".
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./testplan.js');

const GOLDEN_DIR = path.join(__dirname, 'golden');
const RECORD = process.env.GOLDEN_RECORD === '1';

let passed = 0; const failures = []; const recorded = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

for (const k of Object.keys(process.env)) {
  if (k.startsWith('AZURE_') || k.startsWith('JIRA_') || k === 'AGENTEX_CI') delete process.env[k];
}
const SENTINEL_PAT = 'SENTINEL-PAT-tp-golden-0011223344';
const SENTINEL_JT = 'SENTINEL-JIRA-TOKEN-tp-golden-5566';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const call = { method: opts.method || 'GET', url: String(url), body: opts.body === undefined ? null : opts.body };
    calls.push(call);
    for (const r of routes) {
      if ((r.method || 'GET') !== call.method) continue;
      if (!call.url.includes(r.match)) continue;
      const status = r.status || 200;
      const json = typeof r.json === 'function' ? r.json(calls) : r.json;
      const text = r.text !== undefined ? r.text : JSON.stringify(json ?? {});
      return { ok: status >= 200 && status < 300, status, text: async () => text };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

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

const AZ = { azure: { org: 'exampleorg', project: 'Sample Project', areaPath: 'Sample Project\\QA' } };
const AZ_ENV = `AZURE_PAT=${SENTINEL_PAT}\n`;
const JI = { jira: { site: 'example', project: 'PROJ' } };
const JI_ENV = `JIRA_EMAIL=qa.engineer@example.com\nJIRA_API_TOKEN=${SENTINEL_JT}\n`;

const SUITES = { value: [{ id: 4, name: 'Regression', suiteType: 'staticTestSuite' }, { id: 5, name: 'Smoke', suiteType: 'staticTestSuite' }] };
const TC_FIELDS = { value: [{ referenceName: 'System.Title', alwaysRequired: true }, { referenceName: 'System.AreaPath' }] };

function createCaseRoutes(extra = []) {
  return [
    ...extra,
    { method: 'POST', match: '/wiql', json: { workItems: [] } },
    { match: '/workitemtypes/Test%20Case/fields', json: TC_FIELDS },
    { method: 'POST', match: '/workitems/$Test%20Case', json: { id: 505 } },
    { method: 'POST', match: '/test/Plans/3/suites/4/testcases/505', json: {} },
    { match: '/test/Plans/3/suites/4/testcases', json: (calls) => ({
      value: calls.some((c) => c.method === 'POST' && c.url.includes('/testcases/505')) ? [{ testCase: { id: '505' } }] : [],
    }) },
  ];
}
function failRoutes(extra = []) {
  return [
    ...extra,
    { match: '/testplan/Plans/3/suites', json: SUITES },
    { match: '/testplan/Plans/3/Suites/4/TestPoint?testCaseId=77', json: { value: [] } },
    { match: '/testplan/Plans/3/Suites/5/TestPoint?testCaseId=77', json: { value: [{ id: 900, results: { outcome: 'Passed' } }] } },
    { method: 'POST', match: '/test/runs?', json: { id: 88, url: 'https://dev.azure.com/exampleorg/Sample%20Project/_apis/test/Runs/88' } },
    { method: 'GET', match: '/test/Runs/88/results', json: { value: [{ id: 100000 }] } },
    { method: 'PATCH', match: '/test/Runs/88/results', json: {} },
    { method: 'PATCH', match: '/test/runs/88?', json: { id: 88, state: 'Completed' } },
    { method: 'PATCH', match: '/workitems/77', json: { id: 77 } },
  ];
}

const A = (id, argv, extra = {}) => ({ provider: 'ado', id, argv, config: AZ, env: AZ_ENV, ...extra });
const CC = ['create-case', '--plan', '3', '--suite', '4', '--title', 'Checkout — totals include tax'];
const FAIL = ['fail', '--plan', '3', '--testcase', '77', '--bug', '4711'];

const CASES = [
  // create-case
  A('C01', CC, { routes: () => createCaseRoutes() }),
  A('C02', [...CC, '--execute'], { routes: () => createCaseRoutes() }),
  A('C03', [...CC, '--execute'], { routes: () => createCaseRoutes([{ method: 'POST', match: '/suites/4/testcases/505', status: 404, text: JSON.stringify({ message: 'suite not found' }) }]) }),
  A('C04', [...CC, '--execute'], { routes: () => createCaseRoutes([{ match: '/test/Plans/3/suites/4/testcases', json: { value: [] } }]) }),
  A('C05', CC, { routes: () => createCaseRoutes([{ method: 'POST', match: '/wiql', json: { workItems: [{ id: 400 }] } }]) }),
  A('C06', [...CC, '--execute'], { routes: () => createCaseRoutes([{ method: 'POST', match: '/wiql', status: 500, text: 'err' }]) }),
  A('C07', [...CC, '--execute'], { ci: true, routes: () => createCaseRoutes() }),
  A('C08', ['create-case', '--plan', '3', '--suite', '4'], { routes: () => [] }),
  // fail
  A('F01', FAIL, { routes: () => failRoutes() }),
  A('F02', [...FAIL, '--execute'], { routes: () => failRoutes() }),
  A('F03', [...FAIL, '--execute', '--comment', 'Fails on qc — totals off by one', '--run-name', 'Nightly run 12'], { routes: () => failRoutes() }),
  A('F04', [...FAIL, '--execute'], { routes: () => failRoutes([{ method: 'PATCH', match: '/test/Runs/88/results', status: 500, text: 'nope' }]) }),
  A('F05', [...FAIL, '--execute'], { routes: () => failRoutes([{ method: 'GET', match: '/test/Runs/88/results', json: { value: [] } }]) }),
  A('F06', [...FAIL, '--execute'], { routes: () => failRoutes([{ method: 'PATCH', match: '/test/runs/88?', status: 500, text: 'nope' }]) }),
  A('F07', [...FAIL, '--execute'], { routes: () => failRoutes([{ method: 'PATCH', match: '/workitems/77', status: 400, text: JSON.stringify({ message: 'link exists' }) }]) }),
  A('F08', FAIL, { routes: () => failRoutes([{ match: '/Suites/5/TestPoint?testCaseId=77', json: { value: [] } }]) }),
  A('F09', [...FAIL, '--execute'], { ci: true, routes: () => failRoutes() }),
  A('F10', ['fail', '--plan', '3', '--testcase', '77'], { routes: () => [] }),
  // Jira: capability refusal, zero requests
  { provider: 'jira', id: 'J01', argv: [...FAIL, '--execute'], config: JI, env: JI_ENV, routes: () => [] },
  { provider: 'jira', id: 'J02', argv: CC, config: JI, env: JI_ENV, routes: () => [] },
];

async function runCase(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-tp-golden-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify(c.config));
  fs.writeFileSync(path.join(dir, '.env'), c.env);
  const f = fakeFetch(c.routes());
  if (c.ci) process.env.AGENTEX_CI = '1';
  let res;
  try { res = await run(c.argv, { cwd: dir, fetch: f }); }
  finally { delete process.env.AGENTEX_CI; }
  const norm = normalizer(dir);
  const raw = JSON.stringify(res.out);
  assert.ok(!raw.includes(SENTINEL_PAT) && !raw.includes(SENTINEL_JT), 'a sentinel credential leaked into the output');
  return { argv: c.argv, code: res.code, out: norm(res.out), requests: f.calls.map((r) => ({ method: r.method, url: r.url, body: r.body })) };
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
        fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n', { flag: 'wx' });
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
