'use strict';
// Unit tests for the release-gate teardown orchestrator.
// Run: node scripts/release-gate/teardown.test.js — fully offline: the tracker
// adapter is INJECTED (fake with call recording); the CLI case runs sentinel
// mode, where only execute:false descriptors are composed (zero network).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const gl = require('./gate-ledger.js');
const { runTeardown } = require('./teardown.js');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

for (const k of Object.keys(process.env)) if (k.startsWith('AZURE_')) delete process.env[k];

const CLI = path.join(__dirname, 'teardown.js');
const PAT = 'EVAL_SENTINEL_PAT_teardown1';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-td-')); }

// A throwaway project with a ledger, a gate log, and a sentinel .env.
function throwaway(mode, entries) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'),
    `AZURE_PAT=${PAT}\nAZURE_URL=https://dev.azure.com/exampleorg\nAZURE_PROJECT=Sample Project\n`);
  const ledgerFile = path.join(dir, '.agentex', 'release-gate', 'ledger.json');
  gl.openLedger(ledgerFile, mode);
  for (const e of entries) gl.recordEntry(ledgerFile, e);
  fs.writeFileSync(path.join(path.dirname(ledgerFile), 'gate.log'), 'lane log — clean\n');
  return { dir, ledgerFile };
}

// Env source for the scan — values the throwaway also uses.
function envSource() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), `AZURE_PAT=${PAT}\n`);
  return dir;
}

function fakeAdapter({ failIds = [] } = {}) {
  const calls = [];
  return {
    calls,
    async deleteWorkItem(id, { execute = false } = {}) {
      calls.push({ id: Number(id), execute });
      if (execute && failIds.includes(Number(id))) throw new Error('HTTP 500 — delete failed');
      const url = `https://dev.azure.com/exampleorg/Sample%20Project/_apis/wit/workitems/${Number(id)}?api-version=7.1`;
      return execute ? { id: Number(id) } : { op: 'deleteWorkItem', method: 'DELETE', url, headers: { authorization: '<Basic ***, not printed>' } };
    },
  };
}

(async () => {
  await test('live: deletable ids deleted, Test Cases never delete-attempted → exit 3 (waivable), folder removed', async () => {
    const { dir } = throwaway('live', [
      { step: 'story', describe: 'd', type: 'User Story', id: 1 },
      { step: 'task', describe: 'd', type: 'Task', id: 2 },
      { step: 'case-1', describe: 'd', type: 'Test Case', id: 3 },
    ]);
    const adapter = fakeAdapter();
    const r = await runTeardown({ dir, adapter, runsDir: path.join(tmp(), 'runs'), envFromDir: envSource() });
    assert.strictEqual(r.exitCode, 3);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(adapter.calls, [{ id: 1, execute: true }, { id: 2, execute: true }], 'the Test Case id is never delete-attempted');
    assert.strictEqual(r.projectRemoved, true);
    assert.ok(!fs.existsSync(dir), 'throwaway folder gone');
    const surviving = JSON.parse(fs.readFileSync(path.join(r.survivingDir, 'ledger.json'), 'utf8'));
    assert.deepStrictEqual(surviving.entries.map((e) => e.disposition), ['deleted', 'deleted', 'undeletable-standard']);
    assert.ok(fs.existsSync(path.join(r.survivingDir, 'gate.log')), 'gate log survives beside the ledger');
  });

  await test('live: everything deletable and deleted → exit 0', async () => {
    const { dir } = throwaway('live', [
      { step: 'story', describe: 'd', type: 'User Story', id: 1 },
      { step: 'bug', describe: 'd', type: 'Bug', id: 4 },
    ]);
    const r = await runTeardown({ dir, adapter: fakeAdapter(), runsDir: path.join(tmp(), 'runs'), envFromDir: envSource() });
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.check.deleted, 2);
  });

  await test('live: a failed delete stays non-terminal with the reason → exit 1 FAIL, folder KEPT as evidence', async () => {
    const { dir } = throwaway('live', [
      { step: 'story', describe: 'd', type: 'User Story', id: 1 },
      { step: 'bug', describe: 'd', type: 'Bug', id: 4 },
    ]);
    const r = await runTeardown({ dir, adapter: fakeAdapter({ failIds: [4] }), runsDir: path.join(tmp(), 'runs'), envFromDir: envSource() });
    assert.strictEqual(r.exitCode, 1);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.projectRemoved, false);
    assert.ok(fs.existsSync(dir), 'throwaway folder kept on FAIL');
    const surviving = JSON.parse(fs.readFileSync(path.join(r.survivingDir, 'ledger.json'), 'utf8'));
    const bug = surviving.entries.find((e) => e.step === 'bug');
    assert.strictEqual(bug.disposition, 'pending');
    assert.match(bug.reason, /delete failed/);
  });

  await test('sentinel: only execute:false descriptors are composed (no destroy anywhere), exit 0 without test cases', async () => {
    const { dir } = throwaway('sentinel', [
      { step: 'story', describe: 'd', type: 'User Story', id: 90001 },
      { step: 'task', describe: 'd', type: 'Task' }, // descriptor-only, no fixture id
    ]);
    const adapter = fakeAdapter();
    const r = await runTeardown({ dir, adapter, runsDir: path.join(tmp(), 'runs'), envFromDir: envSource() });
    assert.strictEqual(r.exitCode, 0, JSON.stringify(r));
    assert.deepStrictEqual(adapter.calls, [{ id: 90001, execute: false }], 'descriptor composed only where a fixture id exists; nothing executed');
    assert.strictEqual(r.projectRemoved, true);
  });

  await test('sentinel: Test Case entries still classified undeletable-standard → exit 3 exercised offline', async () => {
    const { dir } = throwaway('sentinel', [
      { step: 'story', describe: 'd', type: 'User Story', id: 90001 },
      { step: 'case-1', describe: 'd', type: 'Test Case' },
    ]);
    const r = await runTeardown({ dir, adapter: fakeAdapter(), runsDir: path.join(tmp(), 'runs'), envFromDir: envSource() });
    assert.strictEqual(r.exitCode, 3);
    assert.deepStrictEqual(r.check.undeletableStandard.map((e) => e.step), ['case-1']);
  });

  await test('a secret in a surviving artifact fails the teardown (exit 1) and the folder is kept', async () => {
    const { dir, ledgerFile } = throwaway('sentinel', [
      { step: 'story', describe: 'd', type: 'User Story' },
    ]);
    fs.writeFileSync(path.join(path.dirname(ledgerFile), 'gate.log'), `oops: ${PAT}\n`);
    const r = await runTeardown({ dir, adapter: fakeAdapter(), runsDir: path.join(tmp(), 'runs'), envFromDir: envSource() });
    assert.strictEqual(r.exitCode, 1);
    assert.strictEqual(r.scan.ok, false);
    assert.strictEqual(r.projectRemoved, false);
    assert.ok(fs.existsSync(dir));
  });

  await test('CLI: sentinel run with the real adapter — offline, one JSON line, exit 3, no PAT printed', async () => {
    const { dir } = throwaway('sentinel', [
      { step: 'story', describe: 'd', type: 'User Story', id: 90001 },
      { step: 'case-1', describe: 'd', type: 'Test Case' },
    ]);
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('AZURE_')) delete env[k];
    const r = spawnSync(process.execPath,
      [CLI, dir, '--runs-dir', path.join(tmp(), 'runs'), '--env-from', envSource()],
      { encoding: 'utf8', env });
    assert.strictEqual(r.status, 3, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.strictEqual(out.mode, 'sentinel');
    assert.strictEqual(out.projectRemoved, true);
    assert.ok(!(r.stdout + r.stderr).includes(PAT), 'PAT never printed');
  });

  await test('missing ledger → exit 2 usage error, nothing deleted', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    const env = { ...process.env };
    const r = spawnSync(process.execPath, [CLI, dir, '--env-from', envSource()], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'keep.txt')));
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
