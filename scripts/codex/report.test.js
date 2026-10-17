'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepare, finalize } = require('./host');
const { report } = require('./report');
const { run } = require('./install');
const { resolvePaths } = require('./paths');
const { sha256 } = require('../lib/execution_result');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const timing = { startedAt: '2026-10-11T10:00:00Z', endedAt: '2026-10-11T10:00:01Z', durationMs: 1000 };
function fixture(outcomes, policy = { warningsFailGate: true, flakyFailsGate: false }) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-codex-report-'));
  const c = prepare({ projectRoot, policy, scenarios: outcomes.map((o, i) => ({ adHoc: 'Drivers: api\napi: Synthetic scenario ' + i,
    requiredSteps: [{ id: 'observe', assertionIds: ['expected'], evidenceRequired: true }] })) });
  const metadata = { run: timing, scenarios: {} };
  outcomes.forEach((outcome, i) => {
    const info = c.assignments[i], a = read(info.assignmentFile);
    const ids = { runId: a.runId, attemptId: a.attemptId, assignmentId: a.assignmentId, sessionId: a.sessionId };
    const evidencePath = `browser-sessions/${c.sessionId}/logs/${a.assignmentId}.log`;
    fs.writeFileSync(path.join(c.runRoot, evidencePath), 'Synthetic observation');
    const verdict = outcome === 'WARNING' ? (policy.warningsFailGate ? 'FAIL' : 'PASS')
      : outcome === 'FLAKY' ? (policy.flakyFailsGate ? 'BLOCKED' : 'PASS') : outcome;
    const summary = { total: 1, passed: 0, failed: 0, blocked: 0, warnings: 0, flaky: 0 };
    summary[{ PASS: 'passed', FAIL: 'failed', BLOCKED: 'blocked', WARNING: 'warnings', FLAKY: 'flaky' }[outcome]]++;
    save(info.resultFile, { schemaVersion: 1, ...ids, assignmentDigest: a.assignmentDigest,
      sourceDigest: a.source.digest, scope: a.scope, scenarioOutcome: outcome, summary, verdict,
      exitCode: { PASS: 0, FAIL: 1, BLOCKED: 2 }[verdict], cleanup: { ...ids, status: 'completed' },
      steps: [{ ...ids, stepId: 'observe', outcome, assertions: outcome === 'BLOCKED' ? [] : [{ id: 'expected', passed: outcome !== 'FAIL' }],
        evidence: [{ path: evidencePath, sha256: sha256(fs.readFileSync(path.join(c.runRoot, evidencePath))) }] }] });
    metadata.scenarios[a.assignmentId] = timing;
  });
  return { c, metadata };
}
for (const [outcomes, expected] of [[['PASS'], 'PASS'], [['FAIL'], 'FAIL'], [['BLOCKED'], 'BLOCKED'],
  [['PASS', 'FAIL'], 'FAIL'], [['PASS', 'BLOCKED'], 'BLOCKED']]) {
  test('standard reports and CLI: ' + outcomes.join('+'), () => {
    const { c, metadata } = fixture(outcomes);
    const meta = path.join(c.runRoot, 'metadata.json'); save(meta, metadata);
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'host.js'), 'report', c.runRoot, meta], { encoding: 'utf8' });
    assert.equal(cli.status, { PASS: 0, FAIL: 1, BLOCKED: 2 }[expected], cli.stderr);
    assert.equal(JSON.parse(cli.stdout).verdict, expected);
    const data = read(path.join(c.runRoot, 'run-summary.json'));
    assert.equal(data.schemaVersion, 2);
    assert.equal(data.summary.total, outcomes.length);
    assert.equal(data.testCases.length, outcomes.length);
    assert.equal(data.summary.passed, outcomes.filter(x => x === 'PASS').length);
    assert.equal(data.summary.failed, outcomes.filter(x => x === 'FAIL').length);
    assert.equal(data.summary.blocked, outcomes.filter(x => x === 'BLOCKED').length);
    assert.match(fs.readFileSync(path.join(c.runRoot, 'report.md'), 'utf8'), new RegExp(`Verdict: \\*\\*${expected}`));
    const html = fs.readFileSync(path.join(c.runRoot, 'extent-report.html'), 'utf8');
    assert.match(html, new RegExp(`class="verdict-label"[^>]*>${{ PASS: 'PASSED', FAIL: 'FAILED', BLOCKED: 'BLOCKED' }[expected]}`));
  });
}

test('named view mismatch reaches summary, Markdown, and HTML without a product FAIL', () => {
  const { c, metadata } = fixture(['BLOCKED']);
  const info = c.assignments[0], value = read(info.resultFile);
  value.steps[0].uiCheck = { status: 'VIEW MISMATCH ERROR', reason: 'baseline mobile, actual desktop' };
  save(info.resultFile, value);
  const output = report(c.runRoot, metadata);
  assert.equal(output.verdict, 'BLOCKED');
  assert.equal(output.counts.viewMismatch, 1);
  const summary = read(path.join(c.runRoot, 'run-summary.json'));
  assert.equal(summary.testCases[0].status, 'viewMismatch');
  assert.match(fs.readFileSync(path.join(c.runRoot, 'report.md'), 'utf8'), /VIEW MISMATCH ERROR/);
  assert.match(fs.readFileSync(path.join(c.runRoot, 'extent-report.html'), 'utf8'), /view mismatch/i);
});
test('missing execution result is retained as BLOCKED in all reports', () => {
  const { c, metadata } = fixture(['PASS']); fs.unlinkSync(c.assignments[0].resultFile);
  assert.equal(report(c.runRoot, metadata).exitCode, 2);
  assert.equal(read(path.join(c.runRoot, 'run-summary.json')).summary.blocked, 1);
});
test('malformed and forged validation output cannot pass', () => {
  for (const body of ['{bad', JSON.stringify({ verdict: 'PASS', exitCode: 0 })]) {
    const { c, metadata } = fixture(['PASS']);
    fs.writeFileSync(path.join(c.runRoot, 'validation', c.assignments[0].assignmentId + '.json'), body);
    assert.equal(report(c.runRoot, metadata).exitCode, 2);
    assert.equal(read(path.join(c.runRoot, 'run-summary.json')).summary.blocked, 1);
  }
});
test('inconsistent counts and missing timing fail reporting', () => {
  for (const change of [m => { m.summary = { total: 100, passed: 100 }; }, m => { delete m.run; }]) {
    const { c, metadata } = fixture(['PASS']); change(metadata);
    assert.equal(report(c.runRoot, metadata).exitCode, 2);
    assert.equal(fs.existsSync(path.join(c.runRoot, 'extent-report.html')), false);
  }
});
test('report failure clears stale successful reports and preserves product FAIL', () => {
  for (const outcome of ['PASS', 'FAIL']) {
    const { c, metadata } = fixture([outcome]); report(c.runRoot, metadata);
    const output = report(c.runRoot, metadata, { render() { throw Error('controlled renderer failure'); } });
    assert.equal(output.exitCode, outcome === 'FAIL' ? 1 : 2);
    assert.equal(fs.existsSync(path.join(c.runRoot, 'extent-report.html')), false);
    assert.equal(read(path.join(c.runRoot, 'verdict.json')).ok, false);
  }
});
test('warning/flaky policies preserve status counts and authoritative HTML verdict', () => {
  for (const warningsFailGate of [true, false]) for (const flakyFailsGate of [true, false]) {
    const { c, metadata } = fixture(['WARNING', 'FLAKY'], { warningsFailGate, flakyFailsGate });
    const expected = warningsFailGate ? 'FAIL' : flakyFailsGate ? 'BLOCKED' : 'PASS';
    const output = report(c.runRoot, metadata);
    assert.equal(output.verdict, expected);
    assert.equal(output.counts.warnings, 1); assert.equal(output.counts.flaky, 1); assert.equal(output.counts.passed, 0);
    assert.match(fs.readFileSync(path.join(c.runRoot, 'extent-report.html'), 'utf8'),
      new RegExp(`class="verdict-label"[^>]*>${{ PASS: 'PASSED', FAIL: 'FAILED', BLOCKED: 'BLOCKED' }[expected]}`));
  }
});
test('revalidation detects stale evidence after finalize', () => {
  const { c, metadata } = fixture(['PASS']); finalize(c.runRoot, c.assignments[0].assignmentId);
  const r = read(c.assignments[0].resultFile);
  fs.writeFileSync(path.join(c.runRoot, r.steps[0].evidence[0].path), 'changed');
  assert.equal(report(c.runRoot, metadata).exitCode, 2);
});
test('mixed warning and flaky steps retain the validator gate despite representative flaky counts', () => {
  const { c, metadata } = fixture(['FLAKY']);
  const info = c.assignments[0], a = read(info.assignmentFile);
  a.requiredSteps.push({ id: 'warn', assertionIds: ['warning'], evidenceRequired: false });
  const { freezeAssignment } = require('../lib/execution_result');
  const frozen = freezeAssignment(a, { sourceRoot: c.sourceRoot }); save(info.assignmentFile, frozen);
  const custodyFile = path.join(c.runRoot, 'custody.json'), custody = read(custodyFile);
  Object.assign(custody.assignments[0], { requiredSteps: frozen.requiredSteps, assignmentDigest: frozen.assignmentDigest });
  save(custodyFile, custody);
  const r = read(info.resultFile); r.assignmentDigest = frozen.assignmentDigest;
  r.steps.push({ ...r.steps[0], stepId: 'warn', outcome: 'WARNING', assertions: [{ id: 'warning', passed: true }], evidence: [] });
  r.verdict = 'FAIL'; r.exitCode = 1; save(info.resultFile, r);
  const output = report(c.runRoot, metadata);
  assert.equal(output.verdict, 'FAIL'); assert.equal(output.counts.flaky, 1); assert.equal(output.counts.warnings, 0);
  assert.match(fs.readFileSync(path.join(c.runRoot, 'extent-report.html'), 'utf8'), /class="verdict-label"[^>]*>FAILED/);
});
test('report renderer filesystem failure propagates through the CLI', () => {
  const { c, metadata } = fixture(['PASS']);
  fs.mkdirSync(path.join(c.runRoot, 'extent-report.html'));
  const meta = path.join(c.runRoot, 'metadata.json'); save(meta, metadata);
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'host.js'), 'report', c.runRoot, meta], { encoding: 'utf8' });
  assert.equal(cli.status, 2); assert.equal(JSON.parse(cli.stdout).verdict, 'BLOCKED');
});
test('successful initialized Git consumer update preserves edited skill and config', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-codex-lifecycle-'));
  assert.equal(spawnSync('git', ['init', project]).status, 0);
  assert.equal(run('init', project).ok, true);
  const skill = path.join(project, '.agents/skills/agentex-test/SKILL.md');
  fs.appendFileSync(skill, '\nIntentional consumer note.\n');
  const configFile = path.join(project, 'config/project.json');
  const config = read(configFile); config.login = { mode: 'fresh' }; save(configFile, config);
  const before = fs.readFileSync(configFile);
  const result = run('update', project);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.skills.some(x => x.skill === 'agentex-test' && x.status === 'preserved-user-edit'));
  assert.deepEqual(fs.readFileSync(configFile), before);
  const paths = resolvePaths(project, 'api-integration');
  assert.equal(paths.CLAUDE_PLUGIN_ROOT, path.resolve(__dirname, '../..'));
  assert.equal(paths.CLAUDE_SKILL_DIR, path.join(paths.pluginRoot, 'skills/api-integration'));
  assert.throws(() => resolvePaths(project, '../escape'));
});
