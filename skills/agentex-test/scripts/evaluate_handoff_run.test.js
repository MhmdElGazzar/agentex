'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { runParallel } = require('./parallel.js');
const { parseArgs, evaluateHandoffRun } = require('./evaluate_handoff_run.js');

let sequence = 0;
async function fixture(status = 'passed') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-handoff-gate-'));
  const invocationId = `fixture-job-${++sequence}-${process.pid}`;
  const spec = 'test/check.md';
  fs.mkdirSync(path.join(cwd, 'test'));
  fs.writeFileSync(path.join(cwd, spec), '# Spec: Handoff check\n\n## Scenario\n1. Check fixture\n');
  const fakeCli = path.join(cwd, 'fake-cli.js');
  fs.writeFileSync(fakeCli, "if (process.argv.includes('list')) console.log('(no browsers)'); else console.log('closed');\n");
  const preflight = { node: { ok: true, version: process.version },
    'playwright-cli': { ok: true, status: 'READY', version: 'fixture',
      command: { executable: process.execPath, args: [fakeCli] } } };
  const handoff = path.join(cwd, 'handoff.json');
  const worker = assignment => {
    if (status === 'blocked') throw new Error('fixture worker startup failure');
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(assignment.sessionDir, 'executor-result.json'), JSON.stringify({
      schemaVersion: 1, runDir: assignment.runDir, session: assignment.session,
      spec: assignment.spec, status, startedAt: now, endedAt: now, durationMs: 1,
      scenarios: [{ name: 'Handoff scenario', session: assignment.session, status,
        steps: [{ desc: 'Check fixture', status }] }],
      defects: [], failures: status === 'failed' ? [{ kind: 'product', detail: 'controlled mismatch' }] : [],
      cleanup: { attempted: true, closed: true, error: null }
    }));
    return { outcome: 'completed' };
  };
  try {
    const output = await runParallel({ cwd, specs: [spec], targetUrl: 'http://127.0.0.1:12743/smoke.html',
      loginMode: 'none', worker, preflight, runHandoff: handoff, invocationId });
    const runRoot = path.join(cwd, output.runDir);
    return { cwd, handoff, invocationId, output, runRoot,
      readHandoff: () => JSON.parse(fs.readFileSync(handoff, 'utf8')),
      writeHandoff: value => fs.writeFileSync(handoff, JSON.stringify(value)),
      evaluate: extra => evaluateHandoffRun({ cwd, handoff, invocationId, ...extra }),
      close: () => fs.rmSync(cwd, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(cwd, { recursive: true, force: true }); throw error; }
}

test('CLI requires exact handoff and independent invocation identity', () => {
  assert.deepEqual(parseArgs(['--handoff', 'x', '--invocation-id', 'job-12345']),
    { handoff: 'x', invocationId: 'job-12345', flakyPolicy: 'review' });
  for (const args of [[], ['--handoff', 'x'], ['--invocation-id', 'job-12345'],
    ['--handoff', 'x', '--invocation-id'], ['--handoff', 'x', '--invocation-id', 'job-12345', '--unknown', 'x']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('real coordinator PASS handoff reaches real gate and preserves CLI exit 0', async () => {
  const f = await fixture();
  try {
    const handoff = f.readHandoff();
    const owner = JSON.parse(fs.readFileSync(path.join(f.runRoot, 'coordinator-owner.json')));
    assert.equal(handoff.invocationId, f.invocationId);
    assert.equal(owner.invocationId, f.invocationId);
    assert.equal(owner.runId, handoff.runId);
    const cli = spawnSync(process.execPath, [__filename.replace(/\.test\.js$/, '.js'),
      '--handoff', f.handoff, '--invocation-id', f.invocationId], { cwd: f.cwd, encoding: 'utf8' });
    assert.equal(cli.status, 0);
    const result = JSON.parse(cli.stdout.trim());
    assert.equal(result.decision, 'PASS'); assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.runRoot, 'gate-result.json'))), result);
  } finally { f.close(); }
});

test('real coordinator product failure preserves Phase 5 FAIL and CLI exit 1', async () => {
  const f = await fixture('failed');
  try {
    const result = f.evaluate();
    assert.equal(f.output.status, 'failed');
    assert.equal(result.decision, 'FAIL'); assert.equal(result.exitCode, 1);
    assert.equal(result.reasons[0].category, 'product');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.runRoot, 'gate-result.json'))), result);
  } finally { f.close(); }
});

test('real coordinator worker crash remains BLOCKED and gate REVIEW exit 2', async () => {
  const f = await fixture('blocked');
  try {
    const result = f.evaluate();
    assert.equal(f.output.status, 'blocked');
    assert.equal(result.decision, 'REVIEW'); assert.equal(result.exitCode, 2);
    assert.equal(result.reasons[0].category, 'infrastructure');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.runRoot, 'gate-result.json'))), result);
  } finally { f.close(); }
});

test('missing handoff never discovers an available execution directory', async () => {
  const f = await fixture();
  try {
    const result = f.evaluate({ handoff: path.join(f.cwd, 'missing.json') });
    assert.equal(result.reasons[0].code, 'handoff-missing');
    assert.equal(fs.existsSync(path.join(f.runRoot, 'gate-result.json')), false);
  } finally { f.close(); }
});

test('malformed, unsupported, and legacy handoffs fail closed', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(f.handoff, '{bad');
    assert.equal(f.evaluate().reasons[0].code, 'handoff-malformed');
    const runDir = f.output.runDir;
    f.writeHandoff({ schemaVersion: 2, runId: path.basename(runDir), runDir, invocationId: f.invocationId });
    assert.equal(f.evaluate().reasons[0].code, 'handoff-schema-unsupported');
    f.writeHandoff({ schemaVersion: 1, runId: path.basename(runDir), runDir });
    assert.equal(f.evaluate().reasons[0].code, 'handoff-identity-invalid');
    assert.equal(fs.existsSync(path.join(f.runRoot, 'gate-result.json')), false);
  } finally { f.close(); }
});

test('run ID mismatch, traversal, absolute run path, and missing run are rejected', async () => {
  const f = await fixture();
  try {
    const good = f.readHandoff();
    const checks = [
      [{ ...good, runId: 'execu_other' }, 'run-id-mismatch'],
      [{ ...good, runDir: 'executions/../other' }, 'run-path-invalid'],
      [{ ...good, runDir: f.runRoot }, 'run-path-invalid'],
      [{ ...good, runId: 'execu_missing', runDir: 'executions/execu_missing' }, 'run-missing'],
    ];
    for (const [bad, code] of checks) {
      f.writeHandoff(bad);
      assert.equal(f.evaluate().reasons[0].code, code);
    }
    assert.equal(fs.existsSync(path.join(f.runRoot, 'gate-result.json')), false);
  } finally { f.close(); }
});

test('missing, malformed, mismatched, and symlinked owner markers cannot authorize gate', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.runRoot, 'coordinator-owner.json');
    const original = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    assert.equal(f.evaluate().reasons[0].code, 'owner-missing');
    fs.writeFileSync(file, '{bad');
    assert.equal(f.evaluate().reasons[0].code, 'owner-invalid');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), invocationId: 'another-job-12345' }));
    assert.equal(f.evaluate().reasons[0].code, 'owner-mismatch');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), runId: 'execu_other' }));
    assert.equal(f.evaluate().reasons[0].code, 'owner-mismatch');
    fs.writeFileSync(file, original);
    assert.equal(fs.existsSync(path.join(f.runRoot, 'gate-result.json')), false);
  } finally { f.close(); }
});

test('relative and absolute handoff paths work; relative escape and directory are refused', async () => {
  const f = await fixture();
  try {
    assert.equal(f.evaluate({ handoff: 'handoff.json' }).decision, 'PASS');
    assert.equal(f.evaluate({ handoff: '../outside.json' }).reasons[0].code, 'handoff-path-escape');
    assert.equal(f.evaluate({ handoff: f.cwd }).reasons[0].code, 'handoff-path-invalid');
  } finally { f.close(); }
});

test('Unicode handoff path, wrong project root, and symlink escape fail or resolve safely', async t => {
  const f = await fixture();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-other-project-'));
  try {
    const unicode = path.join(f.cwd, 'job-مرحبا.json');
    fs.copyFileSync(f.handoff, unicode);
    assert.equal(f.evaluate({ handoff: unicode }).decision, 'PASS');
    assert.equal(evaluateHandoffRun({ cwd: other, handoff: unicode,
      invocationId: f.invocationId }).reasons[0].code, 'run-missing');
    const link = path.join(f.cwd, 'linked-handoff.json');
    try { fs.symlinkSync(f.handoff, link, 'file'); }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.diagnostic('symlink creation unavailable on this agent'); return; }
      throw error;
    }
    assert.equal(f.evaluate({ handoff: link }).reasons[0].code, 'handoff-symlink');
  } finally { f.close(); fs.rmSync(other, { recursive: true, force: true }); }
});

test('incomplete finalization never invokes gate or repairs reports', async () => {
  const f = await fixture();
  try {
    const report = path.join(f.runRoot, 'report.md');
    fs.unlinkSync(report);
    const summary = fs.readFileSync(path.join(f.runRoot, 'run-summary.json'));
    const result = f.evaluate();
    assert.equal(result.decision, 'REVIEW'); assert.equal(result.exitCode, 2);
    assert.equal(result.reasons[0].code, 'run-not-finalized');
    assert.equal(fs.existsSync(report), false);
    assert.deepEqual(fs.readFileSync(path.join(f.runRoot, 'run-summary.json')), summary);
    assert.equal(fs.existsSync(path.join(f.runRoot, 'gate-result.json')), false);
  } finally { f.close(); }
});

test('missing summary or terminal timing never produces a gate verdict', async () => {
  for (const missing of ['run-summary.json', 'parallel-timing.json']) {
    const f = await fixture();
    try {
      fs.unlinkSync(path.join(f.runRoot, missing));
      assert.equal(f.evaluate().reasons[0].code, 'run-not-finalized');
      assert.equal(fs.existsSync(path.join(f.runRoot, 'gate-result.json')), false);
    } finally { f.close(); }
  }
});

test('malformed summary and inconsistent counts delegate to Phase 5 integrity policy', async () => {
  for (const kind of ['malformed', 'count']) {
    const f = await fixture();
    try {
      const file = path.join(f.runRoot, 'run-summary.json');
      if (kind === 'malformed') fs.writeFileSync(file, '{broken');
      else {
        const summary = JSON.parse(fs.readFileSync(file));
        summary.summary.passed = 99;
        fs.writeFileSync(file, JSON.stringify(summary));
      }
      const result = f.evaluate();
      assert.equal(result.decision, 'REVIEW'); assert.equal(result.exitCode, 2);
      assert.equal(result.reasons[0].category, 'integrity');
      assert.ok(fs.existsSync(path.join(f.runRoot, 'gate-result.json')));
    } finally { f.close(); }
  }
});

test('two jobs cannot swap handoffs, reuse stale identity, or overwrite each other verdict', async () => {
  const a = await fixture(), b = await fixture();
  try {
    assert.notEqual(a.runRoot, b.runRoot);
    assert.notEqual(a.invocationId, b.invocationId);
    assert.equal(a.evaluate({ handoff: b.handoff }).reasons[0].code, 'invocation-mismatch');
    assert.equal(b.evaluate({ handoff: a.handoff }).reasons[0].code, 'invocation-mismatch');
    assert.equal(a.evaluate({ invocationId: 'later-job-12345' }).reasons[0].code, 'invocation-mismatch');
    assert.equal(fs.existsSync(path.join(a.runRoot, 'gate-result.json')), false);
    assert.equal(fs.existsSync(path.join(b.runRoot, 'gate-result.json')), false);
    assert.equal(a.evaluate().decision, 'PASS');
    assert.equal(b.evaluate().decision, 'PASS');
    assert.ok(fs.existsSync(path.join(a.runRoot, 'gate-result.json')));
    assert.ok(fs.existsSync(path.join(b.runRoot, 'gate-result.json')));
  } finally { a.close(); b.close(); }
});

test('duplicate gate invocation preserves original provider-neutral artifact', async () => {
  const f = await fixture();
  try {
    assert.equal(f.evaluate().decision, 'PASS');
    const file = path.join(f.runRoot, 'gate-result.json');
    const original = fs.readFileSync(file);
    assert.equal(f.evaluate().reasons[0].code, 'gate-result-exists');
    assert.deepEqual(fs.readFileSync(file), original);
  } finally { f.close(); }
});

test('metadata contains no URL, auth state, test body, or credentials', async () => {
  const f = await fixture();
  try {
    const body = fs.readFileSync(f.handoff, 'utf8') +
      fs.readFileSync(path.join(f.runRoot, 'coordinator-owner.json'), 'utf8');
    for (const forbidden of ['http://', 'https://', 'password', 'token', 'authState', 'Handoff scenario']) {
      assert.equal(body.includes(forbidden), false);
    }
  } finally { f.close(); }
});
