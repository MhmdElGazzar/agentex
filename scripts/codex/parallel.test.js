'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare, finalize } = require('./host');
const { gate, launch, finish, audit } = require('./parallel');
const { report } = require('./report');
const { sha256 } = require('../lib/execution_result');
const step = { id: 'check', assertionIds: ['visible'], evidenceRequired: true };
function setup(count = 2, hostCapacity = 2) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-parallel-'));
  return prepare({ projectRoot, mode: 'parallel', hostCapacity,
    scenarios: Array.from({ length: count }, (_, i) => ({ adHoc: `Drivers: api\napi: Inspect independent response ${i}`, requiredSteps: [step] })) });
}
function submit(c, i, outcome = 'PASS', mutate = () => {}) {
  const record = c.assignments[i], a = JSON.parse(fs.readFileSync(record.assignmentFile));
  const rel = `browser-sessions/${record.sessionId}/logs/check.txt`;
  const evidence = path.join(c.runRoot, rel);
  fs.writeFileSync(evidence, `observed ${outcome}`);
  const fail = outcome === 'FAIL', blocked = outcome === 'BLOCKED';
  const result = { schemaVersion: 1, runId: a.runId, attemptId: a.attemptId,
    assignmentId: a.assignmentId, assignmentDigest: a.assignmentDigest,
    sourceDigest: a.source.digest, scope: a.scope, sessionId: a.sessionId,
    steps: [{ stepId: 'check', runId: a.runId, attemptId: a.attemptId,
      assignmentId: a.assignmentId, sessionId: a.sessionId, outcome,
      assertions: blocked ? [] : [{ id: 'visible', passed: !fail }],
      expected: 'visible expected status', observed: fail ? 'visible unexpected status' : 'visible expected status',
      evidence: [{ path: rel, sha256: sha256(fs.readFileSync(evidence)) }] }],
    cleanup: { runId: a.runId, attemptId: a.attemptId, assignmentId: a.assignmentId,
      sessionId: a.sessionId, status: 'completed' }, scenarioOutcome: outcome,
    summary: { total: 1, passed: outcome === 'PASS' ? 1 : 0, failed: fail ? 1 : 0,
      blocked: blocked ? 1 : 0, warnings: 0, flaky: 0 },
    verdict: outcome, exitCode: { PASS: 0, FAIL: 1, BLOCKED: 2 }[outcome] };
  mutate(result, evidence);
  fs.writeFileSync(record.resultFile, JSON.stringify(result));
  return record;
}
function metadata(c) {
  const startedAt = '2026-10-12T00:00:00.000Z', endedAt = '2026-10-12T00:00:10.000Z';
  return { run: { startedAt, endedAt, durationMs: 10000, environment: 'local', loginMode: 'fresh', tools: {} },
    scenarios: Object.fromEntries(c.assignments.map(x => [x.assignmentId, { startedAt, endedAt, durationMs: 10000 }])) };
}
function complete(c, i, outcome = 'PASS') {
  const record = c.assignments[i];
  launch(c.runRoot, record.assignmentId, `/root/worker${i}`);
  submit(c, i, outcome);
  finish(c.runRoot, record.assignmentId, 'completed');
  finalize(c.runRoot, record.assignmentId);
}
test('native dispatch boundary has independent assignments, sessions and destinations', () => {
  const c = setup();
  assert.equal(c.mode, 'parallel');
  assert.equal(c.concurrency, 2);
  assert.notEqual(c.assignments[0].sessionId, c.assignments[1].sessionId);
  assert.notEqual(c.assignments[0].resultFile, c.assignments[1].resultFile);
  assert.notEqual(c.assignments[0].attemptId, c.assignments[1].attemptId);
  assert.notEqual(c.assignments[0].sourceDigest, c.assignments[1].sourceDigest);
  assert.throws(() => prepare({ projectRoot: path.dirname(c.runRoot), mode: 'parallel',
    scenarios: [{ adHoc: 'x', requiredSteps: [step] }] }), /hostCapacity/);
  assert.ok(!fs.readFileSync(path.join(__dirname, 'parallel.js'), 'utf8').includes('spawnSync'));
});
test('headed worker launch is blocked before preflight and after failed preflight', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-parallel-headed-'));
  const c = prepare({ projectRoot, mode: 'parallel', hostCapacity: 1, browserMode: 'HEADED',
    scenarios: [{ adHoc: 'Open the browser and verify its title.', requiredSteps: [step] }] });
  const a = c.assignments[0];
  assert.throws(() => gate(c.runRoot, a.assignmentId), /preflight missing/);
  assert.throws(() => launch(c.runRoot, a.assignmentId, '/root/worker'), /dispatch gate missing/);
  assert.equal(fs.existsSync(path.join(c.runRoot, 'worker-events', a.assignmentId + '.launch.json')), false);
  fs.writeFileSync(path.join(a.sessionDir, 'logs', 'browser-mode.json'), JSON.stringify({
    sessionId: a.sessionId, requestedMode: 'HEADED', verified: false, reason: 'browser-mode-mismatch' }));
  assert.throws(() => gate(c.runRoot, a.assignmentId), /preflight failed/);
  assert.equal(fs.existsSync(path.join(c.runRoot, 'worker-events', a.assignmentId + '.launch.json')), false);
});
test('parallel browser action and worker launch require pre-dispatch gate', () => {
  const c = prepare({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-gate-')),
    mode: 'parallel', hostCapacity: 1, scenarios: [
      { adHoc: 'Open the browser and verify its title.', requiredSteps: [step] }] });
  const a = c.assignments[0];
  const denied = require('./host').main(['browser', c.runRoot, a.assignmentId, 'goto', 'about:blank']);
  assert.equal(denied.exitCode, 2);
  assert.match(denied.output.error, /dispatch gate missing/);
  assert.throws(() => launch(c.runRoot, a.assignmentId, '/root/worker'), /dispatch gate missing/);
  const event = gate(c.runRoot, a.assignmentId, () => {});
  assert.equal(event.browserMode, 'HEADLESS');
  assert.equal(launch(c.runRoot, a.assignmentId, '/root/worker', undefined, () => {}).workerId, '/root/worker');
  assert.equal(audit(c.runRoot, a.assignmentId), 'worker-incomplete');
  const gateFile = path.join(c.runRoot, 'worker-events', a.assignmentId + '.gate.json');
  fs.unlinkSync(gateFile);
  assert.equal(audit(c.runRoot, a.assignmentId), 'browser-dispatch-gate-missing-or-stale');
});
test('parallel audit rejects a gate retained after the recorded worker launch', () => {
  const c = prepare({ projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-gate-order-')),
    mode: 'parallel', hostCapacity: 1, scenarios: [
      { adHoc: 'Open the browser and verify its title.', requiredSteps: [step] }] });
  const a = c.assignments[0];
  gate(c.runRoot, a.assignmentId, () => {});
  const start = launch(c.runRoot, a.assignmentId, '/root/worker', undefined, () => {});
  const file = path.join(c.runRoot, 'worker-events', a.assignmentId + '.gate.json');
  const event = JSON.parse(fs.readFileSync(file));
  event.verifiedAt = new Date(Date.parse(start.at) + 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(event));
  assert.equal(audit(c.runRoot, a.assignmentId), 'browser-dispatch-gate-after-launch');
});
test('six worker ceiling and verified host capacity are enforced', () => {
  const c = setup(8, 9);
  assert.equal(c.concurrency, 6);
  for (let i = 0; i < 6; i++) launch(c.runRoot, c.assignments[i].assignmentId, `/root/w${i}`);
  assert.throws(() => launch(c.runRoot, c.assignments[6].assignmentId, '/root/w6'), /ceiling/);
  finish(c.runRoot, c.assignments[0].assignmentId, 'failed');
  launch(c.runRoot, c.assignments[6].assignmentId, '/root/w6');
  assert.throws(() => launch(c.runRoot, c.assignments[7].assignmentId, '/root/w6'), /reused/);
});
for (const [pair, verdict, code] of [
  [['PASS', 'PASS'], 'PASS', 0], [['PASS', 'FAIL'], 'FAIL', 1], [['PASS', 'BLOCKED'], 'BLOCKED', 2],
]) test(`parallel aggregation ${pair.join('+')}`, () => {
  const c = setup();
  complete(c, 0, pair[0]); complete(c, 1, pair[1]);
  const output = report(c.runRoot, metadata(c));
  assert.equal(output.verdict, verdict);
  assert.equal(output.exitCode, code);
  const data = JSON.parse(fs.readFileSync(path.join(c.runRoot, 'run-summary.json')));
  assert.equal(data.run.mode, 'parallel');
  assert.equal(data.summary.total, 2);
  assert.equal(data.summary.passed + data.summary.failed + data.summary.blocked, 2);
  assert.notEqual(data.testCases[0].session, data.testCases[1].session);
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.runRoot, 'verdict.json'))).verdict, verdict);
  assert.match(fs.readFileSync(path.join(c.runRoot, 'report.md'), 'utf8'), /Codex parallel execution/);
  assert.match(fs.readFileSync(path.join(c.runRoot, 'report.md'), 'utf8'), /Expected: visible expected status/);
  assert.ok(fs.existsSync(path.join(c.runRoot, 'extent-report.html')));
});
for (const status of ['missing', 'failed', 'cancelled', 'timed-out'])
  test(`${status} worker cannot authorize PASS`, () => {
    const c = setup(1, 1), a = c.assignments[0];
    if (status !== 'missing') {
      launch(c.runRoot, a.assignmentId, '/root/worker');
      finish(c.runRoot, a.assignmentId, status);
    }
    const output = report(c.runRoot, metadata(c));
    assert.equal(output.verdict, 'BLOCKED');
    assert.equal(output.exitCode, 2);
  });
test('duplicate and late completion are rejected', () => {
  const c = setup(1, 1), a = c.assignments[0];
  launch(c.runRoot, a.assignmentId, '/root/worker');
  assert.throws(() => finish(c.runRoot, a.assignmentId, 'completed'), /missing result/);
  finish(c.runRoot, a.assignmentId, 'timed-out');
  submit(c, 0);
  assert.throws(() => finish(c.runRoot, a.assignmentId, 'completed'), /EEXIST/);
  assert.equal(report(c.runRoot, metadata(c)).verdict, 'BLOCKED');
});

test('genuine pre-launch failure records terminal BLOCKED without inventing worker identity', () => {
  const c = setup(1, 1), a = c.assignments[0];
  const at = '2026-10-12T00:00:05Z';
  const event = finish(c.runRoot, a.assignmentId, 'launch-failed', at);
  assert.equal(event.workerId, null);
  assert.equal(event.at, at);
  assert.equal(fs.existsSync(path.join(c.runRoot, 'worker-events', a.assignmentId + '.launch.json')), false);
  assert.equal(audit(c.runRoot, a.assignmentId), 'worker-launch-failed');
  assert.equal(report(c.runRoot, metadata(c)).verdict, 'BLOCKED');
  const summary = JSON.parse(fs.readFileSync(path.join(c.runRoot, 'run-summary.json')));
  assert.ok(summary.testCases[0].validation.errors.some(x => x.code === 'worker-launch-failed'));
  assert.throws(() => finish(c.runRoot, a.assignmentId, 'launch-failed'), /exist|terminal/i);
  assert.throws(() => launch(c.runRoot, a.assignmentId, '/root/late'), /terminal|failed/i);
});

test('recorded launch rejects pre-launch failure and retains post-launch failure', () => {
  const c = setup(1, 1), a = c.assignments[0];
  launch(c.runRoot, a.assignmentId, '/root/worker');
  assert.throws(() => finish(c.runRoot, a.assignmentId, 'launch-failed'), /launch-failed requires no launch record/);
  assert.equal(fs.existsSync(path.join(c.runRoot, 'worker-events', a.assignmentId + '.end.json')), false);
  const event = finish(c.runRoot, a.assignmentId, 'failed');
  assert.equal(event.workerId, '/root/worker');
  assert.equal(audit(c.runRoot, a.assignmentId), 'worker-failed');
  assert.throws(() => finish(c.runRoot, a.assignmentId, 'failed'), /EEXIST/);
  assert.throws(() => launch(c.runRoot, a.assignmentId, '/root/late'), /terminal/);
  assert.equal(report(c.runRoot, metadata(c)).verdict, 'BLOCKED');
});

test('parallel custody never falls back to a shared session', () => {
  const c = setup(1, 1), a = c.assignments[0];
  const file = path.join(c.runRoot, 'custody.json');
  const custody = JSON.parse(fs.readFileSync(file));
  delete custody.assignments[0].sessionId;
  fs.writeFileSync(file, JSON.stringify(custody));
  assert.throws(() => require('./host').inspect(c.runRoot, a.assignmentId), /custody session mismatch/);
});

test('parallel NEEDS-USER stays BLOCKED until the coordinator validates its answer', () => {
  const c = setup(1, 1), a = c.assignments[0];
  launch(c.runRoot, a.assignmentId, '/root/worker');
  submit(c, 0, 'BLOCKED', r => {
    const images = ['baseline.png', 'actual.png'].map(name => {
      const rel = `browser-sessions/${a.sessionId}/screenshots/${name}`;
      const file = path.join(c.runRoot, rel);
      fs.writeFileSync(file, name);
      return { path: rel, sha256: sha256(fs.readFileSync(file)) };
    });
    r.steps[0].evidence.push(...images);
    r.steps[0].uiCheck = { status: 'NEEDS-USER', question: 'Is this difference expected?',
      baselineImage: images[0].path, actualImage: images[1].path };
  });
  finish(c.runRoot, a.assignmentId, 'completed');
  assert.equal(require('./host').inspect(c.runRoot, a.assignmentId).validation.verdict, 'BLOCKED');
  const raw = JSON.parse(fs.readFileSync(a.resultFile));
  const finalResult = structuredClone(raw);
  finalResult.steps[0].outcome = 'PASS';
  finalResult.steps[0].assertions = [{ id: 'visible', passed: true }];
  finalResult.steps[0].uiCheck.status = 'PASS';
  finalResult.scenarioOutcome = finalResult.verdict = 'PASS';
  finalResult.summary = { total: 1, passed: 1, failed: 0, blocked: 0, warnings: 0, flaky: 0 };
  finalResult.exitCode = 0;
  const answer = { stepId: 'check', question: raw.steps[0].uiCheck.question,
    resolution: 'Expected rendering noise', finalStatus: 'PASS' };
  assert.equal(require('./host').resolve(c.runRoot, a.assignmentId, { answers: [answer], finalResult }).verdict, 'PASS');
  assert.equal(finalize(c.runRoot, a.assignmentId).verdict, 'PASS');
  const output = report(c.runRoot, metadata(c));
  assert.equal(output.verdict, 'PASS');
  const summary = JSON.parse(fs.readFileSync(path.join(c.runRoot, 'run-summary.json')));
  assert.equal(summary.testCases[0].deferred[0].resolution, answer.resolution);
});

test('pre-launch failure is exclusive and other terminal states still require launch', () => {
  const c = setup(2, 1), first = c.assignments[0], second = c.assignments[1];
  assert.throws(() => finish(c.runRoot, first.assignmentId, 'completed'), /launch record required/);
  finish(c.runRoot, first.assignmentId, 'launch-failed');
  launch(c.runRoot, second.assignmentId, '/root/worker');
  finish(c.runRoot, second.assignmentId, 'cancelled');
  assert.equal(audit(c.runRoot, second.assignmentId), 'worker-cancelled');
  assert.throws(() => finish(c.runRoot, first.assignmentId, 'launch-failed'), /EEXIST/);
  assert.throws(() => launch(c.runRoot, first.assignmentId, '/root/late'), /terminal/);
});
for (const variant of ['stale', 'failed-assertion', 'missing-evidence', 'cleanup-failure'])
  test(`${variant} remains authoritative`, () => {
    const c = setup(1, 1), a = c.assignments[0];
    launch(c.runRoot, a.assignmentId, '/root/worker');
    submit(c, 0, variant === 'failed-assertion' ? 'FAIL' : 'PASS', (r, evidence) => {
      if (variant === 'stale') r.attemptId = 'old';
      if (variant === 'missing-evidence') fs.unlinkSync(evidence);
      if (variant === 'cleanup-failure') r.cleanup.status = 'failed';
    });
    finish(c.runRoot, a.assignmentId, 'completed');
    const output = report(c.runRoot, metadata(c));
    assert.equal(output.verdict, variant === 'failed-assertion' ? 'FAIL' : 'BLOCKED');
  });
test('assignment rewrite conflicts with retained custody', () => {
  const c = setup(1, 1), a = c.assignments[0];
  launch(c.runRoot, a.assignmentId, '/root/worker'); submit(c, 0);
  const changed = JSON.parse(fs.readFileSync(a.assignmentFile));
  changed.requiredSteps[0].id = 'removed';
  fs.writeFileSync(a.assignmentFile, JSON.stringify(changed));
  finish(c.runRoot, a.assignmentId, 'completed');
  assert.equal(report(c.runRoot, metadata(c)).verdict, 'BLOCKED');
});
