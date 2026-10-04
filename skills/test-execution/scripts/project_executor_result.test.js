'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { project } = require('./project_executor_result.js');

let passed = 0;
function test(name, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-projection-'));
  try { fn(cwd); passed++; console.log(`  ok - ${name}`); }
  finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function fixture(cwd, { status = 'passed', scenarios, defects = [], failures = [], session = 'smoke-120000-a1b2' } = {}) {
  const runDir = 'executions/execu_2026-01-01_12-00-00';
  const sessionDir = path.join(cwd, runDir, 'browser-sessions', session);
  const shot = `browser-sessions/${session}/screenshots/evidence.png`;
  fs.mkdirSync(path.join(sessionDir, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(cwd, runDir, 'bugs', 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(cwd, runDir, shot), 'png');
  const result = {
    schemaVersion: 1, runDir, session, spec: 'test/اختبار.md', status,
    startedAt: '2026-01-01T12:00:00.000Z', endedAt: '2026-01-01T12:00:01.000Z', durationMs: 1000,
    scenarios: scenarios || [{ name: 'Open', session, status, durationMs: 1000,
      screenshots: [{ path: shot, caption: 'evidence' }], steps: [{ desc: 'Open', status }] }],
    defects, failures, cleanup: { attempted: true, closed: true, error: null },
  };
  const resultFile = path.join(sessionDir, 'executor-result.json');
  fs.writeFileSync(resultFile, JSON.stringify(result));
  return { runDir, sessionDir, shot, result, resultFile };
}

function save(fix) { fs.writeFileSync(fix.resultFile, JSON.stringify(fix.result)); }
function output(cwd, fix) {
  const root = path.join(cwd, fix.runDir);
  return { summary: JSON.parse(fs.readFileSync(path.join(root, 'run-summary.json'), 'utf8')),
    report: fs.readFileSync(path.join(root, 'report.md'), 'utf8'),
    bugs: fs.readFileSync(path.join(root, 'bugs', 'bug-list.md'), 'utf8') };
}

test('PASS projects one scenario, evidence, v2 summary and report', (cwd) => {
  const fix = fixture(cwd);
  const result = project(fix.resultFile, { cwd, targetUrl: 'http://127.0.0.1/' });
  const out = output(cwd, fix);
  assert.equal(result.ok, true);
  assert.equal(out.summary.schemaVersion, 2);
  assert.equal(out.summary.summary.passed, 1);
  assert.equal(out.summary.testCases[0].screenshots[0].path, fix.shot);
  assert.match(out.report, /Outcome:\*\* PASSED/);
  assert.equal(fs.existsSync(path.join(fix.sessionDir, 'session-projection.json')), true);
  const runRoot = path.join(cwd, fix.runDir);
  const html = path.join(runRoot, 'extent-report.html');
  const render = spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'extent-report', 'scripts', 'make_html_report.js'),
    path.join(runRoot, 'run-summary.json'), html], { cwd, encoding: 'utf8' });
  assert.equal(render.status, 0, render.stderr || render.stdout);
  assert.match(fs.readFileSync(html, 'utf8'), /data:image\/png;base64/);
});

test('product FAIL remains failed and defect evidence uses shared bug copy', (cwd) => {
  const fix = fixture(cwd, { status: 'failed', failures: [{ kind: 'product', detail: 'wrong visible text' }] });
  fix.result.defects = [{ title: 'Wrong text', severity: 'Medium', scenario: 'Open',
    expected: 'Expected text', actual: 'Different text', evidence: [fix.shot] }];
  save(fix);
  project(fix.resultFile, { cwd });
  const out = output(cwd, fix);
  assert.equal(out.summary.summary.failed, 1);
  assert.equal(out.summary.defects.length, 1);
  assert.match(out.summary.defects[0].evidence[0], /^bugs\/screenshots\/smoke-/);
  assert.match(out.bugs, /Expected text/);
  assert.match(out.report, /product: wrong visible text/);
});

test('infrastructure failure remains blocked without product defect', (cwd) => {
  const fix = fixture(cwd, { status: 'blocked', failures: [{ kind: 'infrastructure', detail: 'browser could not start' }] });
  project(fix.resultFile, { cwd });
  const out = output(cwd, fix);
  assert.equal(out.summary.summary.blocked, 1);
  assert.deepEqual(out.summary.defects, []);
  assert.match(out.report, /infrastructure: browser could not start/);
});

test('multiple scenarios and defects project exactly once, with Unicode retained', (cwd) => {
  const fix = fixture(cwd);
  fix.result.scenarios = [
    { name: 'السيناريو الأول', session: fix.result.session, status: 'failed', steps: [{ desc: 'تحقق', status: 'failed' }] },
    { name: 'السيناريو الثاني', session: fix.result.session, status: 'passed', steps: [{ desc: 'افتح', status: 'passed' }] },
  ];
  fix.result.status = 'failed';
  fix.result.defects = [
    { title: 'الخطأ الأول', severity: 'High', evidence: [fix.shot] },
    { title: 'الخطأ الثاني', severity: 'Low', evidence: [fix.shot] },
  ];
  save(fix);
  project(fix.resultFile, { cwd });
  const out = output(cwd, fix);
  assert.equal(out.summary.testCases.length, 2);
  assert.equal(out.summary.defects.length, 2);
  assert.equal(out.summary.defects[0].evidence[0], out.summary.defects[1].evidence[0]);
  assert.equal(out.summary.testCases[0].name, 'السيناريو الأول');
  assert.match(out.bugs, /الخطأ الثاني/);
});

test('malformed nested scenario is rejected without output', (cwd) => {
  const fix = fixture(cwd);
  fix.result.scenarios[0].steps = 'bad'; save(fix);
  assert.throws(() => project(fix.resultFile, { cwd }), /invalid executor result/);
  assert.equal(fs.existsSync(path.join(cwd, fix.runDir, 'run-summary.json')), false);
});

test('bad status and session mismatch are rejected', (cwd) => {
  const fix = fixture(cwd);
  fix.result.scenarios[0].status = 'magic'; save(fix);
  assert.throws(() => project(fix.resultFile, { cwd }), /status invalid/);
  fix.result.scenarios[0].status = 'passed'; fix.result.scenarios[0].session = 'other-session'; save(fix);
  assert.throws(() => project(fix.resultFile, { cwd }), /session mismatch/);
});

test('path traversal, absolute outside, and symlink escape are rejected', (cwd) => {
  const fix = fixture(cwd);
  for (const bad of ['../../other-session/file.png', 'C:\\outside\\file.png', path.join(cwd, 'outside.png')]) {
    fix.result.scenarios[0].screenshots[0].path = bad; save(fix);
    assert.throws(() => project(fix.resultFile, { cwd }), /invalid executor result/);
  }
  const outside = path.join(cwd, 'outside.png'); fs.writeFileSync(outside, 'bad');
  const link = path.join(fix.sessionDir, 'screenshots', 'escape.png');
  try {
    fs.symlinkSync(outside, link);
    fix.result.scenarios[0].screenshots[0].path = `browser-sessions/${fix.result.session}/screenshots/escape.png`; save(fix);
    assert.throws(() => project(fix.resultFile, { cwd }), /invalid executor result/);
  } catch (error) { if (error.code !== 'EPERM') throw error; }
});

test('Windows-style relative evidence path normalizes to portable slash path', (cwd) => {
  const fix = fixture(cwd);
  fix.result.scenarios[0].screenshots[0].path = fix.shot.replace(/\//g, '\\'); save(fix);
  project(fix.resultFile, { cwd });
  assert.equal(output(cwd, fix).summary.testCases[0].screenshots[0].path, fix.shot);
});

test('duplicate projection is explicitly rejected', (cwd) => {
  const fix = fixture(cwd);
  project(fix.resultFile, { cwd });
  assert.throws(() => project(fix.resultFile, { cwd }), /already projected/);
  assert.equal(output(cwd, fix).summary.testCases.length, 1);
});

test('another run report is never overwritten', (cwd) => {
  const fix = fixture(cwd);
  const report = path.join(cwd, fix.runDir, 'report.md');
  fs.writeFileSync(report, 'owner data');
  assert.throws(() => project(fix.resultFile, { cwd }), /already exists/);
  assert.equal(fs.readFileSync(report, 'utf8'), 'owner data');
});

test('CLI emits machine-readable error and nonzero exit on invalid result', (cwd) => {
  const fix = fixture(cwd);
  fix.result.spec = ''; save(fix);
  const run = spawnSync(process.execPath, [path.join(__dirname, 'project_executor_result.js'), '--result', fix.resultFile], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).ok, false);
});

console.log(`\nproject_executor_result: ${passed} passed`);
