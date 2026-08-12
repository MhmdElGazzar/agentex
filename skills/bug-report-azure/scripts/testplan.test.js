'use strict';
// Self-contained tests for testplan.js — the read subcommands, the dry-run and
// --execute flows of create-case, and the fail flow's preconditions, all against
// a fake az shim (the real Azure CLI is never invoked; the shim lives in a temp
// dir first on PATH, created and removed by this test).
// Coverage per docs/contributing/testing.md:
//   success paths   : list-suites, find-case locate, create-case dry-run and
//                     --execute, fail dry-run
//   FAIL modes      : unknown/missing subcommand, missing required flags, wrong
//                     work-item type for find-case, no test point for fail
//   BLOCKED/refusal : duplicate-title create-case on --execute without
//                     --allow-duplicate
//   safety rules    : untrusted titles reach az only as @file (never raw on the
//                     command line), write commands are printed but not executed
//                     without --execute, suite membership travels via --in-file
// Run: node skills/bug-report-azure/scripts/testplan.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RUNNER = path.join(__dirname, 'testplan.js');
const IS_WIN = process.platform === 'win32';
let passed = 0;

// ---- fake az shim (same design as _lib.test.js; duplicated on purpose — the
// repo convention is self-contained tests with no shared fixtures file) -------
const SHIM_JS = [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  "const args = process.argv.slice(2);",
  "const atFiles = {};",
  "for (const a of args) {",
  "  if (a.charAt(0) === '@') {",
  "    const p = a.slice(1);",
  "    const exists = fs.existsSync(p);",
  "    atFiles[a] = { exists: exists, content: exists ? fs.readFileSync(p, 'utf8') : null };",
  "  }",
  "}",
  "let inFile = null;",
  "const ix = args.indexOf('--in-file');",
  "if (ix !== -1 && args[ix + 1] && fs.existsSync(args[ix + 1])) {",
  "  try { inFile = fs.readFileSync(args[ix + 1], 'utf8').slice(0, 65536); } catch (e) {}",
  "}",
  "const rec = { args: args, atFiles: atFiles, inFile: inFile, pat: process.env.AZURE_DEVOPS_EXT_PAT || null };",
  "fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(rec) + '\\n');",
  "let out = '{}', code = 0, err = '';",
  "try {",
  "  const routes = JSON.parse(fs.readFileSync(path.join(__dirname, 'responses.json'), 'utf8'));",
  "  for (const r of routes) {",
  "    if (r.match.every(function (m) { return args.indexOf(m) !== -1; })) {",
  "      out = r.stdout !== undefined ? r.stdout : '{}';",
  "      code = r.exit || 0;",
  "      err = r.stderr || '';",
  "      break;",
  "    }",
  "  }",
  "} catch (e) {}",
  "if (err) process.stderr.write(err);",
  "process.stdout.write(out);",
  "process.exit(code);",
].join('\n');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-tptest-'));
const SHIM = path.join(TMP, 'shim');
const FIX = path.join(TMP, 'proj');

(function makeShim(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const shimJs = path.join(dir, 'azshim.js');
  fs.writeFileSync(shimJs, SHIM_JS);
  fs.writeFileSync(path.join(dir, 'az.cmd'), `@echo off\r\nnode "${shimJs}" %*\r\nexit /b %errorlevel%\r\n`);
  fs.writeFileSync(path.join(dir, 'az'), `#!/bin/sh\nexec node "${shimJs.replace(/\\/g, '\\\\')}" "$@"\n`);
  try { fs.chmodSync(path.join(dir, 'az'), 0o755); } catch (e) { /* windows */ }
})(SHIM);

function setRoutes(routes) {
  fs.writeFileSync(path.join(SHIM, 'responses.json'), JSON.stringify(routes));
  fs.rmSync(path.join(SHIM, 'calls.jsonl'), { force: true });
}

function readCalls() {
  const f = path.join(SHIM, 'calls.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---- generic project fixture --------------------------------------------------
fs.mkdirSync(path.join(FIX, 'config'), { recursive: true });
fs.writeFileSync(path.join(FIX, 'config', 'project.json'), JSON.stringify({
  azure: { org: 'https://dev.azure.com/demo-org', project: 'DemoProject', areaPath: 'DemoProject\\QA Area' },
}));

const R_SUITES = { match: ['suites'], stdout: '{"value":[{"id":10,"name":"Suite A","suiteType":"staticTestSuite"}]}' };
const R_POINT = { match: ['test point'], stdout: '{"value":[{"id":555}]}' };
const R_QUERY_EMPTY = { match: ['query'], stdout: '[]' };
const R_SHOW_TC = {
  match: ['show'],
  stdout: JSON.stringify({ id: 301, fields: { 'System.WorkItemType': 'Test Case', 'System.Title': 'Sample test case', 'System.State': 'Design' } }),
};

// Untrusted free text: quotes + metacharacters + %VAR% + Arabic.
const NASTY_TITLE = 'TC "quoted" & <x> | %USERNAME% — حالة اختبار جديدة';

function run(cliArgs, routes = []) {
  setRoutes(routes);
  return new Promise((resolve) => {
    const e = { ...process.env };
    for (const k of Object.keys(e)) if (k.toUpperCase().startsWith('AZURE_')) delete e[k];
    const pk = Object.keys(e).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    e[pk] = SHIM + path.delimiter + (e[pk] || '');
    const p = spawn('node', [RUNNER, ...cliArgs], { cwd: FIX, env: e });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err, calls: readCalls() }));
  });
}

// Anything that would mutate the board (create, suite membership, runs/results, links).
const isWrite = (c) => ['create', 'suite entries', 'runs', 'results', 'relation'].some((t) => c.args.includes(t));

async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ok -', name);
}

(async () => {
  try {
    // 1. FAIL: no subcommand -> usage
    await test('no subcommand prints usage, exit 2', async () => {
      const r = await run([]);
      assert.strictEqual(r.code, 2);
      assert.ok(r.err.includes('Usage: testplan.js'));
      assert.strictEqual(r.calls.length, 0);
    });

    // 2. FAIL: missing required flag
    await test('create-case without --plan fails with exit 2', async () => {
      const r = await run(['create-case']);
      assert.strictEqual(r.code, 2);
      assert.ok(r.err.includes('--plan is required'));
      assert.strictEqual(r.calls.length, 0);
    });

    // 3. SUCCESS: list-suites (read only)
    await test('list-suites lists suites, exit 0', async () => {
      const r = await run(['list-suites', '--plan', '7'], [R_SUITES]);
      assert.strictEqual(r.code, 0, r.err);
      assert.ok(r.out.includes('suite 10  Suite A'));
      assert.ok(r.calls.every((c) => !isWrite(c)));
    });

    // 4. SUCCESS (dry run): create-case prints @file commands, executes only the
    //    idempotency read, never the writes
    await test('create-case dry run: @file title, commands printed, no write executed', async () => {
      const r = await run(['create-case', '--plan', '7', '--suite', '10', '--title', NASTY_TITLE], [R_QUERY_EMPTY]);
      assert.strictEqual(r.code, 0, r.err);
      assert.ok(r.out.includes('=== PLAN (create test case) ==='));
      assert.ok(r.out.includes('DRY RUN — nothing written'));
      const would = r.out.split('\n').filter((l) => l.includes('[would run]'));
      assert.strictEqual(would.length, 2, 'create + suite-entries commands must be shown');
      const wjoined = would.join('\n');
      assert.ok(wjoined.includes(IS_WIN ? '"@' : "'@"), 'untrusted title must appear as @file');
      for (const frag of ['quoted', '%USERNAME%', 'حالة']) {
        assert.ok(!wjoined.includes(frag), `raw untrusted fragment in a printed az command: ${frag}`);
      }
      assert.ok(r.calls.every((c) => !isWrite(c)), 'only the idempotency read may execute');
    });

    // 5. SUCCESS (--execute): create-case creates the TC and adds it to the suite;
    //    the title round-trips byte-exact through the @file
    await test('create-case --execute: @file round-trip, suite membership via --in-file', async () => {
      const r = await run(
        ['create-case', '--plan', '7', '--suite', '10', '--title', NASTY_TITLE, '--execute'],
        [R_QUERY_EMPTY, { match: ['create'], stdout: '{"id":401}' }, { match: ['suite entries'], stdout: '{}' }],
      );
      assert.strictEqual(r.code, 0, r.err);
      assert.ok(r.out.includes('TC_ID=401'), 'machine-readable id line required');
      const create = r.calls.find((c) => c.args.includes('create'));
      assert.ok(create, 'create must have executed');
      const titleArg = create.args[create.args.indexOf('--title') + 1];
      assert.strictEqual(titleArg.charAt(0), '@', 'title must be @file-routed');
      assert.strictEqual(create.atFiles[titleArg].content, NASTY_TITLE, 'title must round-trip byte-exact');
      const joined = create.args.join(' ');
      for (const frag of ['quoted', '%USERNAME%', 'حالة']) {
        assert.ok(!joined.includes(frag), `raw untrusted fragment reached az argv: ${frag}`);
      }
      const suiteAdd = r.calls.find((c) => c.args.includes('suite entries'));
      assert.ok(suiteAdd, 'suite membership PATCH must have executed');
      assert.strictEqual(suiteAdd.inFile, '[{"id":401}]', 'suite entry body must travel via --in-file');
    });

    // 6. BLOCKED: duplicate-title create-case refused on --execute
    await test('create-case --execute with duplicate title refuses before any write', async () => {
      const r = await run(
        ['create-case', '--plan', '7', '--suite', '10', '--title', 'Existing case title', '--execute'],
        [{ match: ['query'], stdout: '[{"id":33}]' }],
      );
      assert.strictEqual(r.code, 2);
      assert.ok(r.err.includes('REFUSING possible duplicate'));
      assert.ok(r.calls.every((c) => !isWrite(c)), 'no write may run before the refusal');
    });

    // 7. FAIL: find-case rejects a work item that is not a Test Case
    await test('find-case with a non-Test-Case id fails with exit 1', async () => {
      const bug = JSON.stringify({ id: 301, fields: { 'System.WorkItemType': 'Bug', 'System.Title': 'B', 'System.State': 'New' } });
      const r = await run(['find-case', '--plan', '7', '--testcase', '301'], [{ match: ['show'], stdout: bug }]);
      assert.strictEqual(r.code, 1);
      assert.ok(r.err.includes('not a Test Case'));
    });

    // 8. SUCCESS: find-case validates the TC and locates its point
    await test('find-case locates the test point, exit 0', async () => {
      const r = await run(['find-case', '--plan', '7', '--testcase', '301'], [R_SHOW_TC, R_SUITES, R_POINT]);
      assert.strictEqual(r.code, 0, r.err);
      assert.ok(r.out.includes('TC #301 exists: "Sample test case" [Design]'));
      assert.ok(r.out.includes('TC 301 -> plan 7 / suite 10 (Suite A) / point 555'));
      assert.ok(r.calls.every((c) => !isWrite(c)));
    });

    // 9. SUCCESS (dry run): fail shows the plan + the three write commands and
    //    executes none of them
    await test('fail dry run: plan + 3 would-run commands, no write executed', async () => {
      const r = await run(['fail', '--plan', '7', '--testcase', '301', '--bug', '900'], [R_SUITES, R_POINT]);
      assert.strictEqual(r.code, 0, r.err);
      assert.ok(r.out.includes('=== PLAN (fail existing test case) ==='));
      assert.ok(r.out.includes('TC 301 -> plan 7 / suite 10 / point 555'));
      assert.ok(r.out.includes('Outcome    : Failed'));
      assert.ok(r.out.includes('DRY RUN — nothing written'));
      const would = (r.out.match(/\[would run\]/g) || []).length;
      assert.strictEqual(would, 3, 'run POST + results PATCH + relation add must be shown');
      assert.ok(r.calls.every((c) => !isWrite(c)), 'only suite/point reads may execute in a dry run');
    });

    // 10. FAIL: fail refuses when the TC has no test point in the plan
    await test('fail without a test point fails with exit 1, no write', async () => {
      const r = await run(['fail', '--plan', '7', '--testcase', '301', '--bug', '900'],
        [R_SUITES, { match: ['test point'], stdout: '{"value":[]}' }]);
      assert.strictEqual(r.code, 1);
      assert.ok(r.err.includes('no test point for TC 301'));
      assert.ok(r.calls.every((c) => !isWrite(c)));
    });

    console.log(`\n${passed} passed`);
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
