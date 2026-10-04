'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { finalizeParallel } = require('./finalize_parallel_run.js');

const RUN_DIR = 'executions/execu_2026-01-01_12-00-00';
const START = '2026-01-01T12:00:00.000Z';
const END = '2026-01-01T12:00:10.000Z';

function fixture(count) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-parallel-final-'));
  const runRoot = path.join(cwd, RUN_DIR);
  fs.mkdirSync(path.join(runRoot, 'bugs', 'screenshots'), { recursive: true });
  const assignments = Array.from({ length: count }, (_, index) => {
    const session = `spec${index + 1}-120000-a1b2`;
    const spec = `test/spec-${index + 1}.md`;
    fs.mkdirSync(path.join(cwd, 'test'), { recursive: true });
    fs.writeFileSync(path.join(cwd, spec), '# Spec: fixture\n\n## Scenario\n1. Open');
    const dir = path.join(runRoot, 'browser-sessions', session);
    fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return { workerId: `worker-${index + 1}`, session, spec, label: `spec-${index + 1}` };
  });
  return { cwd, runRoot, assignments, close: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function result(fix, index, { status = 'passed', name, defect = false, evidencePath, duplicateDefect = false } = {}) {
  const assignment = fix.assignments[index];
  const shot = evidencePath || `browser-sessions/${assignment.session}/screenshots/result.png`;
  if (!evidencePath) fs.writeFileSync(path.join(fix.runRoot, shot), 'fake png bytes');
  const value = { schemaVersion: 1, runDir: RUN_DIR, session: assignment.session, spec: assignment.spec,
    status, startedAt: START, endedAt: END, durationMs: 10000,
    scenarios: [{ name: name || `Scenario ${index + 1}`, session: assignment.session, status,
      startedAt: START, endedAt: END, durationMs: 10000, screenshots: [{ path: shot }],
      steps: [{ desc: 'Check fixture', status, evidence: [{ path: shot }] }] }],
    defects: defect ? [{ title: 'Wrong confirmation', severity: 'Medium', scenario: name || `Scenario ${index + 1}`,
      expected: 'Unavailable', actual: 'Visible', evidence: [shot] }] : [],
    failures: status === 'failed' ? [{ kind: 'product', detail: 'wrong text' }]
      : status === 'blocked' ? [{ kind: 'infrastructure', detail: 'browser unavailable' }] : [],
    cleanup: { attempted: true, closed: true, error: null } };
  if (duplicateDefect) value.defects.push(structuredClone(value.defects[0]));
  fs.writeFileSync(path.join(fix.runRoot, 'browser-sessions', assignment.session, 'executor-result.json'), JSON.stringify(value));
  return value;
}

function finalize(fix, extra = {}) {
  return finalizeParallel({ cwd: fix.cwd, runDir: RUN_DIR, assignments: fix.assignments,
    targetUrl: 'http://127.0.0.1:12743/smoke.html', environment: 'local-static',
    loginMode: 'none', startedAt: START, endedAt: END, renderHtml: false, ...extra });
}

test('all PASS: one v2 run, input-order scenarios, Markdown artifacts', () => {
  const f = fixture(3);
  try {
    f.assignments.forEach((_, i) => result(f, i));
    const out = finalize(f);
    const summary = JSON.parse(fs.readFileSync(path.join(f.runRoot, 'run-summary.json')));
    assert.equal(out.status, 'passed');
    assert.equal(out.scheduled, 3);
    assert.equal(out.terminal, 3);
    assert.equal(summary.schemaVersion, 2);
    assert.equal(summary.run.mode, 'parallel');
    assert.equal(summary.summary.passed, 3);
    assert.deepEqual(summary.testCases.map(row => row.name), ['Scenario 1', 'Scenario 2', 'Scenario 3']);
    assert.ok(fs.existsSync(path.join(f.runRoot, 'report.md')));
  } finally { f.close(); }
});

test('completion order never controls report order; product FAIL retains one defect', () => {
  const f = fixture(3);
  try {
    result(f, 0); result(f, 1, { status: 'failed', defect: true }); result(f, 2);
    const workerStates = [2, 0, 1].map(i => ({ workerId: f.assignments[i].workerId, outcome: 'completed' }));
    const out = finalize(f, { workerStates });
    const summary = JSON.parse(fs.readFileSync(path.join(f.runRoot, 'run-summary.json')));
    const report = fs.readFileSync(path.join(f.runRoot, 'report.md'), 'utf8');
    assert.equal(out.status, 'failed');
    assert.equal(summary.summary.passed, 2);
    assert.equal(summary.summary.failed, 1);
    assert.deepEqual(summary.testCases.map(row => row.session), f.assignments.map(a => a.session));
    assert.equal(summary.defects.length, 1);
    assert.match(summary.defects[0].evidence[0], /^bugs\/screenshots\/spec2-/);
    assert.match(report, /product: wrong text/);
  } finally { f.close(); }
});

test('five scheduled always yield five terminal entries, including missing and malformed', () => {
  const f = fixture(5);
  try {
    result(f, 0); result(f, 1); result(f, 2, { status: 'failed', defect: true });
    fs.writeFileSync(path.join(f.runRoot, 'browser-sessions', f.assignments[4].session, 'executor-result.json'), '{bad json');
    const out = finalize(f);
    const summary = JSON.parse(fs.readFileSync(path.join(f.runRoot, 'run-summary.json')));
    assert.equal(out.scheduled, 5);
    assert.equal(out.terminal, 5);
    assert.equal(summary.summary.total, 5);
    assert.equal(summary.summary.passed, 2);
    assert.equal(summary.summary.failed, 1);
    assert.equal(summary.summary.blocked, 2);
    assert.equal(summary.defects.length, 1);
    assert.equal(summary.testCases[3].status, 'blocked');
    assert.equal(summary.testCases[4].status, 'blocked');
  } finally { f.close(); }
});

test('worker crash and timeout become blocked without suppressing valid workers', () => {
  const f = fixture(3);
  try {
    f.assignments.forEach((_, i) => result(f, i));
    const workerStates = [
      { workerId: f.assignments[0].workerId, outcome: 'completed' },
      { workerId: f.assignments[1].workerId, outcome: 'crashed', detail: 'exit 9' },
      { workerId: f.assignments[2].workerId, outcome: 'timeout', detail: 'watchdog' },
    ];
    const out = finalize(f, { workerStates });
    const summary = JSON.parse(fs.readFileSync(path.join(f.runRoot, 'run-summary.json')));
    assert.equal(out.status, 'blocked');
    assert.equal(summary.summary.passed, 1);
    assert.equal(summary.summary.blocked, 2);
    assert.equal(summary.defects.length, 0);
  } finally { f.close(); }
});

test('invalid session ownership, duplicate worker ID and unknown state are rejected', () => {
  const f = fixture(2);
  try {
    result(f, 0); result(f, 1);
    assert.throws(() => finalize(f, { assignments: [f.assignments[0], { ...f.assignments[1], session: f.assignments[0].session }] }), /duplicate session/);
    assert.throws(() => finalize(f, { assignments: [f.assignments[0], { ...f.assignments[1], workerId: f.assignments[0].workerId }] }), /worker ID/);
    assert.throws(() => finalize(f, { workerStates: [{ workerId: f.assignments[0].workerId }, { workerId: 'unknown' }] }), /unknown or missing/);
    assert.equal(fs.existsSync(path.join(f.runRoot, 'run-summary.json')), false);
  } finally { f.close(); }
});

test('result claiming sibling session is blocked, not merged', () => {
  const f = fixture(2);
  try {
    result(f, 0); const bad = result(f, 1);
    bad.session = f.assignments[0].session;
    fs.writeFileSync(path.join(f.runRoot, 'browser-sessions', f.assignments[1].session, 'executor-result.json'), JSON.stringify(bad));
    finalize(f);
    const summary = JSON.parse(fs.readFileSync(path.join(f.runRoot, 'run-summary.json')));
    assert.equal(summary.summary.passed, 1);
    assert.equal(summary.summary.blocked, 1);
  } finally { f.close(); }
});

test('evidence traversal is blocked and cannot enter another session', () => {
  const f = fixture(2);
  try {
    result(f, 0); result(f, 1, { evidencePath: `browser-sessions/${f.assignments[0].session}/screenshots/result.png` });
    finalize(f);
    const summary = JSON.parse(fs.readFileSync(path.join(f.runRoot, 'run-summary.json')));
    assert.equal(summary.summary.passed, 1);
    assert.equal(summary.summary.blocked, 1);
    assert.equal(summary.testCases[1].screenshots, undefined);
  } finally { f.close(); }
});

test('duplicate identical defects collapse but different sessions remain distinct', () => {
  const f = fixture(2);
  try {
    result(f, 0, { status: 'failed', defect: true, duplicateDefect: true });
    result(f, 1, { status: 'failed', defect: true });
    finalize(f);
    const summary = JSON.parse(fs.readFileSync(path.join(f.runRoot, 'run-summary.json')));
    assert.equal(summary.defects.length, 2);
    assert.notEqual(summary.defects[0].evidence[0], summary.defects[1].evidence[0]);
  } finally { f.close(); }
});

test('Windows-style evidence paths and Arabic test names remain valid', () => {
  const f = fixture(1);
  try {
    const value = result(f, 0, { name: 'اختبار التأكيد' });
    value.scenarios[0].screenshots[0].path = value.scenarios[0].screenshots[0].path.replace(/\//g, '\\');
    fs.writeFileSync(path.join(f.runRoot, 'browser-sessions', f.assignments[0].session, 'executor-result.json'), JSON.stringify(value));
    finalize(f);
    const summary = JSON.parse(fs.readFileSync(path.join(f.runRoot, 'run-summary.json')));
    assert.equal(summary.testCases[0].name, 'اختبار التأكيد');
    assert.match(summary.testCases[0].screenshots[0].path, /^browser-sessions\//);
  } finally { f.close(); }
});

test('final artifacts are exclusive and cannot be rewritten by another finalizer', () => {
  const f = fixture(1);
  try {
    result(f, 0); finalize(f);
    assert.throws(() => finalize(f), /already exists/);
  } finally { f.close(); }
});

test('failed browser cleanup verification is visible and blocks an otherwise green run', () => {
  const f = fixture(1);
  try {
    result(f, 0);
    const out = finalize(f, { cleanupIssues: [{ session: f.assignments[0].session, reason: 'session still listed' }] });
    const summary = JSON.parse(fs.readFileSync(path.join(f.runRoot, 'run-summary.json')));
    assert.equal(out.status, 'blocked');
    assert.equal(summary.summary.passed, 1);
    assert.equal(summary.summary.blocked, 1);
    assert.match(fs.readFileSync(path.join(f.runRoot, 'report.md'), 'utf8'), /session still listed/);
  } finally { f.close(); }
});
