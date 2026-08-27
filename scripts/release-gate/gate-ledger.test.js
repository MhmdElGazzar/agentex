'use strict';
// Unit tests for the release-gate teardown ledger.
// Run: node scripts/release-gate/gate-ledger.test.js — fully offline.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  openLedger, readLedger, recordEntry, setDisposition, checkLedger, finalizeLedger,
  defaultRunsDir, sanitizeEntry,
} = require('./gate-ledger.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ledger-')); }
function ledgerIn(dir, mode = 'live') {
  const file = path.join(dir, '.agentex', 'release-gate', 'ledger.json');
  openLedger(file, mode);
  return file;
}
const CLI = path.join(__dirname, 'gate-ledger.js');

(async () => {
  await test('open creates {run, mode, entries: []} with parent dirs; run is an ISO timestamp', async () => {
    const file = ledgerIn(tmp(), 'sentinel');
    const l = readLedger(file);
    assert.strictEqual(l.mode, 'sentinel');
    assert.deepStrictEqual(l.entries, []);
    assert.ok(!Number.isNaN(Date.parse(l.run)), `run parses as a date: ${l.run}`);
  });

  await test('open refuses to overwrite an existing ledger (fail closed)', async () => {
    const file = ledgerIn(tmp());
    assert.throws(() => openLedger(file, 'live'), /exists/i);
  });

  await test('record appends a created entry; live mode defaults status done + disposition pending', async () => {
    const file = ledgerIn(tmp(), 'live');
    recordEntry(file, { step: 'fixture-story', describe: 'Create fixture User Story (Arabic)', type: 'User Story', id: 12345 });
    const [e] = readLedger(file).entries;
    assert.deepStrictEqual(e, {
      step: 'fixture-story', describe: 'Create fixture User Story (Arabic)',
      kind: 'created', type: 'User Story', id: 12345, status: 'done', disposition: 'pending',
    });
  });

  await test('record in sentinel mode defaults status descriptor-only + disposition not-attempted', async () => {
    const file = ledgerIn(tmp(), 'sentinel');
    recordEntry(file, { step: 'fixture-story', describe: 'Create fixture User Story (Arabic)', type: 'User Story' });
    const [e] = readLedger(file).entries;
    assert.strictEqual(e.status, 'descriptor-only');
    assert.strictEqual(e.disposition, 'not-attempted');
    assert.ok(!('id' in e), 'no id in a descriptor-only entry unless given');
  });

  await test('record strips every url field, however deep (never-name rule: ADO URLs embed the org)', async () => {
    const file = ledgerIn(tmp(), 'live');
    recordEntry(file, {
      step: 's', describe: 'd', type: 'Bug', id: 7,
      url: 'https://dev.azure.com/some-org/x', extra: { url: 'https://dev.azure.com/some-org/y', keep: 1 },
    });
    const [e] = readLedger(file).entries;
    assert.ok(!JSON.stringify(e).includes('url'), JSON.stringify(e));
    assert.strictEqual(e.extra.keep, 1);
    // sanitizeEntry is the exported form of the same guarantee
    assert.deepStrictEqual(sanitizeEntry({ a: { URL: 'x' }, url: 'y', b: 2 }), { a: {}, b: 2 });
  });

  await test('disposition marks an entry terminal by id, with a reason', async () => {
    const file = ledgerIn(tmp(), 'live');
    recordEntry(file, { step: 'story', describe: 'd', type: 'User Story', id: 1 });
    recordEntry(file, { step: 'case-1', describe: 'd', type: 'Test Case', id: 2 });
    setDisposition(file, { id: 1, disposition: 'deleted' });
    setDisposition(file, { id: 2, disposition: 'undeletable-standard', reason: 'ADO has no standard delete for test artifacts' });
    const [a, b] = readLedger(file).entries;
    assert.strictEqual(a.disposition, 'deleted');
    assert.strictEqual(b.disposition, 'undeletable-standard');
    assert.match(b.reason, /standard delete/);
    assert.throws(() => setDisposition(file, { id: 99, disposition: 'deleted' }), /no ledger entry/i);
  });

  await test('disposition by step only addresses id-less entries — an id-bearing entry needs its id', async () => {
    const file = ledgerIn(tmp(), 'live');
    recordEntry(file, { step: 'design-test-cases', describe: 'TC with id', type: 'Test Case', id: 101 });
    recordEntry(file, { step: 'design-test-cases', describe: 'descriptor-only TC', type: 'Test Case' });
    setDisposition(file, { step: 'design-test-cases', disposition: 'undeletable-standard', reason: 'r' });
    const [withId, idless] = readLedger(file).entries;
    assert.strictEqual(idless.disposition, 'undeletable-standard', 'step fallback lands on the id-less entry');
    assert.strictEqual(withId.disposition, 'pending', 'the id-bearing entry is untouched by step addressing');
    recordEntry(file, { step: 'solo', describe: 'd', type: 'Bug', id: 7 });
    assert.throws(() => setDisposition(file, { step: 'solo', disposition: 'deleted' }), /no ledger entry/i,
      'an entry that carries an id is never matched by step (first-match-wins bug gone)');
  });

  await test('duplicate step names with distinct ids each get their own disposition (several Test Cases from one /design-test)', async () => {
    const file = ledgerIn(tmp(), 'live');
    recordEntry(file, { step: 'design-test-cases', describe: 'TC 1', type: 'Test Case', id: 101 });
    recordEntry(file, { step: 'design-test-cases', describe: 'TC 2', type: 'Test Case', id: 102 });
    setDisposition(file, { id: 101, disposition: 'undeletable-standard', reason: 'r' });
    setDisposition(file, { id: 102, disposition: 'undeletable-standard', reason: 'r' });
    const [a, b] = readLedger(file).entries;
    assert.strictEqual(a.disposition, 'undeletable-standard');
    assert.strictEqual(b.disposition, 'undeletable-standard');
    const r = checkLedger(file);
    assert.strictEqual(r.exitCode, 3);
    assert.deepStrictEqual(r.undeletableStandard.map((e) => e.id), [101, 102]);
  });

  await test('check: every created id deleted → ok, exit 0', async () => {
    const file = ledgerIn(tmp(), 'live');
    recordEntry(file, { step: 'story', describe: 'd', type: 'User Story', id: 1 });
    setDisposition(file, { id: 1, disposition: 'deleted' });
    const r = checkLedger(file);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.created, 1);
    assert.strictEqual(r.deleted, 1);
  });

  await test('check: terminal but undeletable-standard present → waivable, exit 3, ids surfaced', async () => {
    const file = ledgerIn(tmp(), 'live');
    recordEntry(file, { step: 'story', describe: 'd', type: 'User Story', id: 1 });
    recordEntry(file, { step: 'case-1', describe: 'd', type: 'Test Case', id: 2 });
    setDisposition(file, { id: 1, disposition: 'deleted' });
    setDisposition(file, { id: 2, disposition: 'undeletable-standard', reason: 'r' });
    const r = checkLedger(file);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exitCode, 3);
    assert.deepStrictEqual(r.undeletableStandard, [{ step: 'case-1', type: 'Test Case', id: 2 }]);
  });

  await test('check: any created id non-terminal (pending / live not-attempted) → FAIL, exit 1', async () => {
    const file = ledgerIn(tmp(), 'live');
    recordEntry(file, { step: 'story', describe: 'd', type: 'User Story', id: 1 });
    recordEntry(file, { step: 'bug', describe: 'd', type: 'Bug', id: 2, disposition: 'not-attempted' });
    setDisposition(file, { id: 1, disposition: 'deleted' });
    const r = checkLedger(file);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exitCode, 1);
    assert.deepStrictEqual(r.nonTerminal.map((e) => e.step), ['bug']);
  });

  await test('check: sentinel descriptor-only entries are complete without live ids (exit 0 / 3 with test cases)', async () => {
    const file = ledgerIn(tmp(), 'sentinel');
    recordEntry(file, { step: 'story', describe: 'd', type: 'User Story' });
    recordEntry(file, { step: 'task', describe: 'd', type: 'Task' });
    assert.strictEqual(checkLedger(file).exitCode, 0, 'descriptor-only + not-attempted is terminal in sentinel mode');
    recordEntry(file, { step: 'case-1', describe: 'd', type: 'Test Case' });
    setDisposition(file, { step: 'case-1', disposition: 'undeletable-standard', reason: 'r' });
    const r = checkLedger(file);
    assert.strictEqual(r.exitCode, 3, 'sentinel test-case classification still surfaces as waivable');
  });

  await test('check: a failed create with no id is terminal (nothing exists); failed WITH an id is not', async () => {
    const file = ledgerIn(tmp(), 'live');
    recordEntry(file, { step: 'a', describe: 'd', type: 'Bug', status: 'failed', disposition: 'not-attempted', reason: 'HTTP 400' });
    assert.strictEqual(checkLedger(file).exitCode, 0);
    recordEntry(file, { step: 'b', describe: 'd', type: 'Bug', id: 9, status: 'failed', disposition: 'not-attempted', reason: 'late throw' });
    assert.strictEqual(checkLedger(file).exitCode, 1, 'an id exists on the board → needs a terminal disposition');
  });

  await test('finalize copies the ledger dir (ledger + gate log) to <runs-dir>/<ts>/ — ts is filename-safe', async () => {
    const dir = tmp();
    const file = ledgerIn(dir, 'sentinel');
    fs.writeFileSync(path.join(path.dirname(file), 'gate.log'), 'lane log\n');
    const runsDir = path.join(tmp(), 'runs');
    const r = finalizeLedger(file, { runsDir });
    assert.ok(r.dest.startsWith(runsDir), r.dest);
    assert.ok(!path.basename(r.dest).includes(':'), 'no colons in the run dir name (Windows)');
    assert.ok(fs.existsSync(path.join(r.dest, 'ledger.json')));
    assert.ok(fs.existsSync(path.join(r.dest, 'gate.log')));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r.dest, 'ledger.json'), 'utf8')), readLedger(file));
  });

  await test('defaultRunsDir resolves the repo root at runtime — <repo>/.claude/release-gate/runs', async () => {
    const expectedRoot = path.resolve(__dirname, '..', '..');
    assert.strictEqual(defaultRunsDir(), path.join(expectedRoot, '.claude', 'release-gate', 'runs'));
  });

  await test('CLI: open / record / disposition / check exit codes 0-3-1, one JSON line on stdout', async () => {
    const file = path.join(tmp(), 'ledger.json');
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    assert.strictEqual(run('open', file, '--mode', 'live').status, 0);
    assert.strictEqual(run('record', file, '--step', 'story', '--describe', 'Create fixture story', '--type', 'User Story', '--id', '5').status, 0);
    let c = run('check', file);
    assert.strictEqual(c.status, 1, 'pending disposition → exit 1');
    assert.strictEqual(JSON.parse(c.stdout.trim()).ok, false);
    assert.strictEqual(run('disposition', file, '--id', '5', '--disposition', 'deleted').status, 0);
    c = run('check', file);
    assert.strictEqual(c.status, 0);
    assert.strictEqual(JSON.parse(c.stdout.trim()).deleted, 1);
    assert.strictEqual(run('record', file, '--step', 'case', '--describe', 'd', '--type', 'Test Case', '--id', '6', '--disposition', 'undeletable-standard', '--reason', 'no standard delete').status, 0);
    assert.strictEqual(run('check', file).status, 3, 'undeletable-standard present → exit 3 (waivable)');
    const bad = run('nonsense', file);
    assert.strictEqual(bad.status, 2, 'unknown command → exit 2');
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
