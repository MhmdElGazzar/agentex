'use strict';
// Self-contained tests for create-bug.js — the dry-run/refusal flows plus one
// full --execute pass, all against a fake az shim (the real Azure CLI is never
// invoked; the shim is first on PATH inside a temp dir this test creates and
// removes). Coverage per docs/contributing/testing.md:
//   success path      : dry-run plan (exit 0) and a full --execute create
//   FAIL modes        : missing --spec / missing/invalid spec fields, wrong parent type
//   BLOCKED/refusals  : duplicate title without --allow-duplicate, evidence-less
//                       bug without --no-screenshots, invalid attachment without --force
//   safety rules      : untrusted spec text reaches az only as @file (never raw on
//                       the command line), writes only run behind --execute, PAT
//                       stays in env and out of all output, transparency output
//                       (plan + az commands) precedes the attachment refusal
// Run: node skills/bug-report-azure/scripts/create-bug.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RUNNER = path.join(__dirname, 'create-bug.js');
const IS_WIN = process.platform === 'win32';
let passed = 0;
let specSeq = 0;

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-bugtest-'));
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

// ---- generic project fixture (placeholder org/project only) ------------------
fs.mkdirSync(path.join(FIX, 'config'), { recursive: true });
fs.writeFileSync(path.join(FIX, 'config', 'project.json'), JSON.stringify({
  azure: {
    org: 'https://dev.azure.com/demo-org',
    project: 'DemoProject',
    environment: 'QA',
    bugCategory: 'Functional',
  },
}));

// Minimal structurally-valid PNG: signature + IHDR (800x600), padded past 2 KB.
const PNG = path.join(FIX, 'evidence.png');
(function () {
  const b = Buffer.alloc(3072);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((v, i) => { b[i] = v; });
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(800, 16);   // width
  b.writeUInt32BE(600, 20);   // height
  b[24] = 8; b[25] = 6;       // bit depth, color type
  fs.writeFileSync(PNG, b);
})();
const BAD_ATT = path.join(FIX, 'not-an-image.txt');
fs.writeFileSync(BAD_ATT, 'plain text, definitely not a screenshot');

// Untrusted free text: quote-heavy + metacharacters + %VAR% + Arabic — must
// never appear raw on an az command line.
const baseSpec = {
  title: 'Checkout "fails" & shows <error> — %USERNAME% الدفع لا يعمل',
  severity: '2 - High',
  priority: 2,
  parentStoryId: 1234,
  assignedTo: 'qa.tester@example.com',
  summary: 'Checkout throws an error after payment.',
  steps: ['Open the demo store', 'Add an item to the cart', 'Pay with the shared test card'],
  expected: 'Order confirmation page appears.',
  actual: 'A server error page appears & the cart is emptied — صفحة خطأ.',
  timestamp: '2026-08-12 10:00',
  attachments: [],
};

const PARENT_STORY = JSON.stringify({
  id: 1234,
  fields: {
    'System.WorkItemType': 'User Story',
    'System.Title': 'Sample checkout story',
    'System.State': 'Active',
    'System.AreaPath': 'DemoProject\\Web',
    'System.IterationPath': 'DemoProject\\Sprint 9',
  },
});
const R_SHOW = { match: ['show'], stdout: PARENT_STORY };
const R_QUERY_EMPTY = { match: ['query'], stdout: '[]' };
const ROUTES_EXEC = [
  R_SHOW, R_QUERY_EMPTY,
  { match: ['attachments'], stdout: '{"id":"att-1","url":"https://dev.azure.com/demo-org/att/1"}' },
  { match: ['create'], stdout: '{"id":900}' },
  { match: ['relation'], stdout: '{}' },
  { match: ['workitems'], stdout: '{}' },
];

function run(cliArgs, { spec, routes = [], env = {} } = {}) {
  setRoutes(routes);
  const args = [...cliArgs];
  if (spec) {
    const sp = path.join(FIX, `spec-${specSeq++}.json`);
    fs.writeFileSync(sp, JSON.stringify(spec));
    args.unshift('--spec', sp);
  }
  return new Promise((resolve) => {
    const e = { ...process.env };
    for (const k of Object.keys(e)) if (k.toUpperCase().startsWith('AZURE_')) delete e[k];
    Object.assign(e, env);
    const pk = Object.keys(e).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    e[pk] = SHIM + path.delimiter + (e[pk] || '');
    const p = spawn('node', [RUNNER, ...args], { cwd: FIX, env: e });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err, calls: readCalls() }));
  });
}

const isWrite = (c) => ['create', 'relation', 'attachments', 'workitems'].some((t) => c.args.includes(t));

async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ok -', name);
}

(async () => {
  try {
    // 1. FAIL: --spec is required
    await test('missing --spec fails with exit 2', async () => {
      const r = await run([], { routes: [] });
      assert.strictEqual(r.code, 2);
      assert.ok(r.err.includes('--spec <file.json> is required'));
    });

    // 2. FAIL: required spec field missing — never inferred
    await test('missing required spec field (severity) fails with exit 2', async () => {
      const spec = { ...baseSpec };
      delete spec.severity;
      const r = await run([], { spec, routes: [] });
      assert.strictEqual(r.code, 2);
      assert.ok(r.err.includes('spec.severity is required'));
      assert.strictEqual(r.calls.length, 0, 'must fail before any az call');
    });

    // 3. FAIL: invalid severity rejected against the whitelist
    await test('invalid severity fails with exit 2', async () => {
      const r = await run([], { spec: { ...baseSpec, severity: 'Very Bad' }, routes: [] });
      assert.strictEqual(r.code, 2);
      assert.ok(r.err.includes('severity must be one of'));
    });

    // 4. FAIL: invalid priority rejected
    await test('invalid priority fails with exit 2', async () => {
      const r = await run([], { spec: { ...baseSpec, priority: 9 }, routes: [] });
      assert.strictEqual(r.code, 2);
      assert.ok(r.err.includes('priority must be one of'));
    });

    // 5. SUCCESS (dry run): plan + az commands printed, nothing written, untrusted
    //    title only as @file in the printed commands, PAT nowhere in the output
    await test('dry run prints plan + @file commands, executes only reads, exit 0', async () => {
      const r = await run([], {
        spec: baseSpec,
        routes: [R_SHOW, R_QUERY_EMPTY],
        env: { AZURE_DEVOPS_EXT_PAT: 'fake-pat-abc-123' },
      });
      assert.strictEqual(r.code, 0);
      assert.ok(r.out.includes('=== PLAN (Bug create) ==='));
      assert.ok(r.out.includes('DRY RUN — nothing written'));
      assert.ok(r.out.includes('No screenshots attached'), 'evidence warning must appear in dry run');
      const would = r.out.split('\n').filter((l) => l.includes('[would run]'));
      assert.ok(would.length >= 3, 'create/relation/patch commands must be shown');
      const wjoined = would.join('\n');
      assert.ok(wjoined.includes(IS_WIN ? '"@' : "'@"), 'untrusted text must appear as @file');
      for (const frag of ['fails', 'الدفع', '%USERNAME%']) {
        assert.ok(!wjoined.includes(frag), `raw untrusted fragment in a printed az command: ${frag}`);
      }
      assert.ok(r.calls.length >= 2 && r.calls.every((c) => !isWrite(c)),
        'only the show/query reads may execute in a dry run');
      assert.ok(!r.out.includes('fake-pat') && !r.err.includes('fake-pat'), 'PAT must never be printed');
      assert.strictEqual(r.calls[0].pat, 'fake-pat-abc-123', 'az must receive the PAT via env');
    });

    // 6. FAIL: parent that is not a User Story is refused
    await test('parent that is not a User Story fails with exit 2', async () => {
      const task = JSON.stringify({ id: 1234, fields: { 'System.WorkItemType': 'Task', 'System.Title': 'T', 'System.State': 'New' } });
      const r = await run([], { spec: baseSpec, routes: [{ match: ['show'], stdout: task }] });
      assert.strictEqual(r.code, 2);
      assert.ok(r.err.includes('not a User Story'));
      assert.ok(r.calls.every((c) => !isWrite(c)));
    });

    // 7. BLOCKED: invalid attachment refused — but only AFTER the full transparency
    //    output (plan + az commands), per the in-code requirement
    await test('dry run with invalid attachment: transparency output first, then exit 2', async () => {
      const r = await run([], { spec: { ...baseSpec, attachments: [BAD_ATT] }, routes: [R_SHOW, R_QUERY_EMPTY] });
      assert.strictEqual(r.code, 2);
      assert.ok(r.out.includes('INVALID'), 'attachment must be reported invalid');
      assert.ok(r.out.includes('--- az write commands ---'), 'commands must still be shown');
      assert.ok(r.out.includes('DRY RUN — nothing written'), 'refusal must come after the dry-run output');
      assert.ok(r.err.includes('failed the structural check'));
      assert.ok(r.calls.every((c) => !isWrite(c)));
    });

    // 8. BLOCKED: possible duplicate refused on --execute without --allow-duplicate
    await test('--execute with duplicate title refuses before any write', async () => {
      const r = await run(['--execute'], {
        spec: { ...baseSpec, attachments: [PNG] },
        routes: [R_SHOW, { match: ['query'], stdout: '[{"id":42}]' }],
      });
      assert.strictEqual(r.code, 2);
      assert.ok(r.out.includes('IDEMPOTENCY'));
      assert.ok(r.err.includes('REFUSING to create a possible duplicate'));
      assert.ok(r.calls.every((c) => !isWrite(c)), 'no write may run before the duplicate refusal');
    });

    // 9. BLOCKED: evidence-less bug refused on --execute without --no-screenshots
    await test('--execute with no attachments refuses evidence-less bug', async () => {
      const r = await run(['--execute'], { spec: baseSpec, routes: [R_SHOW, R_QUERY_EMPTY] });
      assert.strictEqual(r.code, 2);
      assert.ok(r.err.includes('REFUSING to create an evidence-less bug'));
      assert.ok(r.calls.every((c) => !isWrite(c)));
    });

    // 10. SUCCESS (--execute): upload + create + parent link + repro PATCH; untrusted
    //     fields travel as @files and round-trip exactly; PAT stays out of output
    await test('--execute creates the bug: @file round-trip, parent link, repro via --in-file', async () => {
      const spec = { ...baseSpec, attachments: [PNG] };
      const r = await run(['--execute'], { spec, routes: ROUTES_EXEC, env: { AZURE_DEVOPS_EXT_PAT: 'fake-pat-abc-123' } });
      assert.strictEqual(r.code, 0, r.err);
      assert.ok(r.out.includes('Created Bug #900'));
      assert.ok(r.out.includes('BUG_ID=900'), 'machine-readable id line required');

      const create = r.calls.find((c) => c.args.includes('create'));
      assert.ok(create, 'create must have executed');
      const titleArg = create.args[create.args.indexOf('--title') + 1];
      assert.strictEqual(titleArg.charAt(0), '@', 'title must be @file-routed');
      assert.strictEqual(create.atFiles[titleArg].content, spec.title, 'title must round-trip byte-exact');
      const joined = create.args.join(' ');
      for (const frag of ['الدفع', '%USERNAME%']) {
        assert.ok(!joined.includes(frag), `raw untrusted fragment reached az argv: ${frag}`);
      }
      if (process.env.USERNAME) {
        assert.ok(!joined.includes(process.env.USERNAME), 'no %VAR% expansion may leak into the title');
      }
      // validated whitelist values may ride the command line; untrusted fields may not
      assert.ok(create.args.includes('Microsoft.VSTS.Common.Severity=2 - High'));
      const atFields = Object.values(create.atFiles).map((f) => f.content);
      assert.ok(atFields.includes('System.AssignedTo=qa.tester@example.com'), 'assignee must be @file-routed');
      assert.ok(atFields.some((c) => c.startsWith('System.AreaPath=')), 'area path must be @file-routed');

      const rel = r.calls.find((c) => c.args.includes('relation'));
      assert.ok(rel.args.includes('parent') && rel.args.includes('1234'), 'the only link is parent -> story');

      const patch = r.calls.find((c) => c.args.includes('workitems'));
      assert.ok(patch.inFile.includes('Microsoft.VSTS.TCM.ReproSteps'), 'repro HTML must travel via --in-file');
      assert.ok(patch.inFile.includes('https://dev.azure.com/demo-org/att/1'), 'screenshot must be embedded + attached');
      assert.ok(patch.inFile.includes('&amp;'), 'repro text must be HTML-escaped');
      assert.ok(patch.inFile.includes('صفحة'), 'Arabic repro text must survive to the patch body');

      assert.ok(!r.out.includes('fake-pat') && !r.err.includes('fake-pat'), 'PAT must never be printed');
    });

    // 11. --allow-duplicate proceeds past the idempotency warning
    await test('--execute --allow-duplicate proceeds despite duplicate title', async () => {
      const r = await run(['--execute', '--allow-duplicate'], {
        spec: { ...baseSpec, attachments: [PNG] },
        routes: [{ match: ['query'], stdout: '[{"id":42}]' }, ...ROUTES_EXEC],
      });
      assert.strictEqual(r.code, 0, r.err);
      assert.ok(r.out.includes('IDEMPOTENCY'), 'warning still shown');
      assert.ok(r.out.includes('BUG_ID=900'));
    });

    // 12. Regression guard (gap found & fixed 2026-08-12): spec.valueArea used to be
    //     passed raw on the command line (no fileArg), so on Windows cmd.exe expanded
    //     %VAR% sequences inside it — untrusted spec text could pull environment
    //     values (worst case the PAT via %AZURE_DEVOPS_EXT_PAT%) onto the az command
    //     line. valueArea is now untrusted/@file-routed like the other free-text
    //     fields; this test keeps it that way.
    await test('valueArea is @file-routed — %VAR% stays literal, nothing expands', async () => {
      const spec = { ...baseSpec, attachments: [PNG], valueArea: '%LEAK_CANARY%' };
      const r = await run(['--execute'], { spec, routes: ROUTES_EXEC, env: { LEAK_CANARY: 'canary-value-123' } });
      assert.strictEqual(r.code, 0, r.err);
      const create = r.calls.find((c) => c.args.includes('create'));
      const rawVa = create.args.find((a) => a.startsWith('Microsoft.VSTS.Common.ValueArea='));
      assert.strictEqual(rawVa, undefined, 'ValueArea must not ride the command line raw');
      const atFields = Object.values(create.atFiles).map((f) => f.content);
      assert.ok(atFields.includes('Microsoft.VSTS.Common.ValueArea=%LEAK_CANARY%'),
        'ValueArea must travel via @file with %VAR% kept literal');
      assert.ok(!create.args.join(' ').includes('canary-value-123'),
        'no cmd.exe expansion may reach az argv');
    });

    console.log(`\n${passed} passed`);
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
