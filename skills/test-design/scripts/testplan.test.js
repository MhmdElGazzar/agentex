'use strict';
// Self-contained tests for the tracker-lib-backed testplan.js (test-design's
// test-case mechanics; consumed cross-skill by bug-report-azure for create-case
// and fail). Offline: fetch is injected in-process; one spawned run proves the
// one-JSON-line CLI contract with zero network.
// Run: node skills/test-design/scripts/testplan.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('./testplan.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const SENTINEL_PAT = 'SENTINEL-PAT-testplan-aabbccddeeff0011';
for (const n of ['AZURE_PAT', 'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'AZURE_URL', 'AZURE_PROJECT']) delete process.env[n];

function proj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-tp-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'project.json'),
    JSON.stringify({ azure: { org: 'exampleorg', project: 'Sample Project', areaPath: 'Proj\\QA' } }));
  fs.writeFileSync(path.join(dir, '.env'), `AZURE_PAT=${SENTINEL_PAT}\n`);
  return dir;
}

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', body: opts.body };
    calls.push(call);
    for (const r of routes) {
      if ((r.method || 'GET') !== call.method) continue;
      if (!call.url.includes(r.match)) continue;
      if (r.bodyMatch && !(typeof call.body === 'string' && call.body.includes(r.bodyMatch))) continue;
      const status = r.status || 200;
      // json may be a function of the calls so far — for read-after-write routes.
      const json = typeof r.json === 'function' ? r.json(calls) : r.json;
      return { ok: status < 300, status, text: async () => (r.text !== undefined ? r.text : JSON.stringify(json || {})) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

const SUITES = { value: [{ id: 4, name: 'Regression', suiteType: 'staticTestSuite' }] };
const TC_FIELDS = { value: [{ referenceName: 'System.Title', alwaysRequired: true }, { referenceName: 'System.AreaPath' }] };

function createCaseRoutes(extra = []) {
  return [
    ...extra,
    { method: 'POST', match: '/wiql', json: { workItems: [] } },
    { match: '/workitemtypes/Test%20Case/fields', json: TC_FIELDS },
    { method: 'POST', match: '/workitems/$Test%20Case', json: { id: 505 } },
    { method: 'POST', match: '/test/Plans/3/suites/4/testcases/505', json: {} },
    // Suite membership re-read: 505 shows up only after the add POST.
    { match: '/test/Plans/3/suites/4/testcases', json: (calls) => ({
      value: calls.some((c) => c.method === 'POST' && c.url.includes('/testcases/505')) ? [{ testCase: { id: '505' } }] : [],
    }) },
  ];
}

function failRoutes(extra = []) {
  return [
    ...extra,
    { match: '/testplan/Plans/3/suites', json: SUITES },
    { match: '/testplan/Plans/3/Suites/4/TestPoint?testCaseId=77', json: { value: [{ id: 900 }] } },
    { method: 'POST', match: '/test/runs?', json: { id: 88 } },
    { method: 'GET', match: '/test/Runs/88/results', json: { value: [{ id: 100000 }] } },
    { method: 'PATCH', match: '/test/Runs/88/results', json: {} },
    { method: 'PATCH', match: '/test/runs/88?', json: { id: 88, state: 'Completed' } },
    { method: 'PATCH', match: '/workitems/77', json: { id: 77 } },
  ];
}

const isWrite = (c) =>
  (c.method === 'POST' && (c.url.includes('/workitems/$') || c.url.includes('/test/runs') || c.url.includes('/testcases/'))) || c.method === 'PATCH';

(async () => {
  // ── reads ───────────────────────────────────────────────────────────────────
  await test('list-suites: one JSON line worth of suites, exit 0', async () => {
    const f = fakeFetch([{ match: '/testplan/Plans/3/suites', json: SUITES }]);
    const { code, out } = await run(['list-suites', '--plan', '3'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(out.suites, [{ id: 4, name: 'Regression', suiteType: 'staticTestSuite' }]);
  });

  await test('list-cases: cases per suite; a per-suite query failure is reported, not fatal', async () => {
    const f = fakeFetch([
      { match: '/testplan/Plans/3/suites', json: { value: [{ id: 4, name: 'A' }, { id: 5, name: 'B' }] } },
      { match: '/Suites/4/TestCase', json: { value: [{ workItem: { id: 77, name: 'Login TC' } }] } },
      { match: '/Suites/5/TestCase', status: 500, text: 'suite gone' },
    ]);
    const { code, out } = await run(['list-cases', '--plan', '3'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(out.suites[0].cases, [{ id: 77, title: 'Login TC' }]);
    assert.match(out.suites[1].error, /500/);
  });

  await test('find-case: validates the work item IS a Test Case and locates its point', async () => {
    const f = fakeFetch([
      { match: '/workitems/77', json: { id: 77, fields: { 'System.WorkItemType': 'Test Case', 'System.Title': 'Login TC', 'System.State': 'Design' } } },
      { match: '/testplan/Plans/3/suites', json: SUITES },
      { match: '/Suites/4/TestPoint?testCaseId=77', json: { value: [{ id: 900 }] } },
    ]);
    const { code, out } = await run(['find-case', '--plan', '3', '--testcase', '77'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 0);
    assert.strictEqual(out.testCase.title, 'Login TC');
    assert.deepStrictEqual(out.point, { suiteId: 4, suiteName: 'Regression', pointId: 900 });
  });

  await test('find-case: a non-Test-Case id fails with exit 1; a missing point is ok:true point:null', async () => {
    const f1 = fakeFetch([{ match: '/workitems/77', json: { id: 77, fields: { 'System.WorkItemType': 'Bug' } } }]);
    const r1 = await run(['find-case', '--plan', '3', '--testcase', '77'], { cwd: proj(), fetch: f1 });
    assert.strictEqual(r1.code, 1);
    assert.match(r1.out.error.message, /not a Test Case/);
    const f2 = fakeFetch([
      { match: '/workitems/77', json: { id: 77, fields: { 'System.WorkItemType': 'Test Case', 'System.Title': 't' } } },
      { match: '/testplan/Plans/3/suites', json: SUITES },
      { match: '/TestPoint?testCaseId=77', json: { value: [] } },
    ]);
    const r2 = await run(['find-case', '--plan', '3', '--testcase', '77'], { cwd: proj(), fetch: f2 });
    assert.strictEqual(r2.code, 0);
    assert.strictEqual(r2.out.point, null);
    assert.ok(r2.out.note);
  });

  // ── create-case ─────────────────────────────────────────────────────────────
  await test('create-case dry run: plan is [create TC, add-to-suite] with routes; zero writes', async () => {
    const f = fakeFetch(createCaseRoutes());
    const { code, out } = await run(['create-case', '--plan', '3', '--suite', '4', '--title', 'New TC'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.mode, 'plan');
    assert.deepStrictEqual(out.plan.map((p) => p.step), ['create-test-case', 'add-to-suite']);
    assert.match(out.plan[1].describe, /POST .*\/test\/Plans\/3\/suites\/4\/testcases\//);
    assert.strictEqual(f.calls.filter(isWrite).length, 0);
  });

  await test('create-case DUP CHECK FAILS CLOSED: WIQL error exits 2, zero writes', async () => {
    const f = fakeFetch(createCaseRoutes([{ method: 'POST', match: '/wiql', status: 500, text: 'err' }]));
    const { code, out } = await run(['create-case', '--plan', '3', '--suite', '4', '--title', 'New TC', '--execute'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 2);
    assert.match(JSON.stringify(out.blocked), /duplicate check failed/i);
    assert.strictEqual(f.calls.filter(isWrite).length, 0);
  });

  await test('create-case: dup found blocks without --allow-duplicate', async () => {
    const dup = [{ method: 'POST', match: '/wiql', json: { workItems: [{ id: 400 }] } }];
    const r1 = await run(['create-case', '--plan', '3', '--suite', '4', '--title', 'New TC'], { cwd: proj(), fetch: fakeFetch(createCaseRoutes(dup)) });
    assert.strictEqual(r1.code, 2);
    assert.match(JSON.stringify(r1.out.blocked), /400/);
    const r2 = await run(['create-case', '--plan', '3', '--suite', '4', '--title', 'New TC', '--allow-duplicate'], { cwd: proj(), fetch: fakeFetch(createCaseRoutes(dup)) });
    assert.strictEqual(r2.code, 0);
  });

  await test('create-case --execute: create then suite-add, ledger all done, TC id + url out', async () => {
    const f = fakeFetch(createCaseRoutes());
    const { code, out } = await run(['create-case', '--plan', '3', '--suite', '4', '--title', 'New TC', '--execute'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.created.testCaseId, 505);
    assert.ok(out.created.url.includes('505'));
    assert.strictEqual(out.created.suiteId, '4');
    const writes = f.calls.filter(isWrite);
    assert.ok(writes[0].url.includes('$Test%20Case'), 'create first');
    assert.ok(writes[1].url.includes('/test/Plans/3/suites/4/testcases/505?'), 'suite add second');
    assert.ok(!f.calls.some((c) => c.url.includes('suiteentry')), 'never the suite-entries (reorder) route');
  });

  await test('SUITE-ADD FAILURE: exit 1, ledger names the orphan TC by id — never silent', async () => {
    const f = fakeFetch(createCaseRoutes([{ method: 'POST', match: '/suites/4/testcases/505', status: 404, text: JSON.stringify({ message: 'suite not found' }) }]));
    const { code, out } = await run(['create-case', '--plan', '3', '--suite', '4', '--title', 'New TC', '--execute'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 1);
    assert.strictEqual(out.ok, false, 'a TC outside its suite is a FAILURE, not a success');
    const byStep = Object.fromEntries(out.ledger.map((l) => [l.step, l]));
    assert.strictEqual(byStep['create-test-case'].status, 'done');
    assert.strictEqual(byStep['create-test-case'].id, 505);
    assert.strictEqual(byStep['add-to-suite'].status, 'failed');
    assert.match(byStep['add-to-suite'].reason, /suite not found/);
    assert.strictEqual(out.created.testCaseId, 505, 'the orphan is named in created');
  });

  await test('SUITE-ADD SILENT NO-OP (HTTP 200, case not in suite on re-read): exit 1, orphan named', async () => {
    const f = fakeFetch(createCaseRoutes([{ match: '/test/Plans/3/suites/4/testcases', json: { value: [] } }]));
    const { code, out } = await run(['create-case', '--plan', '3', '--suite', '4', '--title', 'New TC', '--execute'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 1);
    const byStep = Object.fromEntries(out.ledger.map((l) => [l.step, l]));
    assert.strictEqual(byStep['add-to-suite'].status, 'failed');
    assert.match(byStep['add-to-suite'].reason, /#505 was created but NOT added to suite 4.*not in suite 4 on re-read/);
    assert.strictEqual(out.created.testCaseId, 505);
  });

  // ── fail ────────────────────────────────────────────────────────────────────
  await test('fail dry run: plan is [create run, record result, complete run, tested-by link]; zero writes', async () => {
    const f = fakeFetch(failRoutes());
    const { code, out } = await run(['fail', '--plan', '3', '--testcase', '77', '--bug', '4711'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.deepStrictEqual(out.plan.map((p) => p.step),
      ['create-run', 'record-failed-result', 'complete-run', 'link-tested-by']);
    assert.deepStrictEqual(out.point, { suiteId: 4, suiteName: 'Regression', pointId: 900 });
    assert.strictEqual(f.calls.filter(isWrite).length, 0);
  });

  await test('fail: no test point for the TC in the plan blocks with exit 2', async () => {
    const f = fakeFetch([
      { match: '/testplan/Plans/3/suites', json: SUITES },
      { match: '/TestPoint?testCaseId=77', json: { value: [] } },
    ]);
    const { code, out } = await run(['fail', '--plan', '3', '--testcase', '77', '--bug', '4711'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 2);
    assert.match(JSON.stringify(out.blocked), /no test point/i);
  });

  await test('fail --execute: run -> result -> complete -> tested-by, in order, all in the ledger', async () => {
    const f = fakeFetch(failRoutes());
    const { code, out } = await run(['fail', '--plan', '3', '--testcase', '77', '--bug', '4711', '--execute'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.ok(out.ledger.every((l) => l.status === 'done'));
    assert.strictEqual(out.run.id, 88);
    const writes = f.calls.filter(isWrite);
    assert.ok(writes[0].url.includes('/test/runs?'), 'create run first');
    assert.ok(writes[1].url.includes('/test/Runs/88/results'), 'result patch second');
    assert.match(writes[1].body, /"outcome":"Failed"/);
    assert.match(writes[1].body, /associatedBugs/);
    assert.ok(writes[2].url.includes('/test/runs/88?'), 'complete run third');
    assert.match(writes[2].body, /Completed/);
    assert.ok(writes[3].url.includes('/workitems/77'), 'tested-by link last');
    assert.match(writes[3].body, /TestedBy-Reverse/);
  });

  await test('RESULT-PATCH FAILURE: exit 1, ledger names the run left InProgress + manual completion', async () => {
    const f = fakeFetch(failRoutes([{ method: 'PATCH', match: '/test/Runs/88/results', status: 500, text: 'nope' }]));
    const { code, out } = await run(['fail', '--plan', '3', '--testcase', '77', '--bug', '4711', '--execute'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 1);
    assert.strictEqual(out.ok, false);
    const byStep = Object.fromEntries(out.ledger.map((l) => [l.step, l]));
    assert.strictEqual(byStep['create-run'].status, 'done');
    assert.strictEqual(byStep['create-run'].id, 88);
    assert.strictEqual(byStep['record-failed-result'].status, 'failed');
    assert.match(byStep['record-failed-result'].reason, /run 88/, 'the open run is named');
    assert.match(byStep['record-failed-result'].reason, /InProgress.*manually|manually.*InProgress/i, 'manual completion is the user\'s call');
    assert.strictEqual(byStep['complete-run'].status, 'not-attempted');
    assert.strictEqual(byStep['link-tested-by'].status, 'not-attempted');
    assert.strictEqual(out.run.id, 88, 'run id surfaced at top level too');
  });

  await test('a run with NO results blocks the result patch and names the run', async () => {
    const f = fakeFetch(failRoutes([{ method: 'GET', match: '/test/Runs/88/results', json: { value: [] } }]));
    const { code, out } = await run(['fail', '--plan', '3', '--testcase', '77', '--bug', '4711', '--execute'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 1);
    const step = out.ledger.find((l) => l.step === 'record-failed-result');
    assert.strictEqual(step.status, 'failed');
    assert.match(step.reason, /run 88/);
  });

  await test('sentinel PAT absent from every JSON out; no child_process in the script', async () => {
    const outs = [];
    outs.push(await run(['list-suites', '--plan', '3'], { cwd: proj(), fetch: fakeFetch(failRoutes()) }));
    outs.push(await run(['create-case', '--plan', '3', '--suite', '4', '--title', 't', '--execute'], { cwd: proj(), fetch: fakeFetch(createCaseRoutes()) }));
    outs.push(await run(['fail', '--plan', '3', '--testcase', '77', '--bug', '1', '--execute'], { cwd: proj(), fetch: fakeFetch(failRoutes()) }));
    const all = JSON.stringify(outs);
    assert.ok(!all.includes(SENTINEL_PAT));
    assert.ok(!all.includes(Buffer.from(':' + SENTINEL_PAT).toString('base64')));
    const src = fs.readFileSync(path.join(__dirname, 'testplan.js'), 'utf8');
    assert.ok(!/child_process|spawnSync|execSync/.test(src));
  });

  await test('no process.exit in the delivered script (structural source read)', async () => {
    // Force-exiting after fetch trips a libuv assertion on Windows/Node 24 and can
    // corrupt the exit code; print, set process.exitCode, and let the loop drain
    // (the run_api.js doctrine).
    const src = fs.readFileSync(path.join(__dirname, 'testplan.js'), 'utf8');
    assert.ok(!src.includes('process.exit('), 'testplan.js must not force-exit');
  });

  await test('CLI: one JSON line, exit 2 on bad usage (spawned, zero network)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-tp-'));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'testplan.js')], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, AZURE_PAT: SENTINEL_PAT },
    });
    assert.strictEqual(r.status, 2, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(JSON.parse(lines[0]).ok, false);
    assert.ok(!r.stdout.includes(SENTINEL_PAT) && !r.stderr.includes(SENTINEL_PAT));
  });

  await test('USAGE lists every subcommand, including ensure-plan, ensure-suite and record (named golden change #5)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-tp-'));
    const f = fakeFetch([]);
    const r = await run([], { cwd: dir, fetch: f });
    assert.strictEqual(r.code, 2);
    const m = /<([^>]+)>/.exec(r.out.error.message);
    assert.ok(m, r.out.error.message);
    assert.deepStrictEqual(m[1].split('|'), ['list-suites', 'list-cases', 'find-case', 'create-case', 'fail', 'record', 'ensure-plan', 'ensure-suite']);
    assert.strictEqual(f.calls.length, 0);
  });

  await test('capability guard: a Jira-configured project exits 2 naming testPlans:false — before any network call', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-tp-'));
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'),
      JSON.stringify({ jira: { site: 'example', project: 'PROJ' } }));
    fs.writeFileSync(path.join(dir, '.env'), 'JIRA_EMAIL=qa@example.com\nJIRA_API_TOKEN=x\n');
    const f = fakeFetch([]);
    for (const argv of [['list-suites', '--plan', '3'], ['create-case', '--plan', '3', '--suite', '4', '--title', 't'], ['fail', '--plan', '3', '--testcase', '7', '--bug', '1']]) {
      const { code, out } = await run(argv, { cwd: dir, fetch: f });
      assert.strictEqual(code, 2, JSON.stringify(out));
      assert.strictEqual(out.ok, false);
      assert.match(out.error.message, /not supported on this tracker/i);
      assert.match(out.error.message, /testPlans:\s*false/);
    }
    assert.strictEqual(f.calls.length, 0, 'refused upfront — nothing was sent');
  });

  // ════ ensure-plan / ensure-suite / record (skill-consolidation-foundation WP-9) ════
  const writes = (f) => f.calls.filter((c) => c.method !== 'GET');
  const jiraDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-tp-'));
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({ jira: { site: 'example', project: 'PROJ' } }));
    fs.writeFileSync(path.join(dir, '.env'), 'JIRA_EMAIL=qa@example.com\nJIRA_API_TOKEN=x\n');
    return dir;
  };
  const PLANS = (extra = []) => ({ value: [{ id: 3, name: 'Release 1', rootSuite: { id: 30 } }, ...extra] });
  // Plans list that gains the new plan once the create POST was sent.
  const planRoutes = (extra = []) => [
    ...extra,
    { method: 'POST', match: '/_apis/testplan/plans', json: { id: 12, name: 'AgenTeX gate', rootSuite: { id: 120 } } },
    { match: '/_apis/testplan/plans?', json: (calls) => PLANS(calls.some((c) => c.method === 'POST' && c.url.includes('/testplan/plans')) ? [{ id: 12, name: 'AgenTeX gate', rootSuite: { id: 120 } }] : []) },
  ];

  await test('ensure-plan: an existing exact-name plan -> exists:true with its id, ZERO writes', async () => {
    const f = fakeFetch(planRoutes());
    const { code, out } = await run(['ensure-plan', '--name', 'Release 1'], { cwd: proj(), fetch: f });
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.exists, true);
    assert.deepStrictEqual(out.plan, { id: 3, name: 'Release 1', rootSuiteId: 30 });
    assert.strictEqual(writes(f).length, 0);
    const near = await run(['ensure-plan', '--name', 'release 1'], { cwd: proj(), fetch: fakeFetch(planRoutes()) });
    assert.strictEqual(near.out.exists, false, 'exact name only — no case-folding match');
  });

  await test('ensure-plan: absent -> dry-run plan [create-plan]; --execute creates and re-reads; a second run writes nothing', async () => {
    const f1 = fakeFetch(planRoutes());
    const r1 = await run(['ensure-plan', '--name', 'AgenTeX gate', '--area', 'Sample Project\\QA'], { cwd: proj(), fetch: f1 });
    assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
    assert.strictEqual(r1.out.exists, false);
    assert.deepStrictEqual(r1.out.plan.map((p) => p.step), ['create-plan']);
    assert.deepStrictEqual(r1.out.plan[0].request.body, { name: 'AgenTeX gate', areaPath: 'Sample Project\\QA' });
    assert.match(r1.out.note, /nothing has been written/);
    assert.strictEqual(writes(f1).length, 0);
    const f2 = fakeFetch(planRoutes());
    const r2 = await run(['ensure-plan', '--name', 'AgenTeX gate', '--execute'], { cwd: proj(), fetch: f2 });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    assert.deepStrictEqual(r2.out.ledger.map((l) => [l.step, l.status, l.id]), [['create-plan', 'done', 12]]);
    assert.deepStrictEqual(r2.out.created, { id: 12, name: 'AgenTeX gate', rootSuiteId: 120 });
    assert.strictEqual(writes(f2).length, 1);
    assert.ok(f2.calls.filter((c) => c.method === 'GET').length >= 2, 'read before and re-read after');
    const again = fakeFetch([{ match: '/_apis/testplan/plans?', json: PLANS([{ id: 12, name: 'AgenTeX gate', rootSuite: { id: 120 } }]) }]);
    const r3 = await run(['ensure-plan', '--name', 'AgenTeX gate', '--execute'], { cwd: proj(), fetch: again });
    assert.strictEqual(r3.out.exists, true);
    assert.strictEqual(writes(again).length, 0, 'idempotent: the second run writes nothing');
  });

  await test('ensure-plan fails closed: missing on re-read (exit 1, ledger names it); two same-name plans (exit 2 listing ids); truncated list (exit 2)', async () => {
    const lost = fakeFetch([{ method: 'POST', match: '/_apis/testplan/plans', json: { id: 12, name: 'AgenTeX gate', rootSuite: { id: 120 } } }, { match: '/_apis/testplan/plans?', json: PLANS() }]);
    const r1 = await run(['ensure-plan', '--name', 'AgenTeX gate', '--execute'], { cwd: proj(), fetch: lost });
    assert.strictEqual(r1.code, 1, JSON.stringify(r1.out));
    assert.strictEqual(r1.out.ledger[0].status, 'failed');
    assert.match(r1.out.ledger[0].reason, /12/);
    assert.match(r1.out.ledger[0].reason, /re-read/);
    const dup = fakeFetch([{ match: '/_apis/testplan/plans?', json: PLANS([{ id: 4, name: 'Release 1' }]) }]);
    const r2 = await run(['ensure-plan', '--name', 'Release 1', '--execute'], { cwd: proj(), fetch: dup });
    assert.strictEqual(r2.code, 2);
    assert.deepStrictEqual(r2.out.blocked.map((b) => [b.reason, b.ids]), [['ambiguous-plan', [3, 4]]]);
    assert.strictEqual(writes(dup).length, 0);
    let n = 0;
    const paged = async (url, opts = {}) => {
      n++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ value: [{ id: 100 + n, name: `P${n}` }] }), headers: { get: (k) => (k === 'x-ms-continuationtoken' ? `t${n}` : null) } };
    };
    paged.calls = [];
    const r3 = await run(['ensure-plan', '--name', 'Nowhere', '--execute'], { cwd: proj(), fetch: paged });
    assert.strictEqual(r3.code, 2, JSON.stringify(r3.out));
    assert.strictEqual(r3.out.blocked[0].reason, 'cannot-prove-absent');
  });

  const SUITE_LIST = (extra = []) => ({ value: [
    { id: 30, name: 'Release 1', suiteType: 'staticTestSuite' },
    { id: 31, name: 'Checkout', suiteType: 'staticTestSuite', parentSuite: { id: 30 } },
    { id: 32, name: '42 : Totals', suiteType: 'requirementTestSuite', requirementId: 42, parentSuite: { id: 30 } },
    { id: 33, name: 'Checkout', suiteType: 'staticTestSuite', parentSuite: { id: 31 } },
    ...extra,
  ] });
  const suiteRoutes = (created) => [
    { match: '/testplan/plans/3?', json: { id: 3, name: 'Release 1', rootSuite: { id: 30 } } },
    { method: 'POST', match: '/testplan/Plans/3/suites', json: created },
    { match: '/testplan/Plans/3/suites', json: (calls) => SUITE_LIST(calls.some((c) => c.method === 'POST') ? [{ ...created, parentSuite: { id: 30 } }] : []) },
  ];

  await test('ensure-suite: requirement (by requirement id) and static (by exact name) under the root suite by default; ZERO writes when present', async () => {
    const f1 = fakeFetch(suiteRoutes({}));
    const r1 = await run(['ensure-suite', '--plan', '3', '--type', 'requirement', '--requirement', '42'], { cwd: proj(), fetch: f1 });
    assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
    assert.deepStrictEqual([r1.out.exists, r1.out.suite.id], [true, 32]);
    assert.ok(f1.calls.some((c) => c.url.includes('/testplan/plans/3?')), 'the parent default comes from the plan\'s root suite');
    const f2 = fakeFetch(suiteRoutes({}));
    const r2 = await run(['ensure-suite', '--plan', '3', '--type', 'static', '--name', 'Checkout'], { cwd: proj(), fetch: f2 });
    assert.deepStrictEqual([r2.out.exists, r2.out.suite.id], [true, 31], 'the same name under ANOTHER parent is not this suite');
    const f3 = fakeFetch(suiteRoutes({}));
    const r3 = await run(['ensure-suite', '--plan', '3', '--type', 'static', '--name', 'Checkout', '--parent', '31'], { cwd: proj(), fetch: f3 });
    assert.deepStrictEqual([r3.out.exists, r3.out.suite.id], [true, 33]);
    assert.ok(!f3.calls.some((c) => c.url.includes('/testplan/plans/3?')), 'an explicit parent needs no plan read');
    assert.strictEqual(writes(f1).length + writes(f2).length + writes(f3).length, 0);
  });

  await test('ensure-suite: absent -> dry-run [create-suite]; --execute creates + re-reads; second run exists; bad usage exits 2 with zero requests', async () => {
    const created = { id: 44, name: 'Gate — membership', suiteType: 'staticTestSuite' };
    const f1 = fakeFetch(suiteRoutes(created));
    const r1 = await run(['ensure-suite', '--plan', '3', '--type', 'static', '--name', 'Gate — membership'], { cwd: proj(), fetch: f1 });
    assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
    assert.deepStrictEqual(r1.out.plan.map((p) => p.step), ['create-suite']);
    assert.deepStrictEqual(r1.out.plan[0].request.body, { suiteType: 'staticTestSuite', name: 'Gate — membership', parentSuite: { id: 30 } });
    assert.strictEqual(writes(f1).length, 0);
    const f2 = fakeFetch(suiteRoutes(created));
    const r2 = await run(['ensure-suite', '--plan', '3', '--type', 'static', '--name', 'Gate — membership', '--execute'], { cwd: proj(), fetch: f2 });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    assert.deepStrictEqual(r2.out.ledger.map((l) => [l.step, l.status, l.id]), [['create-suite', 'done', 44]]);
    const req = fakeFetch(suiteRoutes({ id: 45, name: '7 : Story', suiteType: 'requirementTestSuite', requirementId: 7 }));
    const r3 = await run(['ensure-suite', '--plan', '3', '--type', 'requirement', '--requirement', '7', '--execute'], { cwd: proj(), fetch: req });
    assert.strictEqual(r3.code, 0, JSON.stringify(r3.out));
    assert.deepStrictEqual(JSON.parse(writes(req)[0].body), { suiteType: 'requirementTestSuite', requirementId: 7, parentSuite: { id: 30 } });
    const none = fakeFetch([]);
    for (const argv of [['ensure-suite', '--plan', '3'], ['ensure-suite', '--plan', '3', '--type', 'requirement'], ['ensure-suite', '--plan', '3', '--type', 'static'], ['ensure-suite', '--plan', '3', '--type', 'query', '--name', 'x'], ['ensure-plan']]) {
      assert.strictEqual((await run(argv, { cwd: proj(), fetch: none })).code, 2, argv.join(' '));
    }
    assert.strictEqual(none.calls.length, 0);
  });

  const recordRoutes = (outcome, extra = []) => failRoutes([
    ...extra,
    { match: '/testplan/Plans/3/Suites/4/TestPoint?testCaseId=77', json: { value: [{ id: 900, ...(outcome ? { results: { outcome } } : {}) }] } },
  ]);
  await test('record --outcome: exactly Passed|Failed|Blocked|NotApplicable — anything else exits 2 with ZERO requests; --bug only with Failed/Blocked', async () => {
    const f = fakeFetch([]);
    for (const o of ['passed', 'Pass', 'Skipped', '']) {
      const { code } = await run(['record', '--plan', '3', '--testcase', '77', '--outcome', o], { cwd: proj(), fetch: f });
      assert.strictEqual(code, 2, `outcome ${JSON.stringify(o)}`);
    }
    for (const o of ['Passed', 'NotApplicable']) {
      const { code, out } = await run(['record', '--plan', '3', '--testcase', '77', '--outcome', o, '--bug', '5'], { cwd: proj(), fetch: f });
      assert.strictEqual(code, 2);
      assert.strictEqual(out.blocked[0].reason, 'bug-with-non-failing-outcome');
    }
    assert.strictEqual(f.calls.length, 0);
  });

  await test('record Passed (no bug): plan [create-run, record-passed-result, complete-run] — no tested-by link; defaults name the outcome', async () => {
    const f = fakeFetch(recordRoutes(undefined));
    const r1 = await run(['record', '--plan', '3', '--testcase', '77', '--outcome', 'Passed'], { cwd: proj(), fetch: f });
    assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
    assert.deepStrictEqual(r1.out.plan.map((p) => p.step), ['create-run', 'record-passed-result', 'complete-run']);
    assert.strictEqual(r1.out.plan[0].request.body.name, 'Passed — TC 77');
    assert.deepStrictEqual(r1.out.plan[1].request.body, [{ id: '{result-id}', outcome: 'Passed', state: 'Completed', comment: 'Passed recorded by AgenTeX' }]);
    assert.strictEqual(writes(f).length, 0);
    const f2 = fakeFetch(recordRoutes(undefined));
    const r2 = await run(['record', '--plan', '3', '--testcase', '77', '--outcome', 'Passed', '--execute'], { cwd: proj(), fetch: f2 });
    assert.strictEqual(r2.code, 0, JSON.stringify(r2.out));
    assert.deepStrictEqual(r2.out.ledger.map((l) => l.step), ['create-run', 'record-passed-result', 'complete-run']);
    assert.ok(!writes(f2).some((c) => c.url.includes('/workitems/77')), 'no tested-by link without --bug');
    assert.match(JSON.stringify(r2.out.ledger[1].describe), /mark the run result Passed \(PATCH/);
  });

  await test('record Blocked --bug --execute: four steps incl. the tested-by link; the ledger names a run left InProgress on failure', async () => {
    const f = fakeFetch(recordRoutes('failed'));
    const r = await run(['record', '--plan', '3', '--testcase', '77', '--outcome', 'Blocked', '--bug', '4711', '--execute'], { cwd: proj(), fetch: f });
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.ledger.map((l) => l.step), ['create-run', 'record-blocked-result', 'complete-run', 'link-tested-by']);
    assert.match(writes(f)[1].body, /"outcome":"Blocked"/);
    assert.match(writes(f)[1].body, /associatedBugs/);
    const bad = fakeFetch(recordRoutes(undefined, [{ method: 'PATCH', match: '/test/runs/88?', status: 500, text: 'x' }]));
    const r2 = await run(['record', '--plan', '3', '--testcase', '77', '--outcome', 'NotApplicable', '--execute'], { cwd: proj(), fetch: bad });
    assert.strictEqual(r2.code, 1);
    const step = r2.out.ledger.find((l) => l.step === 'complete-run');
    assert.strictEqual(step.status, 'failed');
    assert.match(step.reason, /run 88 is left InProgress/);
  });

  await test('record is idempotent: the same outcome already on the point -> unchanged, ZERO writes; with --bug only when the link exists too', async () => {
    const f1 = fakeFetch(recordRoutes('passed'));
    const r1 = await run(['record', '--plan', '3', '--testcase', '77', '--outcome', 'Passed', '--execute'], { cwd: proj(), fetch: f1 });
    assert.strictEqual(r1.code, 0, JSON.stringify(r1.out));
    assert.strictEqual(r1.out.unchanged, true);
    assert.strictEqual(writes(f1).length, 0);
    const TC = (rels) => ({ match: '/wit/workitems/77?', json: { id: 77, relations: rels } });
    const linked = [{ rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: 'https://dev.azure.com/exampleorg/_apis/wit/workItems/4711' }];
    const f2 = fakeFetch(recordRoutes('failed', [TC(linked)]));
    const r2 = await run(['record', '--plan', '3', '--testcase', '77', '--outcome', 'Failed', '--bug', '4711', '--execute'], { cwd: proj(), fetch: f2 });
    assert.strictEqual(r2.out.unchanged, true, JSON.stringify(r2.out));
    assert.strictEqual(writes(f2).length, 0);
    assert.ok(f2.calls.some((c) => c.url.includes('/wit/workitems/77?') && c.url.includes('relations')), 'the TC relations are read only because --bug was given');
    const f3 = fakeFetch(recordRoutes('failed', [TC([])]));
    const r3 = await run(['record', '--plan', '3', '--testcase', '77', '--outcome', 'Failed', '--bug', '4711', '--execute'], { cwd: proj(), fetch: f3 });
    assert.ok(!r3.out.unchanged, 'the link is missing -> the plan proceeds');
    assert.strictEqual(writes(f3).length, 4);
    const f4 = fakeFetch(recordRoutes('failed'));
    const r4 = await run(['record', '--plan', '3', '--testcase', '77', '--outcome', 'Passed'], { cwd: proj(), fetch: f4 });
    assert.ok(!r4.out.unchanged && r4.out.plan, 'a different outcome proceeds');
  });

  await test('fail stays an exact alias: --bug required, no idempotent skip (a Failed point is still recorded again)', async () => {
    const f0 = fakeFetch([]);
    assert.strictEqual((await run(['fail', '--plan', '3', '--testcase', '77'], { cwd: proj(), fetch: f0 })).code, 2);
    const f = fakeFetch(recordRoutes('failed'));
    const r = await run(['fail', '--plan', '3', '--testcase', '77', '--bug', '4711', '--execute'], { cwd: proj(), fetch: f });
    assert.strictEqual(r.code, 0, JSON.stringify(r.out));
    assert.ok(!r.out.unchanged);
    assert.strictEqual(writes(f).length, 4);
  });

  await test('Jira: ensure-plan / ensure-suite / record exit 2 naming testPlans:false with ZERO requests', async () => {
    const dir = jiraDir();
    const f = fakeFetch([]);
    for (const argv of [['ensure-plan', '--name', 'x'], ['ensure-suite', '--plan', '1', '--type', 'static', '--name', 'x'], ['record', '--plan', '1', '--testcase', '2', '--outcome', 'Passed']]) {
      const { code, out } = await run(argv, { cwd: dir, fetch: f });
      assert.strictEqual(code, 2, JSON.stringify(out));
      assert.match(out.error.message, /testPlans:\s*false/);
    }
    assert.strictEqual(f.calls.length, 0);
  });

  await test('CI guard: every write subcommand with --execute under AGENTEX_CI=1 exits 2 ci-mode BEFORE any read (zero requests)', async () => {
    process.env.AGENTEX_CI = '1';
    try {
      const f = fakeFetch(failRoutes(createCaseRoutes()));
      for (const argv of [
        ['create-case', '--plan', '3', '--suite', '4', '--title', 't'],
        ['fail', '--plan', '3', '--testcase', '77', '--bug', '1'],
        ['record', '--plan', '3', '--testcase', '77', '--outcome', 'Passed'],
        ['ensure-plan', '--name', 'x'],
        ['ensure-suite', '--plan', '3', '--type', 'static', '--name', 'x'],
      ]) {
        const { code, out } = await run([...argv, '--execute'], { cwd: proj(), fetch: f });
        assert.strictEqual(code, 2, `${argv[0]}: ${JSON.stringify(out)}`);
        assert.deepStrictEqual(out.blocked.map((b) => b.reason), ['ci-mode']);
        assert.match(out.blocked[0].message, /tracker writes are disabled in CI/);
      }
      assert.strictEqual(f.calls.length, 0);
      const dry = await run(['ensure-plan', '--name', 'Release 1'], { cwd: proj(), fetch: fakeFetch(planRoutes()) });
      assert.strictEqual(dry.code, 0, 'reads and dry runs are unaffected');
    } finally { delete process.env.AGENTEX_CI; }
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
