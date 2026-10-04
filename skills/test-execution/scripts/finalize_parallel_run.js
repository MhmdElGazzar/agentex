'use strict';

// The only writer of parallel run-level artifacts. Workers own their session
// directories; this module reads every assigned result in input order after
// all workers are terminal, then renders the existing v2/Markdown/HTML formats.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validate, evidencePath } = require('./validate_executor_result.js');
const { mergeEvidence } = require('./merge_run.js');

const STATUS_KEY = { passed: 'passed', failed: 'failed', blocked: 'blocked', na: 'naDescoped',
  notrun: 'notRun', warning: 'warnings', viewMismatch: 'viewMismatch', flaky: 'flaky' };
const COUNT_KEYS = ['passed', 'failed', 'blocked', 'naDescoped', 'notRun'];
const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
const portable = value => value.replace(/\\/g, '/');
const md = value => String(value ?? '').replace(/\r?\n/g, ' ').replace(/[\[\]<>]/g, '');
const link = (relative, label) => `[${md(label)}](./${relative})`;

function blockedResult(assignment, reason, kind = 'infrastructure') {
  return { status: 'blocked', scenarios: [{
    name: `Worker blocked: ${assignment.label}`, spec: assignment.spec, session: assignment.session,
    status: 'blocked', steps: [{ desc: 'Execute assigned specification', status: 'blocked', note: reason }],
  }], defects: [], failures: [{ kind, detail: reason }], cleanup: { attempted: false, closed: false, error: reason } };
}

function inspectResult(cwd, runDir, assignment, workerState, resultValidator) {
  if (workerState && workerState.outcome !== 'completed') {
    return blockedResult(assignment, `worker ${workerState.outcome}${workerState.detail ? `: ${workerState.detail}` : ''}`,
      workerState.outcome === 'launch-failed' ? 'infrastructure' : 'automation');
  }
  const runRoot = path.resolve(cwd, runDir);
  const sessionRoot = path.join(runRoot, 'browser-sessions', assignment.session);
  const file = path.join(sessionRoot, 'executor-result.json');
  if (!fs.existsSync(file)) return blockedResult(assignment, 'worker produced no executor-result.json');
  try {
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    const errors = validate(result, cwd);
    if (result.runDir !== runDir || result.session !== assignment.session ||
      path.resolve(cwd, result.spec) !== path.resolve(cwd, assignment.spec)) {
      errors.push('result does not match immutable assignment');
    }
    if (!result.scenarios || result.scenarios.length === 0) errors.push('result has no terminal scenarios');
    if (resultValidator) {
      try { errors.push(...resultValidator(result, assignment)); }
      catch (error) { errors.push(`result coverage check failed: ${error.message}`); }
    }
    if (errors.length) return blockedResult(assignment, `invalid executor result: ${errors.join('; ')}`, 'automation');
    return result;
  } catch (error) { return blockedResult(assignment, `malformed executor result: ${error.message}`, 'automation'); }
}

function finalizeParallel({ cwd = process.cwd(), runDir, assignments, targetUrl, environment,
  loginMode, startedAt, endedAt = new Date().toISOString(), tools, workerStates = [], cleanupIssues = [], renderHtml = true,
  resultValidator } = {}) {
  if (!/^executions[\\/]execu_[^\\/]+$/.test(runDir || '')) throw new Error('invalid runDir');
  if (!Array.isArray(assignments) || !assignments.length) throw new Error('assignments required');
  if (!startedAt || Number.isNaN(Date.parse(startedAt)) || Number.isNaN(Date.parse(endedAt))) throw new Error('invalid run timestamps');
  const runRoot = path.resolve(cwd, runDir);
  const executionsRoot = path.resolve(cwd, 'executions');
  if (!inside(fs.realpathSync(cwd), fs.realpathSync(executionsRoot)) ||
    !inside(fs.realpathSync(executionsRoot), fs.realpathSync(runRoot))) throw new Error('run escapes consumer project');
  for (const name of ['run-summary.json', 'report.md', 'extent-report.html']) {
    if (fs.existsSync(path.join(runRoot, name))) throw new Error(`${name} already exists`);
  }
  if (fs.existsSync(path.join(runRoot, 'bugs', 'bug-list.md'))) throw new Error('bug-list.md already exists');
  const seenSessions = new Set(), seenWorkers = new Set();
  for (const assignment of assignments) {
    if (!assignment || !/^[a-z0-9._-]+$/.test(assignment.session || '') || assignment.session === 'default') throw new Error('invalid session assignment');
    if (seenSessions.has(assignment.session)) throw new Error(`duplicate session ownership: ${assignment.session}`);
    if (!assignment.workerId || seenWorkers.has(assignment.workerId)) throw new Error('duplicate or missing worker ID');
    seenSessions.add(assignment.session); seenWorkers.add(assignment.workerId);
    const sessionRoot = path.join(runRoot, 'browser-sessions', assignment.session);
    if (!inside(fs.realpathSync(runRoot), fs.realpathSync(sessionRoot))) throw new Error('session escapes run');
  }
  if (workerStates.length && (workerStates.length !== assignments.length ||
    new Set(workerStates.map(state => state.workerId)).size !== assignments.length)) {
    throw new Error('worker terminal states do not reconcile with assignments');
  }
  const statesByWorker = new Map(workerStates.map(state => [state.workerId, state]));
  if (workerStates.length && assignments.some(assignment => !statesByWorker.has(assignment.workerId))) {
    throw new Error('worker terminal state has unknown or missing worker ID');
  }
  const issuesBySession = new Map();
  for (const issue of cleanupIssues) {
    if (!seenSessions.has(issue.session) || issuesBySession.has(issue.session)) throw new Error('invalid cleanup issue ownership');
    issuesBySession.set(issue.session, issue.reason);
  }

  const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
  const testCases = [], defects = [], failures = [], workerResults = [];
  const sources = new Map(), destinations = new Map(), defectKeys = new Set();
  for (const assignment of assignments) {
    const result = inspectResult(cwd, runDir, assignment, statesByWorker.get(assignment.workerId), resultValidator);
    const sessionRoot = path.join(runRoot, 'browser-sessions', assignment.session);
    workerResults.push({ workerId: assignment.workerId, session: assignment.session, status: result.status,
      failures: result.failures, cleanup: result.cleanup });
    for (const scenario of result.scenarios) {
      const copy = structuredClone(scenario);
      copy.spec = assignment.spec;
      for (const shot of copy.screenshots || []) shot.path = evidencePath(runRoot, sessionRoot, shot.path).relative;
      for (const step of copy.steps) for (const item of step.evidence || []) {
        item.path = evidencePath(runRoot, sessionRoot, item.path).relative;
      }
      testCases.push(copy);
      counts[STATUS_KEY[copy.status]] = (counts[STATUS_KEY[copy.status]] || 0) + 1;
    }
    for (const defect of result.defects) {
      const copy = structuredClone(defect);
      const key = JSON.stringify([assignment.session, copy.title, copy.expected, copy.actual, copy.evidence]);
      if (defectKeys.has(key)) continue;
      defectKeys.add(key);
      copy.evidence = (copy.evidence || []).map(item => {
        const source = evidencePath(runRoot, sessionRoot, item).absolute;
        const destination = `${assignment.session}-${path.basename(source)}`;
        if (destinations.has(destination) && destinations.get(destination) !== source) throw new Error(`bug evidence collision: ${destination}`);
        destinations.set(destination, source);
        sources.set(source, destination);
        return `bugs/screenshots/${destination}`;
      });
      defects.push(copy);
    }
    for (const failure of result.failures) failures.push({ session: assignment.session, ...failure });
    if (result.cleanup && result.cleanup.attempted && !result.cleanup.closed && result.cleanup.error) {
      failures.push({ session: assignment.session, kind: 'infrastructure', detail: `session cleanup failed: ${result.cleanup.error}` });
    }
    const cleanupIssue = issuesBySession.get(assignment.session);
    if (cleanupIssue) {
      testCases.push({ name: `Cleanup verification: ${assignment.label}`, spec: assignment.spec,
        session: assignment.session, status: 'blocked', steps: [{ desc: 'Verify assigned browser session closed',
          status: 'blocked', note: cleanupIssue }] });
      counts.blocked++;
      failures.push({ session: assignment.session, kind: 'infrastructure', detail: cleanupIssue });
    }
  }
  if (workerResults.length !== assignments.length || testCases.length < assignments.length) throw new Error('terminal result count does not reconcile with assignments');
  counts.total = testCases.length;
  for (const destination of sources.values()) if (fs.existsSync(path.join(runRoot, 'bugs', 'screenshots', destination))) {
    throw new Error(`bug evidence already exists: ${destination}`);
  }
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  const date = startedAt.slice(0, 10);
  const title = `Parallel regression — ${date}`;
  const summary = { schemaVersion: 2, title, date, run: { startedAt, endedAt, durationMs, mode: 'parallel',
    ...(environment ? { environment } : {}), ...(targetUrl ? { targetUrl } : {}),
    ...(loginMode && loginMode !== 'none' ? { loginMode } : {}),
    sessions: assignments.map(a => ({ session: a.session, spec: a.spec, label: a.label })),
    ...(tools ? { tools } : {}) }, summary: counts, testCases, defects };
  const outcome = counts.blocked ? 'BLOCKED' : counts.failed ? 'FAILED' : counts.flaky ? 'FLAKY' : 'PASSED';
  const report = [`# ${title}`, '', `**Outcome:** ${outcome} — ${counts.passed} passed, ${counts.failed} failed, ${counts.blocked} blocked.`, '',
    `- Environment: ${md(environment || 'legacy')}`, `- Target: ${md(targetUrl || 'not recorded')}`, ''];
  for (const scenario of testCases) {
    report.push(`## Scenario: ${md(scenario.name)} — ${scenario.status.toUpperCase()}`, '', `- Spec: ${md(scenario.spec)}`, `- Session: ${md(scenario.session)}`);
    for (const step of scenario.steps) report.push(`- ${md(step.desc)}: ${step.status.toUpperCase()}${step.note ? ` — ${md(step.note)}` : ''}`);
    for (const shot of scenario.screenshots || []) report.push(`- Evidence: ${link(shot.path, shot.caption || path.basename(shot.path))}`);
    report.push('');
  }
  report.push('## Defects', '');
  if (!defects.length) report.push('No product defects recorded.', '');
  else for (const defect of defects) {
    report.push(`### ${md(defect.title)} (${defect.severity})`, '');
    if (defect.expected !== undefined) report.push(`- Expected: ${md(defect.expected)}`);
    if (defect.actual !== undefined) report.push(`- Actual: ${md(defect.actual)}`);
    for (const item of defect.evidence || []) report.push(`- Evidence: ${link(item, path.basename(item))}`);
    report.push('');
  }
  if (failures.length) {
    report.push('## Execution failures', '');
    for (const failure of failures) report.push(`- ${md(failure.session)} — ${failure.kind}: ${md(failure.detail)}`);
    report.push('');
  }
  report.push('**Interactive report:** [extent-report.html](./extent-report.html)',
    '**Run summary (JSON):** [run-summary.json](./run-summary.json)', '');
  const bugs = ['# Bug list', ''];
  if (!defects.length) bugs.push('No product defects recorded.', '');
  else for (const defect of defects) {
    bugs.push(`## ${md(defect.title)}`, '', `Severity: ${defect.severity}`);
    if (defect.scenario) bugs.push(`Scenario: ${md(defect.scenario)}`);
    if (defect.steps) defect.steps.forEach((step, i) => bugs.push(`${i + 1}. ${md(step)}`));
    if (defect.expected !== undefined) bugs.push(`Expected: ${md(defect.expected)}`);
    if (defect.actual !== undefined) bugs.push(`Actual: ${md(defect.actual)}`);
    for (const item of defect.evidence || []) bugs.push(`Evidence: ${link('../' + item, path.basename(item))}`);
    bugs.push('');
  }
  // Copy each validated source once, using the existing exclusive merge convention.
  const copied = mergeEvidence(runRoot, [...sources.keys()], { exclusive: true });
  if (copied.missing.length) throw new Error(`evidence disappeared: ${copied.missing.join(', ')}`);
  fs.writeFileSync(path.join(runRoot, 'run-summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(runRoot, 'report.md'), report.join('\n'), { flag: 'wx' });
  fs.writeFileSync(path.join(runRoot, 'bugs', 'bug-list.md'), bugs.join('\n'), { flag: 'wx' });
  if (renderHtml) {
    const renderer = path.resolve(__dirname, '..', '..', 'extent-report', 'scripts', 'make_html_report.js');
    const rendered = spawnSync(process.execPath, [renderer, path.join(runRoot, 'run-summary.json'), path.join(runRoot, 'extent-report.html')],
      { cwd, encoding: 'utf8', timeout: 120000, shell: false });
    if (rendered.status !== 0 || !fs.existsSync(path.join(runRoot, 'extent-report.html'))) throw new Error(`HTML renderer failed: ${(rendered.stderr || rendered.stdout || '').slice(0, 500)}`);
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(assignments.map(a => [a.workerId, a.session, a.spec]))).digest('hex');
  return { ok: true, status: outcome.toLowerCase(), runDir, scheduled: assignments.length,
    terminal: workerResults.length, summary: counts, defects: defects.length, workerResults, assignmentSha256: digest };
}

if (require.main === module) {
  try {
    const i = process.argv.indexOf('--manifest');
    if (i < 0 || !process.argv[i + 1]) throw new Error('usage: --manifest <run-manifest.json>');
    const file = path.resolve(process.argv[i + 1]);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(JSON.stringify(finalizeParallel({ ...manifest, cwd: process.cwd() })));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 2; }
}

module.exports = { finalizeParallel, inspectResult, blockedResult };
