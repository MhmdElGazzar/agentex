'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freezeAssignment, validateExecutionResult, sha256 } = require('./execution_result');
const { main } = require('./validate_execution_result');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-result-'));
  const sourceRoot = path.join(root, 'source');
  const runRoot = path.join(root, 'run');
  fs.mkdirSync(path.join(sourceRoot, 'test'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'test', 'sample.md'), '# Synthetic scenario\n');
  const sessionId = 'sample-session';
  const evidencePath = `browser-sessions/${sessionId}/screenshots/step.png`;
  const evidenceFile = path.join(runRoot, ...evidencePath.split('/'));
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, 'synthetic screenshot');
  const assignment = freezeAssignment({
    runId: 'run-1', attemptId: 'attempt-1', assignmentId: 'assignment-1', sessionId,
    scope: { kind: 'spec', value: 'test/sample.md' },
    source: { kind: 'saved-spec', path: 'test/sample.md' },
    requiredSteps: [
      { id: 'step-1', assertionIds: ['assert-1'], evidenceRequired: true },
      { id: 'step-2', assertionIds: ['assert-2'], evidenceRequired: false },
    ],
    cleanupRequired: true, policy: { warningsFailGate: true, flakyFailsGate: false },
  }, { sourceRoot });
  const ids = { runId: assignment.runId, attemptId: assignment.attemptId,
    assignmentId: assignment.assignmentId, sessionId };
  const result = {
    schemaVersion: 1, ...ids, assignmentDigest: assignment.assignmentDigest,
    sourceDigest: assignment.source.digest, scope: assignment.scope,
    steps: [
      { ...ids, stepId: 'step-1', outcome: 'PASS', assertions: [{ id: 'assert-1', passed: true }],
        evidence: [{ path: evidencePath, sha256: sha256(fs.readFileSync(evidenceFile)) }] },
      { ...ids, stepId: 'step-2', outcome: 'PASS', assertions: [{ id: 'assert-2', passed: true }], evidence: [] },
    ],
    cleanup: { ...ids, status: 'completed' }, scenarioOutcome: 'PASS',
    summary: { total: 1, passed: 1, failed: 0, blocked: 0, warnings: 0, flaky: 0 },
    verdict: 'PASS', exitCode: 0,
  };
  const fixtureState = { root, sourceRoot, runRoot, evidenceFile, assignment, result };
  fixtureState.check = () => validateExecutionResult({ assignment: fixtureState.assignment,
    result: fixtureState.result, sourceRoot: fixtureState.sourceRoot, runRoot: fixtureState.runRoot });
  return fixtureState;
}

function persisted(f) { f.assignment = JSON.parse(JSON.stringify(f.assignment)); }
function scenario(f, outcome, verdict, summaryKey) {
  f.result.scenarioOutcome = outcome;
  f.result.verdict = verdict;
  f.result.exitCode = { PASS: 0, FAIL: 1, BLOCKED: 2 }[verdict];
  f.result.summary = { total: 1, passed: 0, failed: 0, blocked: 0, warnings: 0, flaky: 0,
    [summaryKey]: 1 };
}

function reject(name, change, code, verdict = 'BLOCKED') {
  test(name, () => {
    const f = fixture();
    change(f);
    const got = f.check();
    assert.equal(got.ok, false);
    assert.equal(got.verdict, verdict);
    assert.ok(got.errors.some(e => e.code === code), JSON.stringify(got));
  });
}

for (const [name, invoke] of [
  ['undefined outer input', () => validateExecutionResult(undefined)],
  ['null outer input', () => validateExecutionResult(null)],
  ['omitted outer input', () => validateExecutionResult()],
  ['empty outer input', () => validateExecutionResult({})],
  ['primitive outer input', () => validateExecutionResult('invalid')],
]) {
  test(`${name} returns a structured BLOCKED result`, () => {
    const got = invoke();
    assert.equal(got.ok, false);
    assert.equal(got.verdict, 'BLOCKED');
    assert.equal(got.exitCode, 2);
    assert.deepEqual(got.coverage, { required: 0, recorded: 0 });
    assert.ok(Array.isArray(got.errors) && got.errors.length > 0);
    assert.ok(got.errors.every(error => typeof error.code === 'string'));
  });
}

test('valid complete execution and separate obligation coverage', () => {
  const got = fixture().check();
  assert.deepEqual(got, { ok: true, verdict: 'PASS', exitCode: 0,
    coverage: { required: 2, recorded: 2 }, errors: [] });
});
reject('missing required step', f => f.result.steps.pop(), 'missing-step');
reject('duplicate required step', f => f.result.steps.push({ ...f.result.steps[0] }), 'duplicate-step');
reject('unknown step', f => { f.result.steps[1].stepId = 'unplanned'; }, 'unknown-step');
reject('not attempted step', f => { f.result.steps[1].outcome = 'NOT_ATTEMPTED'; }, 'scenario-contradiction');
reject('blocked step', f => { f.result.steps[1].outcome = 'BLOCKED'; }, 'scenario-contradiction');
reject('failed assertion cannot pass', f => { f.result.steps[1].assertions[0].passed = false; }, 'outcome-contradiction', 'FAIL');
reject('contradictory scenario status', f => { f.result.scenarioOutcome = 'BLOCKED'; }, 'scenario-contradiction');
reject('forged successful counts', f => { f.result.summary.passed = 99; }, 'summary-contradiction');
reject('wrong source digest', f => { f.result.sourceDigest = '0'.repeat(64); }, 'source-digest');
reject('stale source after assignment freeze', f => { fs.writeFileSync(path.join(f.sourceRoot, 'test', 'sample.md'), 'changed'); }, 'source-digest');
reject('stale attempt', f => { f.result.attemptId = 'attempt-0'; }, 'attempt-identity');
reject('wrong assignment', f => { f.result.assignmentId = 'assignment-0'; }, 'assignment-identity');
reject('cross-run result reuse', f => { f.result.runId = 'other-run'; }, 'run-identity');
reject('step from another attempt', f => { f.result.steps[0].attemptId = 'attempt-0'; }, 'step-ownership');
reject('missing evidence', f => { f.result.steps[0].evidence = []; }, 'missing-evidence');
reject('invalid evidence path', f => { f.result.steps[0].evidence[0].path = '../outside.png'; }, 'invalid-evidence');
reject('evidence content changed', f => { fs.writeFileSync(f.evidenceFile, 'tampered'); }, 'evidence-digest');
reject('cleanup failure', f => { f.result.cleanup.status = 'failed'; }, 'cleanup-failed');
reject('wrong cleanup owner', f => { f.result.cleanup.runId = 'other-run'; }, 'cleanup-ownership');
reject('invalid verdict and exit pairing', f => { f.result.exitCode = 1; }, 'verdict-exit-pair');
reject('empty passing result', f => { f.result.steps = []; }, 'missing-step');
reject('assignment digest mismatch', f => { f.result.assignmentDigest = '0'.repeat(64); }, 'assignment-digest');
reject('scope mismatch', f => { f.result.scope = { kind: 'all', value: 'all' }; }, 'execution-scope');
reject('session mismatch', f => { f.result.sessionId = 'other-session'; }, 'session-identity');
reject('missing observed assertion', f => { f.result.steps[1].assertions = []; }, 'assertion-coverage');

test('valid FAIL classification keeps product failure at exit 1', () => {
  const f = fixture();
  f.result.steps[1].outcome = 'FAIL';
  f.result.steps[1].assertions[0].passed = false;
  f.result.scenarioOutcome = f.result.verdict = 'FAIL';
  f.result.exitCode = 1;
  f.result.summary = { total: 1, passed: 0, failed: 1, blocked: 0, warnings: 0, flaky: 0 };
  assert.deepEqual(f.check(), { ok: true, verdict: 'FAIL', exitCode: 1,
    coverage: { required: 2, recorded: 2 }, errors: [] });
});

test('valid BLOCKED classification keeps blocked scenario at exit 2', () => {
  const f = fixture();
  f.result.steps[1].outcome = 'BLOCKED';
  f.result.steps[1].assertions = [];
  f.result.scenarioOutcome = f.result.verdict = 'BLOCKED';
  f.result.exitCode = 2;
  f.result.summary = { total: 1, passed: 0, failed: 0, blocked: 1, warnings: 0, flaky: 0 };
  assert.deepEqual(f.check(), { ok: true, verdict: 'BLOCKED', exitCode: 2,
    coverage: { required: 2, recorded: 2 }, errors: [] });
});

test('warning and flaky policy remains configurable', () => {
  for (const [outcome, verdict, exitCode, key] of [['WARNING', 'FAIL', 1, 'warnings'], ['FLAKY', 'PASS', 0, 'flaky']]) {
    const f = fixture();
    f.result.steps[1].outcome = outcome;
    f.result.scenarioOutcome = outcome;
    f.result.verdict = verdict;
    f.result.exitCode = exitCode;
    f.result.summary = { total: 1, passed: 0, failed: 0, blocked: 0, warnings: 0, flaky: 0, [key]: 1 };
    assert.equal(f.check().ok, true, JSON.stringify(f.check()));
  }
});

test('CLI adapter ingests retained JSON files', () => {
  const f = fixture();
  const a = path.join(f.root, 'assignment.json');
  const r = path.join(f.root, 'result.json');
  fs.writeFileSync(a, JSON.stringify(f.assignment));
  fs.writeFileSync(r, JSON.stringify(f.result));
  assert.deepEqual(main([a, r, f.sourceRoot, f.runRoot]), f.check());
});

test('persisted assignment digest rejects removed, added and renamed requirements', () => {
  for (const mutation of ['removed', 'added', 'renamed']) {
    const f = fixture(); persisted(f);
    if (mutation === 'removed') { f.assignment.requiredSteps.pop(); f.result.steps.pop(); }
    if (mutation === 'added') f.assignment.requiredSteps.push({ id: 'step-3', assertionIds: ['assert-3'], evidenceRequired: false });
    if (mutation === 'renamed') { f.assignment.requiredSteps[1].id = 'changed'; f.result.steps[1].stepId = 'changed'; }
    const got = f.check();
    assert.equal(got.ok, false, mutation);
    assert.equal(got.verdict, 'BLOCKED', mutation);
    assert.ok(got.errors.some(e => e.code === 'assignment-digest'), mutation);
  }
});

test('assignment digest is required and unchanged persisted assignment passes', () => {
  const f = fixture(); persisted(f);
  assert.equal(f.check().verdict, 'PASS');
  delete f.assignment.assignmentDigest;
  delete f.result.assignmentDigest;
  assert.equal(f.check().verdict, 'BLOCKED');
  assert.ok(f.check().errors.some(e => e.code === 'assignment-digest'));
  f.result.assignmentDigest = '0'.repeat(64);
  assert.equal(f.check().verdict, 'BLOCKED');
});

test('warning and flaky gates evaluate all completed observations', () => {
  for (const warningGate of [false, true]) for (const flakyGate of [false, true]) {
    for (const outcomes of [['WARNING', 'PASS'], ['FLAKY', 'PASS'], ['WARNING', 'FLAKY']]) {
      const f = fixture(); persisted(f);
      f.assignment.policy = { warningsFailGate: warningGate, flakyFailsGate: flakyGate };
      // Re-freeze with the chosen policy to get a trusted assignment digest.
      const input = { ...f.assignment }; delete input.assignmentDigest;
      f.assignment = freezeAssignment(input, { sourceRoot: f.sourceRoot });
      f.result.assignmentDigest = f.assignment.assignmentDigest;
      outcomes.forEach((outcome, i) => { f.result.steps[i].outcome = outcome; });
      const representative = outcomes.includes('FLAKY') ? 'FLAKY' : outcomes.includes('WARNING') ? 'WARNING' : 'PASS';
      const expected = outcomes.includes('WARNING') && warningGate ? 'FAIL'
        : outcomes.includes('FLAKY') && flakyGate ? 'BLOCKED' : 'PASS';
      scenario(f, representative, expected, representative === 'PASS' ? 'passed' : representative === 'FLAKY' ? 'flaky' : 'warnings');
      const got = f.check();
      assert.equal(got.ok, true, JSON.stringify({ warningGate, flakyGate, outcomes, got }));
      assert.equal(got.verdict, expected);
    }
  }
});

test('a validated failed assertion survives unrelated missing or malformed work', () => {
  for (const change of [
    f => { f.result.steps[1].assertions = []; },
    f => { f.result.steps[1].outcome = 'unknown'; },
    f => { f.result.steps.pop(); },
  ]) {
    const f = fixture();
    f.result.steps[0].outcome = 'FAIL'; f.result.steps[0].assertions[0].passed = false;
    change(f);
    scenario(f, 'FAIL', 'FAIL', 'failed');
    const got = f.check();
    assert.equal(got.verdict, 'FAIL', JSON.stringify(got));
    assert.equal(got.exitCode, 1);
    assert.equal(got.ok, false);
  }
});

test('invalid assertion identities and unattempted observations cannot establish product failure', () => {
  for (const outcome of ['BLOCKED', 'NOT_ATTEMPTED']) {
    const f = fixture();
    f.result.steps[0].outcome = outcome;
    f.result.steps[0].assertions = [{ id: 'undeclared', passed: false }];
    scenario(f, 'FAIL', 'FAIL', 'failed');
    const got = f.check();
    assert.equal(got.ok, false);
    assert.equal(got.verdict, 'BLOCKED');
    assert.ok(got.errors.some(e => e.code === 'assertion-coverage'));
  }
});

test('a claimed failure with invalid evidence is not a validated product failure', () => {
  const f = fixture();
  f.result.steps[0].outcome = 'FAIL'; f.result.steps[0].assertions[0].passed = false;
  f.result.steps[0].evidence[0].sha256 = '0'.repeat(64);
  scenario(f, 'FAIL', 'FAIL', 'failed');
  const got = f.check();
  assert.equal(got.verdict, 'BLOCKED');
  assert.ok(got.errors.some(e => e.code === 'evidence-digest'));
});

test('session directory alias to another session cannot own evidence', t => {
  const f = fixture();
  const sessions = path.join(f.runRoot, 'browser-sessions');
  const owned = path.join(sessions, f.assignment.sessionId);
  const foreign = path.join(sessions, 'foreign-session');
  fs.renameSync(owned, foreign);
  try { fs.symlinkSync(foreign, owned, 'junction'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip('directory links unavailable'); throw e; }
  const got = f.check();
  assert.equal(got.verdict, 'BLOCKED');
  assert.ok(got.errors.some(e => e.code === 'invalid-evidence'));
});

test('invalid roots, malformed records, and reordered contract objects', () => {
  const normal = fixture(); persisted(normal);
  normal.result.scope = { value: normal.assignment.scope.value, kind: normal.assignment.scope.kind };
  normal.result.summary = { flaky: 0, warnings: 0, blocked: 0, failed: 0, passed: 1, total: 1 };
  assert.equal(normal.check().ok, true);
  for (const rootKey of ['sourceRoot', 'runRoot']) {
    const f = fixture(); f[rootKey] = 'relative-root';
    assert.equal(f.check().verdict, 'BLOCKED');
    assert.ok(f.check().errors.some(e => e.code === 'roots-required'));
  }
  for (const steps of [null, [null], [{ id: 'bad', assertionIds: [null], evidenceRequired: false }]]) {
    const f = fixture(); persisted(f); f.assignment.requiredSteps = steps;
    assert.doesNotThrow(() => f.check());
    assert.equal(f.check().verdict, 'BLOCKED');
  }
  const f = fixture(); persisted(f); f.assignment.policy = [];
  assert.equal(f.check().verdict, 'BLOCKED');
  const g = fixture(); g.result = [];
  assert.equal(g.check().verdict, 'BLOCKED');
  const h = fixture(); h.assignment = null; h.result.cleanup = {};
  assert.doesNotThrow(() => h.check());
  assert.equal(h.check().verdict, 'BLOCKED');
});

test('nested key ordering is semantic in assignment digest and scope comparison', () => {
  const f = fixture();
  const input = { ...f.assignment, scope: { kind: 'spec', value: 'test/sample.md',
    metadata: { outer: { first: 1, second: 2 }, other: true } } };
  delete input.assignmentDigest;
  f.assignment = freezeAssignment(input, { sourceRoot: f.sourceRoot });
  persisted(f);
  f.assignment.scope = { metadata: { other: true, outer: { second: 2, first: 1 } },
    value: 'test/sample.md', kind: 'spec' };
  f.result.scope = { metadata: { outer: { second: 2, first: 1 }, other: true },
    kind: 'spec', value: 'test/sample.md' };
  f.result.assignmentDigest = f.assignment.assignmentDigest;
  assert.equal(f.check().ok, true, JSON.stringify(f.check()));
});

test('two independent product failures and failure with flaky observation stay FAIL', () => {
  for (const other of ['FAIL', 'FLAKY', 'WARNING']) {
    const f = fixture();
    f.result.steps[0].outcome = 'FAIL'; f.result.steps[0].assertions[0].passed = false;
    f.result.steps[1].outcome = other;
    if (other === 'FAIL') f.result.steps[1].assertions[0].passed = false;
    scenario(f, 'FAIL', 'FAIL', 'failed');
    assert.deepEqual(f.check().errors, []);
    assert.equal(f.check().verdict, 'FAIL');
  }
});

test('foreign-session and cross-run evidence are rejected', () => {
  for (const kind of ['foreign-session', 'cross-run']) {
    const f = fixture();
    const foreignRoot = kind === 'cross-run' ? path.join(f.root, 'other-run') : f.runRoot;
    const foreign = path.join(foreignRoot, 'browser-sessions', 'foreign', 'screenshots', 'other.png');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, 'synthetic screenshot');
    if (kind === 'foreign-session') {
      f.result.steps[0].evidence[0].path = 'browser-sessions/foreign/screenshots/other.png';
    } else {
      const alias = path.join(f.runRoot, 'browser-sessions', f.assignment.sessionId, 'screenshots', 'cross-run');
      fs.symlinkSync(path.dirname(foreign), alias, 'junction');
      f.result.steps[0].evidence[0].path = `browser-sessions/${f.assignment.sessionId}/screenshots/cross-run/other.png`;
    }
    const got = f.check();
    assert.equal(got.verdict, 'BLOCKED', kind);
    assert.ok(got.errors.some(e => e.code === 'invalid-evidence'), kind);
  }
});

test('CLI adapter fails closed on malformed persisted JSON', () => {
  const f = fixture();
  const a = path.join(f.root, 'malformed-assignment.json');
  const r = path.join(f.root, 'result.json');
  fs.writeFileSync(a, '{ malformed');
  fs.writeFileSync(r, JSON.stringify(f.result));
  assert.deepEqual(main([a, r, f.sourceRoot, f.runRoot]), { ok: false, verdict: 'BLOCKED', exitCode: 2,
    coverage: { required: 0, recorded: 0 }, errors: [{ code: 'ingestion-error' }] });
  fs.writeFileSync(a, 'null');
  const nullAssignment = main([a, r, f.sourceRoot, f.runRoot]);
  assert.equal(nullAssignment.ok, false);
  assert.equal(nullAssignment.verdict, 'BLOCKED');
  assert.equal(nullAssignment.exitCode, 2);
  assert.ok(nullAssignment.errors.length > 0);
});
