'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, names } = require('./install');
const { prepare, inspect, resolve, finalize } = require('../codex/host');
const { launch, finish } = require('../codex/parallel');
const { report } = require('../codex/report');
const { sha256 } = require('../lib/execution_result');
const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const timing = { startedAt: '2026-10-12T00:00:00Z', endedAt: '2026-10-12T00:00:04Z', durationMs: 4000 };
function fixture(capacity = 2) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-copilot-'));
  const custody = prepare({ projectRoot, mode: 'parallel', hostCapacity: capacity,
    scenarios: ['Observe the welcome message', 'Observe a controlled error'].map((adHoc, i) => ({ adHoc,
      requiredSteps: [{ id: `observe-${i}`, assertionIds: [`assert-${i}`], evidenceRequired: true }] })) });
  return custody;
}
function result(c, index, outcome = 'PASS', mutate = () => {}) {
  const record = c.assignments[index], assignment = read(record.assignmentFile);
  const ids = { runId: assignment.runId, attemptId: assignment.attemptId,
    assignmentId: assignment.assignmentId, sessionId: assignment.sessionId };
  const rel = `browser-sessions/${record.sessionId}/logs/observation.txt`;
  fs.writeFileSync(path.join(c.runRoot, rel), `actual ${outcome}`);
  const step = { ...ids, stepId: `observe-${index}`, outcome,
    assertions: outcome === 'BLOCKED' ? [] : [{ id: `assert-${index}`, passed: outcome !== 'FAIL' }],
    expected: 'expected observation', observed: `actual ${outcome}`,
    evidence: [{ path: rel, sha256: sha256(fs.readFileSync(path.join(c.runRoot, rel))) }] };
  const value = { schemaVersion: 1, ...ids, assignmentDigest: assignment.assignmentDigest,
    sourceDigest: assignment.source.digest, scope: assignment.scope, steps: [step],
    cleanup: { ...ids, status: 'completed' }, scenarioOutcome: outcome,
    summary: { total: 1, passed: outcome === 'PASS' ? 1 : 0, failed: outcome === 'FAIL' ? 1 : 0,
      blocked: outcome === 'BLOCKED' ? 1 : 0, warnings: 0, flaky: 0 },
    verdict: outcome, exitCode: { PASS: 0, FAIL: 1, BLOCKED: 2 }[outcome] };
  mutate(value, path.join(c.runRoot, rel));
  fs.writeFileSync(record.resultFile, JSON.stringify(value), { flag: 'wx' });
}
function meta(c) {
  return { run: timing, scenarios: Object.fromEntries(c.assignments.map(a => [a.assignmentId, timing])) };
}
test('Copilot workspace agents install without overwriting edits', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-copilot-install-'));
  assert.deepEqual(install(project).actions.map(x => x.status), ['installed', 'installed']);
  const config = read(path.join(project, '.agentex', 'copilot.json'));
  assert.equal(config.pluginRoot, root);
  for (const name of names) {
    const installed = path.join(project, '.github', 'agents', name + '.agent.md');
    const source = path.join(root, '.github', 'agents', name + '.agent.md');
    assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(source, 'utf8'));
    assert.match(fs.readFileSync(installed, 'utf8'), /target: github-copilot/);
  }
  const executor = path.join(project, '.github', 'agents', names[1] + '.agent.md');
  fs.appendFileSync(executor, '\nConsumer note.\n');
  assert.deepEqual(install(project).actions.map(x => x.status), ['current', 'preserved-user-edit']);
  assert.match(fs.readFileSync(executor, 'utf8'), /Consumer note/);
});

test('Copilot installer rejects linked agents parent before outside writes', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-copilot-linked-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-copilot-outside-'));
  fs.mkdirSync(path.join(project, '.github'));
  try { fs.symlinkSync(outside, path.join(project, '.github', 'agents'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('links unavailable');
    throw error;
  }
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  assert.throws(() => install(project), /link|junction|contain|unsafe/i);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
});

test('Copilot installer rejects linked metadata parent before installing agents', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-copilot-linked-meta-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-copilot-outside-meta-'));
  try { fs.symlinkSync(outside, path.join(project, '.agentex'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('links unavailable');
    throw error;
  }
  assert.throws(() => install(project), /link|junction|contain|unsafe/i);
  assert.equal(fs.existsSync(path.join(project, '.github')), false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('Copilot installer rejects linked .github and dangling agents parents', (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-copilot-paths-'));
  for (const part of ['github', 'dangling-agents']) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-copilot-project-'));
    const alias = part === 'github' ? path.join(project, '.github') : path.join(project, '.github', 'agents');
    const destination = part === 'github' ? outside : path.join(outside, 'absent');
    if (part !== 'github') fs.mkdirSync(path.dirname(alias));
    try { fs.symlinkSync(destination, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('links unavailable');
      throw error;
    }
    assert.throws(() => install(project), /link|junction|contain|unsafe/i);
  }
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('handoff names Copilot native delegation and canonical executor without Local tool', () => {
  const coordinator = fs.readFileSync(path.join(root, '.github', 'agents', names[0] + '.agent.md'), 'utf8');
  const executor = fs.readFileSync(path.join(root, '.github', 'agents', names[1] + '.agent.md'), 'utf8');
  assert.match(coordinator, /native Copilot/);
  assert.match(coordinator, /host\.js prepare/);
  assert.match(coordinator, /parallel\.js launch/);
  assert.match(coordinator, /host\.js report/);
  assert.match(executor, /agents\/qa-executor\.md/);
  assert.match(executor, /scripts\/lib\/execution_result\.md/);
  assert.match(executor, /assignmentFile/);
  assert.match(executor, /resultFile/);
  assert.match(executor, /sessionId/);
  assert.match(executor, /cleanup/);
});
test('Copilot handoff through shared production contracts retains identity, failures, and reports', () => {
  const c = fixture(2);
  assert.equal(c.concurrency, 2);
  assert.notEqual(c.assignments[0].sessionId, c.assignments[1].sessionId);
  assert.notEqual(c.assignments[0].resultFile, c.assignments[1].resultFile);
  assert.notEqual(c.assignments[0].attemptId, c.assignments[1].attemptId);
  for (const [i, outcome] of ['PASS', 'FAIL'].entries()) {
    launch(c.runRoot, c.assignments[i].assignmentId, `/copilot/observed-${i}`,
      `2026-10-12T00:00:0${i}Z`);
    result(c, i, outcome);
    finish(c.runRoot, c.assignments[i].assignmentId, 'completed',
      `2026-10-12T00:00:0${i + 2}Z`);
    assert.equal(finalize(c.runRoot, c.assignments[i].assignmentId).verdict, outcome);
  }
  const output = report(c.runRoot, meta(c));
  assert.equal(output.verdict, 'FAIL');
  assert.equal(output.exitCode, 1);
  assert.deepEqual([output.counts.total, output.counts.passed, output.counts.failed], [2, 1, 1]);
  assert.equal(read(path.join(c.runRoot, 'verdict.json')).verdict, 'FAIL');
  assert.equal(read(path.join(c.runRoot, 'run-summary.json')).summary.total, 2);
  assert.match(fs.readFileSync(path.join(c.runRoot, 'report.md'), 'utf8'), /Verdict: \*\*FAIL/);
  assert.match(fs.readFileSync(path.join(c.runRoot, 'extent-report.html'), 'utf8'), /FAILED/);
});
test('Copilot missing, cancelled, timed out, stale, evidence and cleanup faults cannot pass', () => {
  for (const fault of ['missing', 'cancelled', 'timed-out', 'stale', 'evidence', 'cleanup', 'blocked']) {
    const c = fixture(1), first = c.assignments[0], second = c.assignments[1];
    launch(c.runRoot, first.assignmentId, '/copilot/observed-0');
    result(c, 0);
    finish(c.runRoot, first.assignmentId, 'completed');
    if (fault !== 'missing') {
      launch(c.runRoot, second.assignmentId, '/copilot/observed-1');
      if (fault === 'cancelled' || fault === 'timed-out') finish(c.runRoot, second.assignmentId, fault);
      else {
        result(c, 1, fault === 'blocked' ? 'BLOCKED' : 'PASS', (value, evidence) => {
          if (fault === 'stale') value.attemptId = 'stale';
          if (fault === 'evidence') fs.unlinkSync(evidence);
          if (fault === 'cleanup') value.cleanup.status = 'failed';
        });
        finish(c.runRoot, second.assignmentId, 'completed');
      }
    }
    const output = report(c.runRoot, meta(c));
    assert.equal(output.verdict, 'BLOCKED', fault);
  }
});
test('duplicate result and lifecycle completion cannot overwrite first submission', () => {
  const c = fixture(1), record = c.assignments[0];
  launch(c.runRoot, record.assignmentId, '/copilot/observed-0');
  result(c, 0);
  assert.throws(() => result(c, 0), /EEXIST/);
  finish(c.runRoot, record.assignmentId, 'completed');
  assert.throws(() => finish(c.runRoot, record.assignmentId, 'completed'), /EEXIST/);
  assert.equal(read(record.resultFile).scenarioOutcome, 'PASS');
});

test('Copilot handoff keeps deferred UI BLOCKED until coordinator resolution', () => {
  const c = fixture(1), first = c.assignments[0], second = c.assignments[1];
  launch(c.runRoot, first.assignmentId, '/copilot/first');
  result(c, 0, 'BLOCKED', value => {
    const images = ['baseline.png', 'actual.png'].map(name => {
      const rel = `browser-sessions/${first.sessionId}/screenshots/${name}`;
      const file = path.join(c.runRoot, rel);
      fs.writeFileSync(file, name);
      return { path: rel, sha256: sha256(fs.readFileSync(file)) };
    });
    value.steps[0].evidence.push(...images);
    value.steps[0].uiCheck = { status: 'NEEDS-USER', question: 'Is the observed variation expected?',
      baselineImage: images[0].path, actualImage: images[1].path };
  });
  finish(c.runRoot, first.assignmentId, 'completed');
  assert.equal(inspect(c.runRoot, first.assignmentId).validation.verdict, 'BLOCKED');
  const raw = read(first.resultFile), finalResult = structuredClone(raw);
  finalResult.steps[0].outcome = 'PASS';
  finalResult.steps[0].assertions = [{ id: 'assert-0', passed: true }];
  finalResult.steps[0].uiCheck.status = 'PASS';
  finalResult.scenarioOutcome = finalResult.verdict = 'PASS';
  finalResult.summary = { total: 1, passed: 1, failed: 0, blocked: 0, warnings: 0, flaky: 0 };
  finalResult.exitCode = 0;
  const answer = { stepId: 'observe-0', question: raw.steps[0].uiCheck.question,
    resolution: 'Expected variation', finalStatus: 'PASS' };
  assert.equal(resolve(c.runRoot, first.assignmentId, { answers: [answer], finalResult }).verdict, 'PASS');
  assert.equal(finalize(c.runRoot, first.assignmentId).verdict, 'PASS');
  launch(c.runRoot, second.assignmentId, '/copilot/second');
  result(c, 1);
  finish(c.runRoot, second.assignmentId, 'completed');
  assert.equal(finalize(c.runRoot, second.assignmentId).verdict, 'PASS');
  assert.equal(report(c.runRoot, meta(c)).verdict, 'PASS');
  const summary = read(path.join(c.runRoot, 'run-summary.json'));
  assert.equal(summary.testCases[0].deferred[0].resolution, answer.resolution);
});
