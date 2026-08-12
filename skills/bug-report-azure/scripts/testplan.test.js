'use strict';
// Tests for testplan.js — the two write paths (create-case, fail) and the read paths that
// feed them.
//   Run: node skills/bug-report-azure/scripts/testplan.test.js
//
// Offline and deterministic, same harness idea as create-bug.test.js: every `az` call goes
// to a shim on PATH that answers from a fixture and logs what it was asked, so a test can
// assert on what the script did NOT do — the important half of a fail-closed guarantee.
// Nothing here ever reaches a real Azure DevOps, and no test needs the network at all
// (testplan.js makes no direct HTTPS calls; everything goes through `az`).
//
// The three behaviours these tests exist to pin down, all of them previously unguarded:
//   1. a real az failure during a suite/point scan must SURFACE, not read as "no test point";
//   2. the dry run must print every write the execute path performs — all four of `fail`;
//   3. a failure after the first write must name what already exists on the board.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TESTPLAN = path.join(__dirname, 'testplan.js');
const { assertNoShellExpansion } = require('./_lib.js');
const IS_WIN = process.platform === 'win32';

let passed = 0, skipped = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
function skip(name, why) { skipped++; console.log(`  skip - ${name} (${why})`); }

// ---- harness ---------------------------------------------------------------

const sandboxes = [];
function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-testplan-'));
  sandboxes.push(d);
  return d;
}

// A fake `az` on PATH. Named per platform because _lib.js resolves az.cmd on Windows and az
// everywhere else. Every invocation is appended to az-calls.log so tests can assert on it.
// `opts` switches individual routes to a failure, so each fail-closed branch gets exercised
// without any special-casing inside testplan.js itself.
function fakeAz(dir, opts = {}) {
  const o = (k, dflt) => JSON.stringify(k in opts ? opts[k] : dflt);
  fs.writeFileSync(path.join(dir, 'fake-az.js'), `
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'az-calls.log'), JSON.stringify(a) + '\\n');
// Log what each --in-file actually carried: the payloads are where all user text lives now,
// so this is the only place a test can prove it arrived unmangled.
const inFile = a.indexOf('--in-file');
if (inFile !== -1) {
  try { fs.appendFileSync(path.join(__dirname, 'az-payloads.log'), fs.readFileSync(a[inFile + 1], 'utf8') + '\\n'); }
  catch (e) { /* dry-run paths never write the file */ }
}
const has = (...w) => w.every((x) => a.includes(x));
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };

if (has('devops', 'configure')) {
  process.stdout.write('organization = https://example.visualstudio.com\\nproject = Proj\\n');
  process.exit(0);
}
if (has('work-item', 'show')) out({ id: 501, fields: {
  'System.WorkItemType': ${o('wiType', 'Test Case')}, 'System.Title': 'TC A', 'System.State': 'Design' } });
if (has('--resource', 'wiql')) {
  if (${o('queryFails', false)}) die('TF400598: simulated query failure');
  out({ workItems: ${o('dupes', [])} });
}
if (has('--resource', 'workitems')) out({ id: 4242 });
if (has('--resource', 'suites')) {
  if (${o('suitesFail', false)}) die('TF401019: the plan does not exist');
  out({ value: ${o('suites', [{ id: 11, name: 'Suite A', suiteType: 'StaticTestSuite' }])} });
}
if (has('--resource', 'test cases')) {
  if (${o('casesFail', false)}) die('TF400813: the user is not authorized to access this resource');
  out({ value: [{ workItem: { id: 501, name: 'TC A' } }] });
}
if (has('--resource', 'test point')) {
  if (${o('pointAuthFails', false)}) die('TF400813: the user is not authorized to access this resource');
  if (${o('pointNotFound', false)}) die('ERROR: 404 - the requested resource could not be found');
  out({ value: [{ id: 9001 }] });
}
if (has('--resource', 'suite entries')) {
  if (${o('suiteAddFails', false)}) die('VS402323: the suite entry was rejected');
  out({});
}
if (has('--area', 'test', '--resource', 'runs', '--http-method', 'POST')) out({ id: 7001 });
if (has('--area', 'test', '--resource', 'runs', '--http-method', 'PATCH')) out({ id: 7001, state: 'Completed' });
if (has('--area', 'test', '--resource', 'results', '--http-method', 'PATCH')) {
  if (${o('resultPatchFails', false)}) die('VS403072: the test result patch was rejected');
  out([{ id: 900 }]);
}
if (has('--area', 'test', '--resource', 'results')) out({ value: ${o('noResult', false)} ? [] : [{ id: 900 }] });
if (has('relation', 'add')) {
  if (${o('relationFails', false)}) die('VS402625: the relation was rejected');
  out({});
}
die('fake-az: unhandled: ' + a.join(' '));
`);
  if (IS_WIN) {
    fs.writeFileSync(path.join(dir, 'az.cmd'), '@echo off\r\nnode "%~dp0fake-az.js" %*\r\n');
  } else {
    const p = path.join(dir, 'az');
    fs.writeFileSync(p, '#!/bin/sh\nexec node "$(dirname "$0")/fake-az.js" "$@"\n');
    fs.chmodSync(p, 0o755);
  }
}

function azCalls(dir) {
  const f = path.join(dir, 'az-calls.log');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const called = (dir, ...words) => azCalls(dir).filter((c) => words.every((w) => c.includes(w)));

function azPayloads(dir) {
  const f = path.join(dir, 'az-payloads.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

function run(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [TESTPLAN, ...args], {
    cwd: dir, encoding: 'utf8',
    env: {
      ...process.env,
      PATH: dir + path.delimiter + process.env.PATH,
      Path: dir + path.delimiter + (process.env.Path || ''),
      AZURE_URL: 'https://example.visualstudio.com', AZURE_PROJECT: 'Proj',
      AZURE_DEVOPS_ORG_URL: '', AZURE_DEVOPS_DEFAULT_PROJECT: '',
      ...env,
    },
  });
  return { ...r, out: (r.stdout || '') + (r.stderr || '') };
}

const CREATE = ['create-case', '--plan', '10', '--suite', '11', '--title', 'New TC'];
const FAIL = ['fail', '--plan', '10', '--testcase', '501', '--bug', '4242'];

// ---- errors must surface, not read as "nothing found" -----------------------

console.log('\nerror propagation');

test('a real az failure during the point scan surfaces instead of "no test point"', () => {
  const dir = sandbox(); fakeAz(dir, { pointAuthFails: true });
  const r = run(dir, ['find-case', '--plan', '10', '--testcase', '501']);
  assert.notStrictEqual(r.status, 0, r.out);
  assert.ok(/not authorized/.test(r.out), 'should show the exact az error');
  assert.ok(!/no test point/.test(r.out), 'an auth failure must not be reported as a missing point');
});

test('a genuine 404 on the point scan still reads as "no test point"', () => {
  const dir = sandbox(); fakeAz(dir, { pointNotFound: true });
  const r = run(dir, ['find-case', '--plan', '10', '--testcase', '501']);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(/no test point for TC 501/.test(r.out));
});

test('list-cases surfaces a real error instead of silently skipping the suite', () => {
  const dir = sandbox(); fakeAz(dir, { casesFail: true });
  const r = run(dir, ['list-cases', '--plan', '10']);
  assert.notStrictEqual(r.status, 0, r.out);
  assert.ok(/not authorized/.test(r.out), 'should show the exact az error');
});

test('find-case refuses a work item that is not a Test Case', () => {
  const dir = sandbox(); fakeAz(dir, { wiType: 'User Story' });
  const r = run(dir, ['find-case', '--plan', '10', '--testcase', '501']);
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(/not a Test Case/.test(r.out));
});

// ---- create-case: preflight + dry run + partial write -----------------------

console.log('\ncreate-case');

test('dry run writes nothing and prints both writes', () => {
  const dir = sandbox(); fakeAz(dir);
  const r = run(dir, CREATE);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual((r.out.match(/\[would run\]/g) || []).length, 2, 'create + suite-add');
  assert.ok(/DRY RUN/.test(r.out));
  assert.strictEqual(called(dir, '--resource', 'workitems').length, 0, 'dry run must not create');
  assert.strictEqual(called(dir, 'suite entries').length, 0, 'dry run must not touch the suite');
});

test('a suite outside the plan is refused before anything is created', () => {
  const dir = sandbox(); fakeAz(dir);
  const r = run(dir, ['create-case', '--plan', '10', '--suite', '99', '--title', 'New TC', '--execute']);
  assert.strictEqual(r.status, 2, r.out);
  assert.ok(/suite 99 is not in plan 10/.test(r.out));
  assert.ok(/suite 11/.test(r.out), 'should list the suites that ARE in the plan');
  assert.strictEqual(called(dir, '--resource', 'workitems').length, 0, 'must not create an orphan');
});

test('an unreadable plan is refused before anything is created', () => {
  const dir = sandbox(); fakeAz(dir, { suitesFail: true });
  const r = run(dir, [...CREATE, '--execute']);
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(/does not exist/.test(r.out), 'should show the exact az error');
  assert.strictEqual(called(dir, '--resource', 'workitems').length, 0, 'must not create an orphan');
});

test('an existing same-title Test Case refuses to create under --execute', () => {
  const dir = sandbox(); fakeAz(dir, { dupes: [{ id: 77 }] });
  const r = run(dir, [...CREATE, '--execute']);
  assert.strictEqual(r.status, 2, r.out);
  assert.ok(/#77/.test(r.out), 'should name the duplicate');
  assert.ok(/--allow-duplicate/.test(r.out), 'should name the explicit override');
  assert.strictEqual(called(dir, '--resource', 'workitems').length, 0);
});

test('a duplicate-check failure refuses to create under --execute', () => {
  const dir = sandbox(); fakeAz(dir, { queryFails: true });
  const r = run(dir, [...CREATE, '--execute']);
  assert.strictEqual(r.status, 2, r.out);
  assert.ok(/IDEMPOTENCY CHECK FAILED/.test(r.out));
  assert.strictEqual(called(dir, '--resource', 'workitems').length, 0);
});

test('--execute creates the Test Case and adds it to the suite', () => {
  const dir = sandbox(); fakeAz(dir);
  const r = run(dir, [...CREATE, '--execute']);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(called(dir, '--resource', 'workitems').length, 1);
  assert.strictEqual(called(dir, 'suite entries').length, 1);
  assert.ok(/TC_ID=4242/.test(r.out), 'should print the machine-readable id');
});

test('a failed suite-add names the Test Case it already created', () => {
  const dir = sandbox(); fakeAz(dir, { suiteAddFails: true });
  const r = run(dir, [...CREATE, '--execute']);
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(/Test Case #4242 WAS created/.test(r.out), 'must not die as if nothing happened');
  assert.ok(/TC_ID=4242/.test(r.out), 'the orphan id must stay machine-readable');
  assert.ok(/rejected/.test(r.out), 'should show the exact az error');
});

// ---- fail: all four writes, and partial-write reporting ---------------------

console.log('\nfail');

test('dry run prints ALL FOUR writes and sends none of them', () => {
  const dir = sandbox(); fakeAz(dir);
  const r = run(dir, FAIL);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual((r.out.match(/\[would run\]/g) || []).length, 4,
    'run create + result PATCH + run complete + relation add');
  // buildCmd quotes every argument individually ("relation" "add"), and the quoting differs
  // per platform — drop the quotes so these read as the commands a human would type.
  const flat = r.out.replace(/["']/g, '');
  assert.ok(/--resource runs --http-method POST/.test(flat), 'run create');
  assert.ok(/--resource results --http-method PATCH/.test(flat), 'result PATCH');
  assert.ok(/--resource runs --http-method PATCH/.test(flat),
    'the run-completing PATCH — the one the old dry run omitted');
  assert.ok(/relation add .*--relation-type tested by/.test(flat), 'the tested-by link');
  assert.ok(/DRY RUN/.test(r.out));
  assert.strictEqual(called(dir, '--http-method', 'POST').length, 0, 'nothing may be sent');
  assert.strictEqual(called(dir, 'relation', 'add').length, 0, 'nothing may be sent');
});

test('dry run shows the payload each --in-file will carry', () => {
  const dir = sandbox(); fakeAz(dir);
  const r = run(dir, FAIL);
  assert.ok(/--in-file will hold:.*"outcome":"Failed"/.test(r.out), 'the result payload');
  assert.ok(/--in-file will hold:.*"state":"Completed"/.test(r.out), 'the run-completion payload');
});

test('--execute performs the four writes in order', () => {
  const dir = sandbox(); fakeAz(dir);
  const r = run(dir, [...FAIL, '--execute']);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(called(dir, '--resource', 'runs', '--http-method', 'POST').length, 1);
  assert.strictEqual(called(dir, '--resource', 'results', '--http-method', 'PATCH').length, 1);
  assert.strictEqual(called(dir, '--resource', 'runs', '--http-method', 'PATCH').length, 1,
    'the run must be closed, not left InProgress');
  assert.strictEqual(called(dir, 'relation', 'add').length, 1);
  assert.ok(/Recorded Failed result/.test(r.out));
});

test('a failed result PATCH names the run it left open', () => {
  const dir = sandbox(); fakeAz(dir, { resultPatchFails: true });
  const r = run(dir, [...FAIL, '--execute']);
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(/test run 7001 WAS created/.test(r.out));
  assert.ok(/still InProgress/.test(r.out), 'the user has to know what to close by hand');
  assert.strictEqual(called(dir, 'relation', 'add').length, 0, 'must not link after a broken outcome');
});

test('a run with no test result names the run it left open', () => {
  const dir = sandbox(); fakeAz(dir, { noResult: true });
  const r = run(dir, [...FAIL, '--execute']);
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(/test run 7001 WAS created/.test(r.out));
  assert.ok(/still InProgress/.test(r.out));
});

test('a failed tested-by link reports the result as already recorded', () => {
  const dir = sandbox(); fakeAz(dir, { relationFails: true });
  const r = run(dir, [...FAIL, '--execute']);
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(/Failed result WAS recorded/.test(r.out));
  assert.ok(/run 7001/.test(r.out));
  assert.strictEqual(called(dir, '--resource', 'runs', '--http-method', 'PATCH').length, 1,
    'the run was still completed before the link failed');
});

test('no test point at all refuses without writing anything', () => {
  const dir = sandbox(); fakeAz(dir, { pointNotFound: true });
  const r = run(dir, [...FAIL, '--execute']);
  assert.strictEqual(r.status, 1, r.out);
  assert.ok(/no test point for TC 501/.test(r.out));
  assert.strictEqual(called(dir, '--http-method', 'POST').length, 0);
});

// ---- user text never reaches a shell ---------------------------------------
// cmd.exe expands %NAME% before quoting is considered, and offers no way to escape it. The
// fix is structural: the title travels inside the --in-file payload, so no shell ever parses
// it. assertNoShellExpansion stays as a backstop for anything that DOES land on a command
// line in future — it is a net under the design, not the design itself.

console.log('\nuser text never reaches a shell');

test('a title carrying a live %VAR% is written literally, not expanded', () => {
  const dir = sandbox(); fakeAz(dir);
  const title = 'Broken at %AGENTEX_TEST_VAR% step';
  const r = run(dir, ['create-case', '--plan', '10', '--suite', '11', '--title', title, '--execute'],
    { AGENTEX_TEST_VAR: 'expanded-value' });
  assert.strictEqual(r.status, 0, r.out);
  const payloads = azPayloads(dir);
  assert.ok(payloads.includes(title), 'the payload must carry the title exactly as typed');
  assert.ok(!payloads.includes('expanded-value'), 'the variable must NOT have been expanded');
  // And it never appeared as a command-line argument in the first place.
  assert.ok(!azCalls(dir).some((c) => c.some((x) => String(x).includes('AGENTEX_TEST_VAR'))),
    'the title must not reach any command line');
});

test('the duplicate-check query carries the title in a file, not on the command line', () => {
  const dir = sandbox(); fakeAz(dir);
  const title = 'Totals wrong for 50% discount';
  run(dir, ['create-case', '--plan', '10', '--suite', '11', '--title', title, '--execute']);
  assert.ok(/SELECT \[System\.Id\] FROM workitems/.test(azPayloads(dir)), 'WIQL goes in the payload');
  assert.ok(azPayloads(dir).includes(title), 'the title reaches the query intact');
  assert.ok(!azCalls(dir).some((c) => c.some((x) => String(x).includes('SELECT'))),
    'no WIQL may appear as a command-line argument');
});

if (!IS_WIN) {
  skip('the expansion backstop still refuses a live %VAR% argument', 'POSIX: single quotes are literal');
} else {
  test('the expansion backstop still refuses a live %VAR% argument', () => {
    // "50% off" has no %NAME% pair and no such variable, so cmd leaves it alone — and so must we.
    assert.doesNotThrow(() => assertNoShellExpansion(['--title', '50% off is not applied']));
    assert.doesNotThrow(() => assertNoShellExpansion(['--title', '%NO_SUCH_VAR_HERE%']));
    assert.throws(() => assertNoShellExpansion(['--title', 'x %PATH% y']), /PATH/);
  });
}

// ---- summary ----------------------------------------------------------------

try {
  console.log(`\n${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ''}`);
  if (failures.length) failures.forEach((f) => console.error(`  - ${f}`));
} finally {
  // Leave no sandboxes behind — these run on a developer's real temp dir.
  for (const d of sandboxes) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
process.exit(failures.length ? 1 : 0);
