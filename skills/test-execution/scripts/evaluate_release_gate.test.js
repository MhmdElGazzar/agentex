'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { parseArgs, validateSummary, evaluate, runGate } = require('./evaluate_release_gate.js');

function fixture(statuses = ['passed']) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-release-policy-'));
  const runRoot = path.join(parent, 'execu_fixture');
  fs.mkdirSync(runRoot);
  const sessions = statuses.map((_, i) => `session-${i + 1}`);
  const counts = { passed: 0, failed: 0, blocked: 0, warnings: 0,
    viewMismatch: 0, flaky: 0, naDescoped: 0, notRun: 0, total: statuses.length };
  const statusKey = { passed: 'passed', failed: 'failed', blocked: 'blocked', warning: 'warnings',
    viewMismatch: 'viewMismatch', flaky: 'flaky', na: 'naDescoped', notrun: 'notRun' };
  const cases = statuses.map((status, i) => {
    counts[statusKey[status]]++;
    return { name: `Case ${i + 1}`, session: sessions[i], status,
      steps: [{ desc: 'Check', status }] };
  });
  const data = { schemaVersion: 2, title: 'Fixture', date: '2026-01-01',
    run: { mode: 'parallel', sessions: sessions.map(session => ({ session })) },
    summary: counts, testCases: cases, defects: [] };
  const summary = path.join(runRoot, 'run-summary.json');
  const save = () => fs.writeFileSync(summary, JSON.stringify(data, null, 2) + '\n');
  save();
  return { data, runRoot, summary, save, close: () => fs.rmSync(parent, { recursive: true, force: true }) };
}

test('CLI requires a summary and accepts only explicit flaky policies', () => {
  assert.deepEqual(parseArgs(['--summary', 'x']), { summary: 'x', flakyPolicy: 'review' });
  assert.equal(parseArgs(['--summary', 'x', '--flaky-policy', 'allow']).flakyPolicy, 'allow');
  for (const args of [[], ['--summary'], ['--summary', 'x', '--flaky-policy', 'quiet'],
    ['--summary', 'x', '--summary', 'y'], ['--unknown', 'x']]) assert.throws(() => parseArgs(args));
});

test('all PASS is gate PASS, exit 0, no approval, and reproducible', () => {
  const f = fixture(['passed', 'passed']);
  try {
    const a = evaluate(f.data, { runRoot: f.runRoot, runId: 'execu_fixture' });
    const b = evaluate(f.data, { runRoot: f.runRoot, runId: 'execu_fixture' });
    assert.deepEqual(a, b);
    assert.equal(a.decision, 'PASS'); assert.equal(a.exitCode, 0);
    assert.equal(a.counts.passed, 2); assert.equal(a.approval.requiresHumanReview, false);
  } finally { f.close(); }
});

test('product FAIL with defect retains product classification and exit 1', () => {
  const f = fixture(['passed', 'failed']);
  try {
    const evidence = 'bugs/screenshots/product.png';
    fs.mkdirSync(path.join(f.runRoot, 'bugs', 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(f.runRoot, evidence), 'image');
    f.data.defects.push({ title: 'Mismatch', severity: 'High', evidence: [evidence] });
    const result = evaluate(f.data, { runRoot: f.runRoot });
    assert.equal(result.decision, 'FAIL'); assert.equal(result.exitCode, 1);
    assert.deepEqual(result.reasons.map(r => r.code), ['product-failure']);
    assert.equal(result.approval.releaseBlocked, true);
  } finally { f.close(); }
});

test('infrastructure BLOCKED and not-run produce REVIEW, exit 2', () => {
  for (const status of ['blocked', 'notrun']) {
    const f = fixture(['passed', status]);
    try {
      const result = evaluate(f.data, { runRoot: f.runRoot });
      assert.equal(result.decision, 'REVIEW'); assert.equal(result.exitCode, 2);
      assert.equal(result.reasons[0].category, 'infrastructure');
      assert.equal(result.approval.requiresHumanReview, true);
    } finally { f.close(); }
  }
});

test('product FAIL remains product-classified even when infrastructure is also blocked', () => {
  const f = fixture(['failed', 'blocked']);
  try {
    const result = evaluate(f.data, { runRoot: f.runRoot });
    assert.equal(result.decision, 'FAIL');
    assert.deepEqual(result.reasons.map(r => r.category), ['product', 'infrastructure']);
    assert.equal(result.approval.requiresHumanReview, true);
  } finally { f.close(); }
});

test('flaky default REVIEW, fail override FAIL, allow override visible PASS', () => {
  const f = fixture(['passed', 'flaky']);
  try {
    const review = evaluate(f.data, { runRoot: f.runRoot });
    const fail = evaluate(f.data, { runRoot: f.runRoot, flakyPolicy: 'fail' });
    const allow = evaluate(f.data, { runRoot: f.runRoot, flakyPolicy: 'allow' });
    assert.deepEqual([review.decision, review.exitCode, fail.decision, fail.exitCode, allow.decision, allow.exitCode],
      ['REVIEW', 2, 'FAIL', 1, 'PASS', 0]);
    assert.deepEqual([review, fail, allow].map(r => r.reasons[0].category), ['instability', 'instability', 'instability']);
    assert.equal(allow.reasons[0].code, 'flaky-allowed');
  } finally { f.close(); }
});

test('warning follows existing product-side fail convention; view mismatch requires review', () => {
  for (const [status, expected] of [['warning', 'FAIL'], ['viewMismatch', 'REVIEW'], ['na', 'PASS']]) {
    const f = fixture([status]);
    try { assert.equal(evaluate(f.data, { runRoot: f.runRoot }).decision, expected); }
    finally { f.close(); }
  }
});

test('case completion order does not change policy decision or reason ordering', () => {
  const f = fixture(['failed', 'blocked', 'flaky', 'passed']);
  try {
    const first = evaluate(f.data, { runRoot: f.runRoot });
    f.data.testCases.reverse();
    const reversed = evaluate(f.data, { runRoot: f.runRoot });
    assert.deepEqual(first, reversed);
  } finally { f.close(); }
});

test('missing session result, duplicate ownership, unowned result, and count drift never pass', () => {
  const changes = [
    data => data.testCases.pop(),
    data => data.run.sessions[1].session = data.run.sessions[0].session,
    data => data.testCases[0].session = 'unknown',
    data => data.summary.passed = 9,
  ];
  for (const change of changes) {
    const f = fixture(['passed', 'passed']);
    try {
      change(f.data);
      const result = evaluate(f.data, { runRoot: f.runRoot });
      assert.equal(result.decision, 'REVIEW'); assert.equal(result.exitCode, 2);
      assert.ok(result.reasons.every(reason => reason.category === 'integrity'));
    } finally { f.close(); }
  }
});

test('malformed or empty summaries cannot pass', () => {
  const f = fixture([]);
  try {
    const wrongSessions = structuredClone(f.data);
    wrongSessions.run.sessions = { session: 'not-an-array' };
    for (const data of [null, {}, f.data, wrongSessions]) {
      const result = evaluate(data, { runRoot: f.runRoot });
      assert.equal(result.decision, 'REVIEW'); assert.equal(result.exitCode, 2);
      assert.equal(result.counts.total, 0);
    }
  } finally { f.close(); }
});

test('valid screenshot/log references pass; missing and traversal references do not', () => {
  const f = fixture();
  try {
    const dir = path.join(f.runRoot, 'browser-sessions', 'session-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'image.png'), 'image');
    const item = f.data.testCases[0];
    item.screenshots = [{ path: 'browser-sessions/session-1/image.png' }];
    item.steps[0].evidence = [{ path: 'browser-sessions/session-1/image.png' }];
    assert.deepEqual(validateSummary(f.data, f.runRoot), []);
    item.screenshots[0].path = 'browser-sessions/session-1/missing.png';
    assert.ok(validateSummary(f.data, f.runRoot).includes('invalid-artifact-reference'));
    item.screenshots[0].path = '../outside.png';
    assert.ok(validateSummary(f.data, f.runRoot).includes('invalid-artifact-reference'));
  } finally { f.close(); }
});

test('runGate writes a separate atomic artifact without mutating summary or replacing an earlier decision', () => {
  const f = fixture(['passed', 'failed']);
  try {
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(f.summary)).digest('hex');
    const result = runGate(f.summary);
    const output = path.join(f.runRoot, 'gate-result.json');
    assert.equal(result.decision, 'FAIL');
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), result);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(f.summary)).digest('hex'), sourceHash);
    assert.equal(fs.readdirSync(f.runRoot).filter(name => name.endsWith('.tmp')).length, 0);
    assert.throws(() => runGate(f.summary), error => error.code === 'EEXIST');
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), result);
  } finally { f.close(); }
});

test('malformed saved JSON writes REVIEW; missing input never creates a false PASS', () => {
  const malformed = fixture();
  const missing = fixture();
  try {
    fs.writeFileSync(malformed.summary, '{ broken');
    const result = runGate(malformed.summary);
    assert.equal(result.decision, 'REVIEW'); assert.equal(result.exitCode, 2);
    fs.unlinkSync(missing.summary);
    const absent = runGate(missing.summary);
    assert.equal(absent.decision, 'REVIEW'); assert.equal(absent.exitCode, 2);
  } finally { malformed.close(); missing.close(); }
});

test('gate output whitelists fields and excludes source URLs, tokens, and auth paths', () => {
  const f = fixture();
  try {
    f.data.run.targetUrl = 'https://token-value@example.test/secret';
    f.data.testCases[0].steps[0].note = 'token-value';
    f.save();
    const result = runGate(f.summary);
    assert.equal(result.decision, 'PASS');
    assert.equal(JSON.stringify(result).includes('token-value'), false);
    assert.equal(JSON.stringify(result).includes('targetUrl'), false);
  } finally { f.close(); }
});
