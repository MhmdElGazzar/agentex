'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare, inspect, resolve, finalize, main } = require('./host');
const { report } = require('./report');
const { sha256 } = require('../lib/execution_result');
const { completeBrowser } = require('./browser_test_helper');

function fixture(status = 'NEEDS-USER', second = false) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ui-outcome-'));
  const c = prepare({ projectRoot, scenarios: [{ adHoc: 'Compare the current view',
    requiredSteps: [{ id: 'ui', assertionIds: ['visual'], evidenceRequired: true },
      ...(second ? [{ id: 'other', assertionIds: ['ordinary'], evidenceRequired: true }] : [])] }] });
  const record = c.assignments[0], a = JSON.parse(fs.readFileSync(record.assignmentFile));
  const ids = { runId: a.runId, attemptId: a.attemptId, assignmentId: a.assignmentId, sessionId: a.sessionId };
  const images = ['baseline.png', 'actual.png'].map(name => {
    const rel = `browser-sessions/${c.sessionId}/screenshots/${name}`;
    const bytes = Buffer.from(name);
    fs.writeFileSync(path.join(c.runRoot, rel), bytes);
    return { path: rel, sha256: sha256(bytes) };
  });
  const uiCheck = status === 'NEEDS-USER'
    ? { status, question: 'Is this rendering difference expected?', baselineImage: images[0].path, actualImage: images[1].path }
    : { status, reason: 'baseline mobile, actual desktop', baselineImage: images[0].path, actualImage: images[1].path };
  const raw = { schemaVersion: 1, ...ids, assignmentDigest: a.assignmentDigest, sourceDigest: a.source.digest,
    scope: a.scope, steps: [{ ...ids, stepId: 'ui', outcome: 'BLOCKED', assertions: [], evidence: images, uiCheck },
      ...(second ? [{ ...ids, stepId: 'other', outcome: 'PASS', assertions: [{ id: 'ordinary', passed: true }], evidence: images }] : [])],
    cleanup: { ...ids, status: 'completed' }, scenarioOutcome: 'BLOCKED',
    summary: { total: 1, passed: 0, failed: 0, blocked: 1, warnings: 0, flaky: 0 }, verdict: 'BLOCKED', exitCode: 2 };
  fs.writeFileSync(record.resultFile, JSON.stringify(raw));
  completeBrowser(c);
  return { c, record, raw, images };
}

function passingResolution(raw) {
  const finalResult = structuredClone(raw);
  finalResult.steps[0].outcome = 'PASS';
  finalResult.steps[0].assertions = [{ id: 'visual', passed: true }];
  finalResult.steps[0].uiCheck.status = 'PASS';
  finalResult.scenarioOutcome = finalResult.verdict = 'PASS';
  finalResult.summary = { total: 1, passed: 1, failed: 0, blocked: 0, warnings: 0, flaky: 0 };
  finalResult.exitCode = 0;
  const answer = { stepId: 'ui', question: raw.steps[0].uiCheck.question,
    resolution: 'Expected rendering noise', finalStatus: 'PASS' };
  return { answers: [answer], finalResult };
}

test('deferred answer is validated without replacing worker result', () => {
  assert.equal(typeof resolve, 'function');
  const { c, record, raw } = fixture();
  const input = passingResolution(raw);
  assert.equal(resolve(c.runRoot, record.assignmentId, input).verdict, 'PASS');
  assert.equal(inspect(c.runRoot, record.assignmentId).validation.verdict, 'PASS');
  assert.deepEqual(JSON.parse(fs.readFileSync(record.resultFile)), raw);
  assert.throws(() => resolve(c.runRoot, record.assignmentId, input), /exist|resolved/i);
});

test('resolved question reaches JSON, Markdown, HTML, and CLI verdict', () => {
  const { c, record, raw } = fixture();
  const input = passingResolution(raw);
  const file = path.join(c.runRoot, 'resolution-input.json');
  fs.writeFileSync(file, JSON.stringify(input));
  assert.equal(main(['resolve', c.runRoot, record.assignmentId, file]).exitCode, 0);
  assert.equal(finalize(c.runRoot, record.assignmentId).verdict, 'PASS');
  const timing = { startedAt: '2026-10-12T00:00:00Z', endedAt: '2026-10-12T00:00:01Z', durationMs: 1000 };
  const output = report(c.runRoot, { run: timing, scenarios: { [record.assignmentId]: timing } });
  assert.equal(output.verdict, 'PASS');
  assert.equal(output.exitCode, 0);
  const summary = JSON.parse(fs.readFileSync(path.join(c.runRoot, 'run-summary.json')));
  assert.equal(summary.testCases[0].deferred[0].question, input.answers[0].question);
  assert.equal(summary.testCases[0].deferred[0].resolution, input.answers[0].resolution);
  assert.match(fs.readFileSync(path.join(c.runRoot, 'extent-report.html'), 'utf8'), /Resolved deferred question/);
  assert.match(fs.readFileSync(path.join(c.runRoot, 'report.md'), 'utf8'), /PASS/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.runRoot, 'verdict.json'))).verdict, 'PASS');
});

test('stale result, changed evidence, changed other step, and late resolution are rejected', () => {
  const stale = fixture(), staleInput = passingResolution(stale.raw);
  fs.appendFileSync(stale.record.resultFile, '\n');
  // The resolution binds the exact bytes recorded when it was accepted.
  assert.equal(resolve(stale.c.runRoot, stale.record.assignmentId, staleInput).verdict, 'PASS');
  fs.appendFileSync(stale.record.resultFile, '\n');
  assert.throws(() => inspect(stale.c.runRoot, stale.record.assignmentId), /stale UI resolution/);
  const evidence = fixture(), evidenceInput = passingResolution(evidence.raw);
  fs.writeFileSync(path.join(evidence.c.runRoot, evidence.images[0].path), 'replaced');
  assert.throws(() => resolve(evidence.c.runRoot, evidence.record.assignmentId, evidenceInput), /valid pending/);
  const other = fixture('NEEDS-USER', true), otherInput = passingResolution(other.raw);
  otherInput.finalResult.steps[1].note = 'changed';
  assert.throws(() => resolve(other.c.runRoot, other.record.assignmentId, otherInput), /other step/);
  const late = fixture();
  finalize(late.c.runRoot, late.record.assignmentId);
  assert.throws(() => resolve(late.c.runRoot, late.record.assignmentId, passingResolution(late.raw)), /finalized/);
});

test('unanswered UI check stays blocked', () => {
  const { c, record } = fixture();
  assert.equal(inspect(c.runRoot, record.assignmentId).validation.verdict, 'BLOCKED');
  const timing = { startedAt: '2026-10-12T00:00:00Z', endedAt: '2026-10-12T00:00:01Z', durationMs: 1000 };
  const output = report(c.runRoot, { run: timing, scenarios: { [record.assignmentId]: timing } });
  assert.equal(output.exitCode, 2);
  assert.equal(output.blockedReasons[0].code, 'needs-user');
  const summary = JSON.parse(fs.readFileSync(path.join(c.runRoot, 'run-summary.json')));
  assert.equal(summary.testCases[0].status, 'blocked');
  assert.equal(summary.testCases[0].deferred, undefined);
});

test('missing question or evidence reference cannot authorize a UI result', () => {
  const badQuestion = fixture();
  badQuestion.raw.steps[0].uiCheck.question = '';
  fs.writeFileSync(badQuestion.record.resultFile, JSON.stringify(badQuestion.raw));
  assert.equal(inspect(badQuestion.c.runRoot, badQuestion.record.assignmentId).validation.verdict, 'BLOCKED');
  assert.throws(() => resolve(badQuestion.c.runRoot, badQuestion.record.assignmentId,
    passingResolution(badQuestion.raw)), /valid pending/);
  const badImage = fixture();
  badImage.raw.steps[0].uiCheck.actualImage = 'outside.png';
  fs.writeFileSync(badImage.record.resultFile, JSON.stringify(badImage.raw));
  assert.equal(inspect(badImage.c.runRoot, badImage.record.assignmentId).validation.verdict, 'BLOCKED');
});

test('view mismatch cannot become PASS', () => {
  const { c, record, raw } = fixture('VIEW MISMATCH ERROR');
  raw.steps[0].outcome = 'PASS';
  raw.steps[0].assertions = [{ id: 'visual', passed: true }];
  raw.scenarioOutcome = raw.verdict = 'PASS';
  raw.summary = { total: 1, passed: 1, failed: 0, blocked: 0, warnings: 0, flaky: 0 };
  raw.exitCode = 0;
  fs.writeFileSync(record.resultFile, JSON.stringify(raw));
  assert.equal(inspect(c.runRoot, record.assignmentId).validation.verdict, 'BLOCKED');
});

test('view mismatch cannot become product FAIL, but another product failure remains FAIL', () => {
  const forged = fixture('VIEW MISMATCH ERROR');
  forged.raw.steps[0].outcome = 'FAIL';
  forged.raw.steps[0].assertions = [{ id: 'visual', passed: false }];
  forged.raw.scenarioOutcome = forged.raw.verdict = 'FAIL';
  forged.raw.summary = { total: 1, passed: 0, failed: 1, blocked: 0, warnings: 0, flaky: 0 };
  forged.raw.exitCode = 1;
  fs.writeFileSync(forged.record.resultFile, JSON.stringify(forged.raw));
  assert.equal(inspect(forged.c.runRoot, forged.record.assignmentId).validation.verdict, 'BLOCKED');
  const mixed = fixture('VIEW MISMATCH ERROR', true);
  mixed.raw.steps[1].outcome = 'FAIL';
  mixed.raw.steps[1].assertions[0].passed = false;
  mixed.raw.scenarioOutcome = mixed.raw.verdict = 'FAIL';
  mixed.raw.summary = { total: 1, passed: 0, failed: 1, blocked: 0, warnings: 0, flaky: 0 };
  mixed.raw.exitCode = 1;
  fs.writeFileSync(mixed.record.resultFile, JSON.stringify(mixed.raw));
  assert.equal(inspect(mixed.c.runRoot, mixed.record.assignmentId).validation.verdict, 'FAIL');
});

module.exports = { fixture };
