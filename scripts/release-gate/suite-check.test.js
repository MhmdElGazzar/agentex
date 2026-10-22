'use strict';
// Unit tests for the release gate's suite-membership check.
// Run: node scripts/release-gate/suite-check.test.js — fully offline: the
// tracker adapter is INJECTED (an in-memory suite with call recording); the CLI
// case runs `plan`, which sends nothing.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const gl = require('./gate-ledger.js');
const { runSuiteCheck } = require('./suite-check.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}
for (const k of Object.keys(process.env)) if (k.startsWith('AZURE_') || k === 'AGENTEX_CI') delete process.env[k];

const CLI = path.join(__dirname, 'suite-check.js');
function ledger(mode) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-sc-')), '.agentex', 'release-gate', 'ledger.json');
  gl.openLedger(file, mode);
  return file;
}

// An in-memory suite. addLands: false -> the add "succeeds" but nothing joins
// (the independent re-read must catch it). The add records what the ledger
// held at the moment of the request (write-ahead proof).
function suite({ members = [], addLands = true, addThrows = false, ledgerFile } = {}) {
  const state = new Set(members.map(Number));
  const calls = [];
  return {
    calls, state,
    async listSuiteCases(planId, suiteId) {
      calls.push({ op: 'listSuiteCases', planId, suiteId });
      return [...state].map((id) => ({ workItem: { id, name: `TC ${id}` } }));
    },
    async addCaseToSuite(planId, suiteId, ids, { execute = false } = {}) {
      const list = [].concat(ids).map(Number);
      calls.push({ op: 'addCaseToSuite', planId, suiteId, ids: list, execute, ledgerAtCall: ledgerFile ? gl.readLedger(ledgerFile).entries.map((e) => e.id) : null });
      if (!execute) return { op: 'addCaseToSuite', method: 'POST', url: `https://dev.azure.com/exampleorg/Sample%20Project/_apis/test/Plans/${planId}/suites/${suiteId}/testcases/${list.join(',')}?api-version=7.1`, headers: {} };
      if (addThrows) throw new Error('addCaseToSuite failed: HTTP 500');
      if (addLands) list.forEach((id) => state.add(id));
      return { ids: list, added: list, alreadyPresent: [], planId, suiteId };
    },
  };
}
const base = { plan: 3, suite: 4, pool: [77, 78, 79] };

(async () => {
  await test('run --execute: picks a NON-member pool case, ledgers it BEFORE the add, adds it, re-reads independently -> PASS', async () => {
    const file = ledger('live');
    const a = suite({ members: [77], ledgerFile: file });
    const r = await runSuiteCheck({ ...base, cmd: 'run', execute: true, ledgerFile: file, adapter: a });
    assert.strictEqual(r.exitCode, 0, JSON.stringify(r));
    assert.deepStrictEqual(r.added, [78]);
    const add = a.calls.find((c) => c.op === 'addCaseToSuite');
    assert.deepStrictEqual(add.ids, [78], 'never the existing member (the idempotent skip must not mask a broken add)');
    assert.deepStrictEqual(add.ledgerAtCall, [78], 'write-ahead: the entry is in the ledger before the add request');
    assert.deepStrictEqual(a.calls.map((c) => c.op), ['listSuiteCases', 'addCaseToSuite', 'listSuiteCases']);
    const e = gl.readLedger(file).entries[0];
    assert.deepStrictEqual([e.step, e.kind, e.type, e.id, e.planId, e.suiteId, e.disposition], ['suite-add', 'associated', 'suite-entry', 78, 3, 4, 'pending']);
    assert.strictEqual(r.line, 'suite-membership: PASS — added 1, re-read 1/1 members, removed at teardown');
  });

  await test('--count n adds n non-members', async () => {
    const file = ledger('live');
    const a = suite({ members: [] });
    const r = await runSuiteCheck({ ...base, count: 2, cmd: 'run', execute: true, ledgerFile: file, adapter: a });
    assert.deepStrictEqual(r.added, [77, 78]);
    assert.match(r.line, /added 2, re-read 2\/2/);
  });

  await test('every pool case already a member -> FAIL naming them as residue of an earlier teardown; nothing written', async () => {
    const file = ledger('live');
    const a = suite({ members: [77, 78, 79] });
    const r = await runSuiteCheck({ ...base, cmd: 'run', execute: true, ledgerFile: file, adapter: a });
    assert.strictEqual(r.exitCode, 1);
    assert.deepStrictEqual(r.residue, [77, 78, 79]);
    assert.match(r.line, /suite-membership: FAIL/);
    assert.match(r.line, /77, 78, 79/);
    assert.ok(!a.calls.some((c) => c.op === 'addCaseToSuite'));
    assert.deepStrictEqual(gl.readLedger(file).entries, []);
  });

  await test('the independent re-read misses a requested id -> FAIL naming it (the entry stays in the ledger for teardown)', async () => {
    const file = ledger('live');
    const a = suite({ members: [], addLands: false });
    const r = await runSuiteCheck({ ...base, cmd: 'run', execute: true, ledgerFile: file, adapter: a });
    assert.strictEqual(r.exitCode, 1, JSON.stringify(r));
    assert.deepStrictEqual(r.missing, [77]);
    assert.match(r.line, /FAIL.*77/);
    assert.strictEqual(gl.readLedger(file).entries.length, 1);
  });

  await test('the add itself fails -> FAIL naming the ids; the write-ahead entry is still owed a removal', async () => {
    const file = ledger('live');
    const r = await runSuiteCheck({ ...base, cmd: 'run', execute: true, ledgerFile: file, adapter: suite({ addThrows: true }) });
    assert.strictEqual(r.exitCode, 1);
    assert.match(r.line, /FAIL.*77/);
    assert.match(r.error, /HTTP 500/);
    assert.strictEqual(gl.checkLedger(file).exitCode, 1, 'pending until teardown removes it');
  });

  await test('sentinel `plan`: descriptors only (the add + the planned re-read); ZERO adapter reads/writes executed; entries descriptor-only', async () => {
    const file = ledger('sentinel');
    const a = suite({ members: [] });
    const r = await runSuiteCheck({ ...base, cmd: 'plan', ledgerFile: file, adapter: a });
    assert.strictEqual(r.exitCode, 0, JSON.stringify(r));
    assert.deepStrictEqual(a.calls.map((c) => [c.op, c.execute]), [['addCaseToSuite', false]], 'nothing but the execute:false descriptor');
    assert.deepStrictEqual(r.plan.map((p) => p.step), ['suite-add', 'membership-reread']);
    assert.strictEqual(r.plan[0].request.method, 'POST');
    assert.deepStrictEqual([r.plan[1].method, r.plan[1].route], ['GET', '_apis/testplan/Plans/3/Suites/4/TestCase']);
    const e = gl.readLedger(file).entries[0];
    assert.deepStrictEqual([e.kind, e.id, e.status, e.disposition], ['associated', 77, 'descriptor-only', 'not-attempted']);
    assert.ok(!JSON.stringify(gl.readLedger(file)).includes('dev.azure.com'), 'never-name: no url stored');
  });

  await test('usage: run without --execute, a missing pool/plan/suite, or an unknown command -> exit 2, nothing done', async () => {
    const file = ledger('live');
    const a = suite();
    for (const args of [{ cmd: 'run' }, { cmd: 'run', execute: true, pool: [] }, { cmd: 'plan', plan: undefined }, { cmd: 'nope' }]) {
      await assert.rejects(runSuiteCheck({ ...base, ledgerFile: file, adapter: a, ...args }), (e) => e.exitCode === 2, JSON.stringify(args));
    }
    assert.strictEqual(a.calls.length, 0);
  });

  await test('CLI `plan` with the real adapter: offline, one JSON line, exit 0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-sc-cli-'));
    fs.writeFileSync(path.join(dir, '.env'), 'AZURE_PAT=EVAL_SENTINEL_PAT_suitecheck\nAZURE_URL=https://dev.azure.com/exampleorg\nAZURE_PROJECT=Sample Project\n');
    const file = path.join(dir, '.agentex', 'release-gate', 'ledger.json');
    gl.openLedger(file, 'sentinel');
    const r = spawnSync(process.execPath, [CLI, 'plan', '--project', dir, '--ledger', file, '--plan', '3', '--suite', '4', '--pool', '77,78'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1);
    const out = JSON.parse(lines[0]);
    assert.strictEqual(out.ok, true);
    assert.ok(!r.stdout.includes('EVAL_SENTINEL_PAT_suitecheck'));
  });

  await test('structural: no child_process, no process.exit, no npm dependency in suite-check.js', async () => {
    const src = fs.readFileSync(CLI, 'utf8');
    assert.ok(!/child_process|process\.exit\(/.test(src));
    for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) assert.ok(/^(node:|\.)/.test(m[1]), m[1]);
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
