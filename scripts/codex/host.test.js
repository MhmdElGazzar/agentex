'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare, finalize, resolve } = require('./host');
const { sha256 } = require('../lib/execution_result');
const { run, syncSkills } = require('./install');
const { spawnSync } = require('node:child_process');
const pluginRoot = path.resolve(__dirname, '../..');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-codex-test-'));
const step = (id = 'step-1') => ({ id, assertionIds: ['assert-' + id], evidenceRequired: true });
function setup(scenarios = [{ adHoc: 'Open the page and verify the title.', requiredSteps: [step()] }]) {
  const projectRoot = temp();
  fs.mkdirSync(path.join(projectRoot, 'executions'));
  return prepare({ projectRoot, scenarios });
}
function result(c, index = 0, outcome = 'PASS') {
  const info = c.assignments[index], a = JSON.parse(fs.readFileSync(info.assignmentFile, 'utf8'));
  const evidencePath = `browser-sessions/${c.sessionId}/${a.assignmentId}.txt`;
  const evidenceFile = path.join(c.runRoot, evidencePath);
  fs.writeFileSync(evidenceFile, 'observed ' + outcome);
  const failed = outcome === 'FAIL';
  const blocked = outcome === 'BLOCKED';
  const steps = a.requiredSteps.map(s => ({
    stepId: s.id, runId: a.runId, attemptId: a.attemptId, assignmentId: a.assignmentId, sessionId: a.sessionId,
    outcome, assertions: blocked ? [] : s.assertionIds.map(id => ({ id, passed: !failed })),
    evidence: [{ path: evidencePath, sha256: sha256(fs.readFileSync(evidenceFile)) }],
  }));
  const summary = { total: 1, passed: outcome === 'PASS' ? 1 : 0, failed: failed ? 1 : 0,
    blocked: blocked ? 1 : 0, warnings: 0, flaky: 0 };
  const r = { schemaVersion: 1, runId: a.runId, attemptId: a.attemptId, assignmentId: a.assignmentId,
    assignmentDigest: a.assignmentDigest, sourceDigest: a.source.digest, scope: a.scope,
    sessionId: a.sessionId, steps,
    cleanup: { runId: a.runId, attemptId: a.attemptId, assignmentId: a.assignmentId, sessionId: a.sessionId, status: 'completed' },
    scenarioOutcome: outcome, summary, verdict: outcome, exitCode: { PASS: 0, FAIL: 1, BLOCKED: 2 }[outcome] };
  fs.writeFileSync(info.resultFile, JSON.stringify(r));
  return { r, info, evidenceFile };
}
test('Codex init installs discoverable skills and reuses existing scaffold', () => {
  const project = temp();
  const r = run('init', project);
  assert.equal(r.ok, true, r.base.stderr);
  for (const name of ['agentex-init', 'agentex-test', 'agentex-update']) {
    const file = path.join(project, '.agents', 'skills', name, 'SKILL.md');
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp('name: ' + name));
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.agentex', 'codex.json'))).pluginRoot, pluginRoot);
  assert.ok(fs.existsSync(path.join(project, 'config', 'project.json')));
});
test('Codex update preserves edited skills and user config', () => {
  const project = temp();
  assert.equal(run('init', project).ok, true);
  const skill = path.join(project, '.agents', 'skills', 'agentex-test', 'SKILL.md');
  fs.appendFileSync(skill, '\nuser change\n');
  const config = path.join(project, 'config', 'project.json');
  const before = fs.readFileSync(config);
  const rejected = run('update', project);
  assert.equal(rejected.ok, false); // Existing migrator requires git rollback.
  const skills = syncSkills(project);
  assert.ok(skills.some(x => x.skill === 'agentex-test' && x.status === 'preserved-user-edit'));
  assert.match(fs.readFileSync(skill, 'utf8'), /user change/);
  assert.deepEqual(fs.readFileSync(config), before);
});
test('saved and ad hoc specs retain source identity and freeze obligations', () => {
  const project = temp();
  fs.mkdirSync(path.join(project, 'executions'));
  fs.mkdirSync(path.join(project, 'test'));
  fs.writeFileSync(path.join(project, 'test', 'sample.md'), 'Drivers: browser\n1. Fill a form and submit.\n');
  const c = prepare({ projectRoot: project, scenarios: [
    { spec: 'test/sample.md', requiredSteps: [step('saved')] },
    { adHoc: 'Choose an item and verify confirmation.', requiredSteps: [step('adhoc')] },
  ] });
  assert.equal(c.assignments.length, 2);
  assert.equal(c.assignments[0].sourceIdentity, 'test/sample.md');
  assert.match(c.assignments[1].sourceIdentity, /^ad-hoc:/);
  assert.notEqual(c.assignments[0].assignmentId, c.assignments[1].assignmentId);
  assert.notEqual(c.assignments[0].resultFile, c.assignments[1].resultFile);
  assert.equal(c.assignments[0].drivers[0], 'browser');
  assert.equal(JSON.parse(fs.readFileSync(c.assignments[0].assignmentFile)).requiredSteps[0].id, 'saved');
});
test('multiple sequential results in one session validate independently', () => {
  const c = setup([{ adHoc: 'one', requiredSteps: [step('one')] }, { adHoc: 'two', requiredSteps: [step('two')] }]);
  const x = result(c, 0), y = result(c, 1);
  assert.equal(finalize(c.runRoot, x.info.assignmentId).verdict, 'PASS');
  assert.equal(finalize(c.runRoot, y.info.assignmentId).verdict, 'PASS');
  assert.equal(JSON.parse(fs.readFileSync(x.info.resultFile)).sessionId, JSON.parse(fs.readFileSync(y.info.resultFile)).sessionId);
});
for (const outcome of ['PASS', 'FAIL', 'BLOCKED']) test('authoritative ' + outcome, () => {
  const c = setup(), { info } = result(c, 0, outcome);
  const v = finalize(c.runRoot, info.assignmentId);
  assert.equal(v.verdict, outcome);
  assert.equal(v.exitCode, { PASS: 0, FAIL: 1, BLOCKED: 2 }[outcome]);
});
test('missing step cannot pass', () => {
  const c = setup([{ adHoc: 'two steps', requiredSteps: [step('one'), step('two')] }]);
  const { r, info } = result(c);
  r.steps.pop(); fs.writeFileSync(info.resultFile, JSON.stringify(r));
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'BLOCKED');
});

test('ordinary result cannot be given a UI resolution', () => {
  const c = setup(), { info, r } = result(c);
  assert.throws(() => resolve(c.runRoot, info.assignmentId, { answers: [], finalResult: r }), /pending UI result/);
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'PASS');
});
test('stale assignment and result cannot pass', () => {
  const c = setup(), { r, info } = result(c);
  r.attemptId = 'old'; fs.writeFileSync(info.resultFile, JSON.stringify(r));
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'BLOCKED');
});
test('malformed result cannot pass', () => {
  const c = setup(), info = c.assignments[0];
  fs.writeFileSync(info.resultFile, '{invalid');
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'BLOCKED');
});
test('evidence replacement cannot pass', () => {
  const c = setup(), { info, evidenceFile } = result(c);
  fs.writeFileSync(evidenceFile, 'replaced');
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'BLOCKED');
});
test('cleanup failure cannot pass', () => {
  const c = setup(), { r, info } = result(c);
  r.cleanup.status = 'failed'; fs.writeFileSync(info.resultFile, JSON.stringify(r));
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'BLOCKED');
});
test('assignment rewrite conflicts with custody', () => {
  const c = setup(), { info } = result(c);
  const a = JSON.parse(fs.readFileSync(info.assignmentFile));
  a.requiredSteps[0].id = 'replaced';
  fs.writeFileSync(info.assignmentFile, JSON.stringify(a));
  assert.throws(() => finalize(c.runRoot, info.assignmentId), /custody mismatch|assignment/);
});

test('CLI propagates validated PASS, FAIL, and BLOCKED exit codes', () => {
  for (const outcome of ['PASS', 'FAIL', 'BLOCKED']) {
    const c = setup(), { info } = result(c, 0, outcome);
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'host.js'), 'finalize', c.runRoot, info.assignmentId], { encoding: 'utf8' });
    assert.equal(cli.status, { PASS: 0, FAIL: 1, BLOCKED: 2 }[outcome]);
    assert.equal(JSON.parse(cli.stdout).verdict, outcome);
  }
});
test('native Codex skills are in the repository discovery directory', () => {
  for (const name of ['agentex-init', 'agentex-test', 'agentex-update']) {
    const file = path.join(pluginRoot, '.agents', 'skills', name, 'SKILL.md');
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp('^---\\nname: ' + name, 'm'));
  }
});
