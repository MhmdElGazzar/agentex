'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare, finalize, resolve } = require('./host');
const { sha256, freezeAssignment } = require('../lib/execution_result');
const { run, syncSkills } = require('./install');
const { spawnSync } = require('node:child_process');
const { completeBrowser } = require('./browser_test_helper');
const pluginRoot = path.resolve(__dirname, '../..');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-codex-test-'));
const step = (id = 'step-1') => ({ id, assertionIds: ['assert-' + id], evidenceRequired: true });
function setup(scenarios = [{ adHoc: 'Drivers: api\napi: Verify the response.', requiredSteps: [step()] }]) {
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
  const c = setup([{ adHoc: 'Drivers: api\napi: one', requiredSteps: [step('one')] },
    { adHoc: 'Drivers: api\napi: two', requiredSteps: [step('two')] }]);
  const x = result(c, 0), y = result(c, 1);
  assert.equal(finalize(c.runRoot, x.info.assignmentId).verdict, 'PASS');
  assert.equal(finalize(c.runRoot, y.info.assignmentId).verdict, 'PASS');
  assert.equal(JSON.parse(fs.readFileSync(x.info.resultFile)).sessionId, JSON.parse(fs.readFileSync(y.info.resultFile)).sessionId);
});
test('headed scenario cannot validate before matching mode verification', () => {
  const projectRoot = temp();
  const c = prepare({ projectRoot, browserMode: 'HEADED', scenarios: [
    { adHoc: 'Open a page and verify it.', requiredSteps: [step()] },
  ] });
  const { info } = result(c);
  assert.equal(JSON.parse(fs.readFileSync(info.assignmentFile)).browserMode, 'HEADED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.runRoot, 'custody.json'))).assignments[0].browserMode, 'HEADED');
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'BLOCKED');
});
test('headed verification permits validation and rejects foreign metadata', () => {
  const projectRoot = temp();
  const c = prepare({ projectRoot, browserMode: 'HEADED', scenarios: [
    { adHoc: 'Open a page and verify it.', requiredSteps: [step()] },
  ] });
  const { info } = result(c);
  const file = path.join(info.sessionDir, 'logs', 'browser-mode.json');
  completeBrowser(c, { mode: 'HEADED' });
  assert.equal(require('./host').inspect(c.runRoot, info.assignmentId).validation.verdict, 'PASS');
  const altered = JSON.parse(fs.readFileSync(file));
  altered.observedSessions[0].name = 'foreign';
  fs.writeFileSync(file, JSON.stringify(altered));
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'BLOCKED');
});
test('new default HEADLESS browser assignment cannot pass without preflight', () => {
  const c = prepare({ projectRoot: temp(), scenarios: [
    { adHoc: 'Open a page and verify it.', requiredSteps: [step()] }] });
  const { info } = result(c);
  assert.equal(JSON.parse(fs.readFileSync(info.assignmentFile)).browserMode, 'HEADLESS');
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'BLOCKED');
});
for (const [label, damage] of [
  ['actual mode mismatch', (c, info) => {
    const file = path.join(info.sessionDir, 'logs', 'browser-mode.json');
    const record = JSON.parse(fs.readFileSync(file));
    record.observedSessions[0].headed = true;
    fs.writeFileSync(file, JSON.stringify(record));
  }],
  ['missing guarded action', (c, info) => fs.unlinkSync(path.join(info.sessionDir, 'logs', 'browser-actions.jsonl'))],
  ['missing cleanup proof', (c, info) => fs.unlinkSync(path.join(info.sessionDir, 'logs', 'browser-close.jsonl'))],
]) test('default HEADLESS blocks on ' + label, () => {
  const c = prepare({ projectRoot: temp(), scenarios: [
    { adHoc: 'Open a page and verify it.', requiredSteps: [step()] }] });
  const { info } = result(c);
  completeBrowser(c);
  damage(c, info);
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'BLOCKED');
});
test('executor cleanup claim cannot pass without host close evidence', () => {
  const c = prepare({ projectRoot: temp(), browserMode: 'HEADED', scenarios: [
    { adHoc: 'Open a page and verify it.', requiredSteps: [step()] }] });
  const { info, r } = result(c);
  assert.equal(r.cleanup.status, 'completed');
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'BLOCKED');
});
test('HEADED preflight and action cannot pass without host close proof', () => {
  const c = prepare({ projectRoot: temp(), browserMode: 'HEADED', scenarios: [
    { adHoc: 'Open a page and verify it.', requiredSteps: [step()] }] });
  const { info } = result(c);
  completeBrowser(c, { mode: 'HEADED' });
  fs.unlinkSync(path.join(info.sessionDir, 'logs', 'browser-close.jsonl'));
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'BLOCKED');
});
test('explicit HEADLESS browser assignment passes with host-controlled evidence', () => {
  const c = prepare({ projectRoot: temp(), browserMode: 'HEADLESS', scenarios: [
    { adHoc: 'Open a page and verify it.', requiredSteps: [step()] }] });
  const { info } = result(c);
  completeBrowser(c);
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'PASS');
});
test('executor PASS after a failed guarded action remains BLOCKED through report', () => {
  const c = prepare({ projectRoot: temp(), scenarios: [
    { adHoc: 'Open a page and verify it.', requiredSteps: [step()] }] });
  const { info } = result(c);
  completeBrowser(c, { failAfterSuccess: true });
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'BLOCKED');
  const timing = { startedAt: '2026-10-12T00:00:00Z', endedAt: '2026-10-12T00:00:01Z', durationMs: 1000 };
  const output = require('./report').report(c.runRoot, { run: timing,
    scenarios: { [info.assignmentId]: timing } });
  assert.equal(output.verdict, 'BLOCKED');
});
test('one verified close covers a sequential shared session after all assignment actions', () => {
  const c = prepare({ projectRoot: temp(), scenarios: [
    { adHoc: 'Open view one.', requiredSteps: [step('one')] },
    { adHoc: 'Open view two.', requiredSteps: [step('two')] }] });
  const first = result(c, 0), second = result(c, 1);
  completeBrowser(c);
  assert.equal(finalize(c.runRoot, first.info.assignmentId).verdict, 'PASS');
  assert.equal(finalize(c.runRoot, second.info.assignmentId).verdict, 'PASS');
  const closes = fs.readFileSync(path.join(first.info.sessionDir, 'logs', 'browser-close.jsonl'), 'utf8').trim().split(/\r?\n/);
  assert.equal(closes.length, 2); // one attempted and one completed close
});
test('legacy browser assignment remains readable without rewriting historical evidence', () => {
  const c = prepare({ projectRoot: temp(), scenarios: [
    { adHoc: 'Open a page and verify it.', requiredSteps: [step()] }] });
  const { info, r } = result(c);
  const current = JSON.parse(fs.readFileSync(info.assignmentFile));
  const { assignmentDigest, schemaVersion, browserMode, browserEvidenceVersion, ...base } = current;
  const legacy = freezeAssignment(base, { sourceRoot: path.join(c.runRoot, 'sources') });
  fs.writeFileSync(info.assignmentFile, JSON.stringify(legacy));
  const custodyFile = path.join(c.runRoot, 'custody.json');
  const custody = JSON.parse(fs.readFileSync(custodyFile));
  custody.assignments[0].assignmentDigest = legacy.assignmentDigest;
  delete custody.assignments[0].browserMode;
  delete custody.assignments[0].browserEvidenceVersion;
  fs.writeFileSync(custodyFile, JSON.stringify(custody));
  r.assignmentDigest = legacy.assignmentDigest;
  fs.writeFileSync(info.resultFile, JSON.stringify(r));
  assert.equal(finalize(c.runRoot, info.assignmentId).verdict, 'PASS');
  assert.equal(fs.existsSync(path.join(info.sessionDir, 'logs', 'browser-mode.json')), false);
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
