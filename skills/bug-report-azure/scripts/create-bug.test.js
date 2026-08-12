'use strict';
// Tests for the bug-report-azure scripts.
//   Run: node skills/bug-report-azure/scripts/create-bug.test.js
//
// Offline and deterministic: every `az` call goes to a shim on PATH that answers from a
// fixture and logs what it was asked, so the tests can assert on what the scripts did NOT
// do (the important half of a fail-closed guarantee). The one test that needs --execute
// points the org at 127.0.0.1:9 — the discard port — so `fetch` fails immediately without
// touching a network. Nothing here ever reaches a real Azure DevOps.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CREATE_BUG = path.join(__dirname, 'create-bug.js');
const LIB = path.join(__dirname, '_lib.js');

let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// ---- harness ---------------------------------------------------------------

// Every sandbox is tracked so the run can delete them all at the end. These land in the
// developer's real temp dir and Windows never sweeps it, so without this a test run left ~20
// folders behind permanently — they accumulated into hundreds.
const sandboxes = [];
function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-bug-'));
  sandboxes.push(d);
  return d;
}

// A fake `az` on PATH. Named per platform because _lib.js resolves az.cmd on Windows and az
// everywhere else. Every invocation is appended to az-calls.log so tests can assert on it.
function fakeAz(dir, opts = {}) {
  fs.writeFileSync(path.join(dir, 'fake-az.js'), `
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'az-calls.log'), JSON.stringify(a) + '\\n');
// Log what each --in-file carried: all user text lives in those payloads now, so this is the
// only place a test can prove it arrived unmangled.
const inFile = a.indexOf('--in-file');
if (inFile !== -1) {
  try { fs.appendFileSync(path.join(__dirname, 'az-payloads.log'), fs.readFileSync(a[inFile + 1], 'utf8') + '\\n'); }
  catch (e) { /* dry-run paths never write the file */ }
}
const has = (...w) => w.every((x) => a.includes(x));
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };

if (has('devops', 'configure')) {
  process.stdout.write('organization = https://example.visualstudio.com\\nproject = Proj\\n');
  process.exit(0);
}
if (has('work-item', 'show')) out({ id: 7, fields: {
  'System.WorkItemType': 'User Story', 'System.Title': 'Story', 'System.State': 'Active',
  'System.AreaPath': 'Proj\\\\Team', 'System.IterationPath': 'Proj\\\\Sprint 1' } });
if (has('--resource', 'wiql')) {
  if (${JSON.stringify(Boolean(opts.queryFails))}) {
    process.stderr.write('TF400598: simulated query failure\\n'); process.exit(1);
  }
  out({ workItems: ${JSON.stringify(opts.dupes || [])} });
}
if (has('workitemtypesfield')) out({ value: [
  { name: 'Environment', referenceName: 'Custom.Environment', alwaysRequired: true,
    allowedValues: ['1. Development', '2. Testing/QC', '3. UAT'] },
  { name: 'Title', referenceName: 'System.Title', alwaysRequired: true, allowedValues: [] } ] });
if (has('workitems') && a.includes('validateOnly=true')) {
  if (${JSON.stringify(Boolean(opts.rejectEnv))}) {
    process.stderr.write("ERROR: The field 'Environment' contains the value 'QC' that is not in the list of supported values\\n");
    process.exit(1);
  }
  out({ id: 0 });
}
if (has('workitems')) out({ id: 4242 });
if (has('relation', 'add')) out({});
process.stderr.write('fake-az: unhandled: ' + a.join(' ') + '\\n');
process.exit(1);
`);
  if (process.platform === 'win32') {
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

function azPayloads(dir) {
  const f = path.join(dir, 'az-payloads.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

// A structurally valid PNG: the header fields structuralCheck reads, padded past its 2 KB floor.
function png(dir, name, w = 800, h = 600) {
  const buf = Buffer.alloc(8 * 1024, 0x41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); buf.write('IHDR', 12);
  buf.writeUInt32BE(w, 16); buf.writeUInt32BE(h, 20);
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

function writeSpec(dir, over = {}, { bom = false } = {}) {
  const spec = {
    title: 'Defect title', severity: '2 - High', priority: 1, parentStoryId: 7,
    assignedTo: 'dev@example.com', summary: 'summary', steps: ['step one'],
    expected: 'expected', actual: 'actual', environment: '2. Testing/QC',
    attachments: [], ...over,
  };
  const p = path.join(dir, 'spec.json');
  fs.writeFileSync(p, (bom ? '﻿' : '') + JSON.stringify(spec, null, 2));
  return p;
}

function runCreateBug(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [CREATE_BUG, ...args], {
    cwd: dir, encoding: 'utf8',
    env: {
      ...process.env,
      PATH: dir + path.delimiter + process.env.PATH,
      Path: dir + path.delimiter + (process.env.Path || ''),
      AZURE_URL: 'https://example.visualstudio.com', AZURE_PROJECT: 'Proj',
      AZURE_DEVOPS_ORG_URL: '', AZURE_DEVOPS_DEFAULT_PROJECT: '',
      AZURE_DEVOPS_EXT_PAT: 'fake-pat-for-tests',
      ...env,
    },
  });
  return { ...r, out: (r.stdout || '') + (r.stderr || '') };
}

// ---- config aliases (unit) --------------------------------------------------

console.log('\nconfig aliases');

function loadConfigIn(dir, env) {
  // loadConfig reads process.cwd() and process.env, so exercise it in a child with a clean
  // environment rather than mutating this process's.
  const script = `process.chdir(${JSON.stringify(dir)});
    console.log(JSON.stringify(require(${JSON.stringify(LIB)}).loadConfig()));`;
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: dir, encoding: 'utf8',
    env: {
      ...process.env, AZURE_URL: '', AZURE_PROJECT: '', AZURE_DEVOPS_ORG_URL: '',
      AZURE_DEVOPS_DEFAULT_PROJECT: '', AZURE_ORG: '', AZURE_ITERATION_PATH: '', ...env,
    },
  });
  assert.strictEqual(r.status, 0, `loadConfig failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('legacy AZURE_URL / AZURE_PROJECT resolve', () => {
  const dir = sandbox();
  const cfg = loadConfigIn(dir, { AZURE_URL: 'https://old.example.com/', AZURE_PROJECT: 'Legacy' });
  assert.strictEqual(cfg.org, 'https://old.example.com');   // trailing slash stripped
  assert.strictEqual(cfg.project, 'Legacy');
});

test('AZURE_DEVOPS_ORG_URL / AZURE_DEVOPS_DEFAULT_PROJECT resolve', () => {
  const dir = sandbox();
  const cfg = loadConfigIn(dir, {
    AZURE_DEVOPS_ORG_URL: 'https://new.example.com', AZURE_DEVOPS_DEFAULT_PROJECT: 'Modern',
  });
  assert.strictEqual(cfg.org, 'https://new.example.com');
  assert.strictEqual(cfg.project, 'Modern');
});

test('config/project.json azure block outranks both env spellings', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'project.json'),
    JSON.stringify({ azure: { org: 'https://json.example.com', project: 'FromJson' } }));
  const cfg = loadConfigIn(dir, { AZURE_URL: 'https://old.example.com', AZURE_PROJECT: 'Legacy' });
  assert.strictEqual(cfg.org, 'https://json.example.com');
  assert.strictEqual(cfg.project, 'FromJson');
});

test('AZURE_ITERATION_PATH is resolved into config (not dead)', () => {
  const dir = sandbox();
  const cfg = loadConfigIn(dir, { AZURE_ITERATION_PATH: 'Proj\\Sprint 9' });
  assert.strictEqual(cfg.iterationPath, 'Proj\\Sprint 9');
});

// ---- picklist rejection parsing (unit) --------------------------------------

console.log('\npicklist rejection parsing');

const { parseFieldRejection } = require('./_lib.js');

test('parses an invalid picklist value', () => {
  const hit = parseFieldRejection(
    "ERROR: The field 'Environment' contains the value 'QC' that is not in the list of supported values");
  assert.deepStrictEqual(hit, { field: 'Environment', value: 'QC', kind: 'not-in-list' });
});

test('parses a required-field rule error', () => {
  const hit = parseFieldRejection('TF401320: Rule Error for field Bug Category. Error code: Required, HasValues');
  assert.strictEqual(hit.kind, 'required');
  assert.strictEqual(hit.field, 'Bug Category');
});

test('returns null for an unrelated error', () => {
  assert.strictEqual(parseFieldRejection('TF400813: user is not authorized'), null);
});

// ---- dry-run behaviour ------------------------------------------------------

console.log('\ndry run');

test('no attachments: prints no upload and no AttachedFile relation', () => {
  const dir = sandbox(); fakeAz(dir);
  const spec = writeSpec(dir, { attachments: [] });
  const r = runCreateBug(dir, ['--spec', spec]);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(!/_apis\/wit\/attachments/.test(r.out), 'printed an attachment upload with no attachments');
  assert.ok(!/AttachedFile/.test(r.out), 'printed an AttachedFile relation with no attachments');
  assert.ok(/1 op\(s\)/.test(r.out), 'repro patch should carry exactly one op');
});

test('with attachments: prints one upload each and one relation each', () => {
  const dir = sandbox(); fakeAz(dir);
  const spec = writeSpec(dir, { attachments: [png(dir, 'a.png'), png(dir, 'b.png')] });
  const r = runCreateBug(dir, ['--spec', spec]);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual((r.out.match(/_apis\/wit\/attachments/g) || []).length, 2);
  assert.strictEqual((r.out.match(/AttachedFile/g) || []).length, 2);
  assert.ok(/3 op\(s\)/.test(r.out), 'repro patch should carry the repro plus two relations');
});

test('dry run writes nothing: no create, no relation add', () => {
  const dir = sandbox(); fakeAz(dir);
  const r = runCreateBug(dir, ['--spec', writeSpec(dir)]);
  assert.strictEqual(r.status, 0, r.out);
  const calls = azCalls(dir);
  assert.ok(calls.some((c) => c.includes('validateOnly=true')), 'should have validated');
  assert.ok(!calls.some((c) => c.includes('relation')), 'dry run must not add relations');
  const creates = calls.filter((c) => c.includes('workitems') && !c.includes('validateOnly=true'));
  assert.strictEqual(creates.length, 0, 'dry run must not create the work item');
});

test('a long ReproSteps never reaches a command line', () => {
  const dir = sandbox(); fakeAz(dir);
  // ~20k of repro: far past cmd.exe's 8191-char command cap.
  const spec = writeSpec(dir, {
    steps: Array.from({ length: 40 }, (_, i) => `step ${i} ` + 'x'.repeat(300)),
    expected: 'e'.repeat(3000), actual: 'a'.repeat(3000),
  });
  const r = runCreateBug(dir, ['--spec', spec]);
  assert.strictEqual(r.status, 0, r.out);
  for (const c of azCalls(dir)) {
    const joined = c.join(' ');
    assert.ok(!/ReproSteps/.test(joined), 'ReproSteps must never be passed as an az argument');
    assert.ok(joined.length < 8191, `az command line reached ${joined.length} chars`);
  }
  assert.ok(/add \/fields\/Microsoft\.VSTS\.TCM\.ReproSteps/.test(r.out), 'repro should go via the JSON Patch');
});

// ---- fail-closed guarantees -------------------------------------------------

console.log('\nfail-closed');

test('a rejected picklist value stops the dry run and lists the real values', () => {
  const dir = sandbox(); fakeAz(dir, { rejectEnv: true });
  const spec = writeSpec(dir, { environment: 'QC', attachments: [png(dir, 'a.png')] });
  const r = runCreateBug(dir, ['--spec', spec]);
  assert.strictEqual(r.status, 2, r.out);
  assert.ok(/not in the list of supported values/.test(r.out), 'should show the exact az error');
  assert.ok(/2\. Testing\/QC/.test(r.out), 'should list the real allowed values');
  assert.ok(/ASK THE USER/.test(r.out), 'should hand the choice back to the user');
  assert.ok(!azCalls(dir).some((c) => c.includes('relation')), 'nothing may be written');
});

test('duplicate-check failure refuses to create under --execute', () => {
  const dir = sandbox(); fakeAz(dir, { queryFails: true });
  const spec = writeSpec(dir, { attachments: [png(dir, 'a.png')] });
  const r = runCreateBug(dir, ['--spec', spec, '--execute']);
  assert.strictEqual(r.status, 2, r.out);
  assert.ok(/IDEMPOTENCY CHECK FAILED/.test(r.out));
  assert.ok(/--allow-duplicate/.test(r.out), 'should name the explicit override');
  const creates = azCalls(dir).filter((c) => c.includes('workitems') && !c.includes('validateOnly=true'));
  assert.strictEqual(creates.length, 0, 'must not create after a failed duplicate check');
});

test('an existing same-title Bug refuses to create under --execute', () => {
  const dir = sandbox(); fakeAz(dir, { dupes: [{ id: 99 }] });
  const spec = writeSpec(dir, { attachments: [png(dir, 'a.png')] });
  const r = runCreateBug(dir, ['--spec', spec, '--execute']);
  assert.strictEqual(r.status, 2, r.out);
  assert.ok(/#99/.test(r.out), 'should name the duplicate');
});

test('upload failure aborts before the Bug is created', () => {
  const dir = sandbox(); fakeAz(dir);
  const spec = writeSpec(dir, { attachments: [png(dir, 'a.png')] });
  // Discard port: the upload's fetch is refused at once, offline and deterministically.
  const r = runCreateBug(dir, ['--spec', spec, '--execute'],
    { AZURE_URL: 'http://127.0.0.1:9', AZURE_PROJECT: 'Proj' });
  assert.strictEqual(r.status, 2, r.out);
  assert.ok(/upload FAILED/.test(r.out));
  assert.ok(/Nothing has been written to/.test(r.out));
  assert.ok(/--allow-failed-upload/.test(r.out), 'should name the explicit override');
  const creates = azCalls(dir).filter((c) => c.includes('workitems') && !c.includes('validateOnly=true'));
  assert.strictEqual(creates.length, 0, 'must not create after a failed upload');
});

test('an evidence-less bug is refused without --no-screenshots', () => {
  const dir = sandbox(); fakeAz(dir);
  const r = runCreateBug(dir, ['--spec', writeSpec(dir, { attachments: [] }), '--execute']);
  assert.strictEqual(r.status, 2, r.out);
  assert.ok(/REFUSING to create an evidence-less bug/.test(r.out));
});

test('--force skips a structurally invalid attachment instead of uploading it', () => {
  const dir = sandbox(); fakeAz(dir);
  const bad = path.join(dir, 'bad.png');
  fs.writeFileSync(bad, 'not an image');
  const spec = writeSpec(dir, { attachments: [png(dir, 'ok.png'), bad] });
  const r = runCreateBug(dir, ['--spec', spec, '--force']);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(/will be SKIPPED, not uploaded/.test(r.out));
  assert.strictEqual((r.out.match(/_apis\/wit\/attachments/g) || []).length, 1,
    'only the valid attachment should be uploaded');
});

// ---- user text never reaches a shell ---------------------------------------

console.log('\nuser text never reaches a shell');

test('a title carrying a live %VAR% survives intact into every payload', () => {
  // cmd.exe expands %NAME% inside double quotes with no escape available, so the title is
  // kept off the command line entirely — both in the duplicate-check WIQL and in the create.
  const dir = sandbox(); fakeAz(dir);
  const title = 'Upload fails when %AGENTEX_TEST_VAR% is long';
  const spec = writeSpec(dir, { title, attachments: [png(dir, 'a.png')] });
  const r = runCreateBug(dir, ['--spec', spec], { AGENTEX_TEST_VAR: 'expanded-value' });
  assert.strictEqual(r.status, 0, r.out);
  const payloads = azPayloads(dir);
  assert.ok(payloads.includes(title), 'the title must reach the payload exactly as typed');
  assert.ok(!payloads.includes('expanded-value'), 'the variable must NOT have been expanded');
  assert.ok(!azCalls(dir).some((c) => c.some((x) => String(x).includes('AGENTEX_TEST_VAR'))),
    'the title must not reach any command line');
});

test('the duplicate check queries by WIQL in a file, not on the command line', () => {
  const dir = sandbox(); fakeAz(dir, { dupes: [{ id: 99 }] });
  const r = runCreateBug(dir, ['--spec', writeSpec(dir, { attachments: [png(dir, 'a.png')] })]);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(/SELECT \[System\.Id\] FROM workitems/.test(azPayloads(dir)), 'WIQL goes in the payload');
  assert.ok(/#99/.test(r.out), 'and the result is still read back correctly');
  assert.ok(!azCalls(dir).some((c) => c.some((x) => String(x).includes('SELECT'))),
    'no WIQL may appear as a command-line argument');
});

// ---- spec robustness --------------------------------------------------------

console.log('\nspec parsing');

test('a UTF-8 BOM in the spec does not crash the run', () => {
  const dir = sandbox(); fakeAz(dir);
  const r = runCreateBug(dir, ['--spec', writeSpec(dir, {}, { bom: true })]);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(!/SyntaxError/.test(r.out));
});

test('a malformed spec reports a readable error, not a stack trace', () => {
  const dir = sandbox(); fakeAz(dir);
  const p = path.join(dir, 'broken.json');
  fs.writeFileSync(p, '{ "title": ');
  const r = runCreateBug(dir, ['--spec', p]);
  assert.strictEqual(r.status, 2, r.out);
  assert.ok(/could not read the spec/.test(r.out));
  assert.ok(!/at JSON\.parse/.test(r.out), 'should not print a stack trace');
});

test('a missing required spec field is refused', () => {
  const dir = sandbox(); fakeAz(dir);
  const spec = writeSpec(dir);
  const j = JSON.parse(fs.readFileSync(spec, 'utf8'));
  delete j.severity;
  fs.writeFileSync(spec, JSON.stringify(j));
  const r = runCreateBug(dir, ['--spec', spec]);
  assert.strictEqual(r.status, 2, r.out);
  assert.ok(/spec\.severity is required/.test(r.out));
});

// ---- summary ----------------------------------------------------------------

try {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) failures.forEach((f) => console.error(`  - ${f}`));
} finally {
  // Leave no sandboxes behind — these live in the developer's real temp dir.
  for (const d of sandboxes) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
process.exit(failures.length ? 1 : 0);
