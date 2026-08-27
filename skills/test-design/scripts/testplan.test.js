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
      return { ok: status < 300, status, text: async () => (r.text !== undefined ? r.text : JSON.stringify(r.json || {})) };
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
    { method: 'PATCH', match: '/testplan/suiteentry/4', json: {} },
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
  (c.method === 'POST' && (c.url.includes('/workitems/$') || c.url.includes('/test/runs'))) || c.method === 'PATCH';

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
    assert.match(out.plan[1].describe, /suiteentry/);
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
    assert.ok(writes[1].url.includes('/testplan/suiteentry/4'), 'suite add second');
    assert.deepStrictEqual(JSON.parse(writes[1].body), [{ id: 505 }]);
  });

  await test('SUITE-ADD FAILURE: exit 1, ledger names the orphan TC by id — never silent', async () => {
    const f = fakeFetch(createCaseRoutes([{ method: 'PATCH', match: '/testplan/suiteentry/4', status: 404, text: JSON.stringify({ message: 'suite not found' }) }]));
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

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
