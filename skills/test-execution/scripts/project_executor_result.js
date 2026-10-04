'use strict';

// Project one validated executor transport record into the existing AgenTeX
// run-summary v2, Markdown report, and bug-evidence layout. Browser execution
// and HTML rendering remain separate steps.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validate, evidencePath } = require('./validate_executor_result.js');
const { mergeEvidence } = require('./merge_run.js');

const COUNT_KEYS = ['passed', 'failed', 'blocked', 'naDescoped', 'notRun'];
const STATUS_KEY = { passed: 'passed', failed: 'failed', blocked: 'blocked', na: 'naDescoped',
  notrun: 'notRun', warning: 'warnings', viewMismatch: 'viewMismatch', flaky: 'flaky' };

function insideOrSame(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--result', '--target-url', '--environment', '--login-mode', '--tools-file'].includes(key)
      || !argv[i + 1] || out[key]) throw new Error(`invalid or repeated argument: ${key}`);
    out[key] = argv[++i];
  }
  if (!out['--result']) throw new Error('usage: --result <sessionDir/executor-result.json> [--target-url URL] [--environment NAME] [--login-mode MODE] [--tools-file JSON]');
  return out;
}

function md(value) { return String(value ?? '').replace(/\r?\n/g, ' ').replace(/[\[\]<>]/g, ''); }
function link(relative, label) { return `[${md(label)}](./${relative})`; }

function project(resultFile, { cwd = process.cwd(), targetUrl, environment, loginMode, toolsFile } = {}) {
  const absoluteResult = path.resolve(cwd, resultFile);
  const raw = fs.readFileSync(absoluteResult, 'utf8');
  const result = JSON.parse(raw);
  const errors = validate(result, cwd);
  if (errors.length) throw new Error(`invalid executor result: ${errors.join('; ')}`);

  const runRoot = path.resolve(cwd, result.runDir);
  const sessionRoot = path.join(runRoot, 'browser-sessions', result.session);
  const expectedResult = path.join(sessionRoot, 'executor-result.json');
  if (absoluteResult !== expectedResult) throw new Error('result path does not match assigned session');
  const executionRoot = path.resolve(cwd, 'executions');
  if (!insideOrSame(fs.realpathSync(cwd), fs.realpathSync(executionRoot))
    || !insideOrSame(fs.realpathSync(executionRoot), fs.realpathSync(runRoot))
    || !insideOrSame(fs.realpathSync(runRoot), fs.realpathSync(sessionRoot))
    || !insideOrSame(fs.realpathSync(sessionRoot), fs.realpathSync(absoluteResult))) {
    throw new Error('run or session directory escapes the consumer project');
  }

  const marker = path.join(sessionRoot, 'session-projection.json');
  if (fs.existsSync(marker)) throw new Error('this executor result was already projected');
  for (const name of ['run-summary.json', 'report.md']) {
    if (fs.existsSync(path.join(runRoot, name))) throw new Error(`${name} already exists; refusing to overwrite run artifacts`);
  }
  if (fs.existsSync(path.join(runRoot, 'bugs', 'bug-list.md'))) throw new Error('bug-list.md already exists; refusing to overwrite run artifacts');
  for (const name of fs.readdirSync(path.join(runRoot, 'browser-sessions'))) {
    if (name !== result.session && fs.existsSync(path.join(runRoot, 'browser-sessions', name, 'session-projection.json'))) {
      throw new Error('another session is already projected in this run');
    }
  }

  const date = result.startedAt.slice(0, 10);
  const specLabel = path.basename(result.spec.replace(/\\/g, '/')).replace(/\.md$/i, '') || 'Browser test';
  const title = `${specLabel} — ${date}`;
  const scenarios = structuredClone(result.scenarios);
  for (const scenario of scenarios) {
    for (const shot of scenario.screenshots || []) shot.path = evidencePath(runRoot, sessionRoot, shot.path).relative;
    for (const step of scenario.steps) for (const item of step.evidence || []) {
      item.path = evidencePath(runRoot, sessionRoot, item.path).relative;
    }
  }

  const defects = structuredClone(result.defects);
  const sourcePaths = [];
  const destinations = new Map();
  for (const defect of defects) for (const item of defect.evidence || []) {
    const source = evidencePath(runRoot, sessionRoot, item);
    const destination = `${result.session}-${path.basename(source.absolute)}`;
    if (destinations.has(destination)) {
      if (destinations.get(destination) !== source.absolute) throw new Error(`defect evidence filename collision: ${destination}`);
      continue;
    }
    destinations.set(destination, source.absolute);
    if (fs.existsSync(path.join(runRoot, 'bugs', 'screenshots', destination))) throw new Error(`bug evidence already exists: ${destination}`);
    sourcePaths.push(source.absolute);
  }
  let tools;
  if (toolsFile) {
    const toolsPath = path.resolve(cwd, toolsFile);
    if (!insideOrSame(fs.realpathSync(sessionRoot), fs.realpathSync(toolsPath))) throw new Error('tools file must be in assigned session');
    tools = JSON.parse(fs.readFileSync(toolsPath, 'utf8'));
    if (!tools || typeof tools !== 'object' || Array.isArray(tools)) throw new Error('tools file must contain an object');
  }

  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
  for (const scenario of scenarios) {
    const key = STATUS_KEY[scenario.status];
    counts[key] = (counts[key] || 0) + 1;
  }
  counts.total = scenarios.length;
  const summary = {
    schemaVersion: 2, title, date,
    run: {
      startedAt: result.startedAt, endedAt: result.endedAt, durationMs: result.durationMs,
      mode: 'sequential',
      ...(environment ? { environment } : {}),
      ...(targetUrl ? { targetUrl } : {}),
      ...(loginMode && loginMode !== 'none' ? { loginMode } : {}),
      sessions: [{ session: result.session, spec: result.spec, label: specLabel }],
      ...(tools ? { tools } : {}),
    },
    summary: counts, testCases: scenarios, defects,
  };

  // Existing merge_run copy convention, after strict validation and collision
  // checks. Exclusive copies prevent replacing any prior bug screenshot.
  const copied = mergeEvidence(runRoot, sourcePaths, { exclusive: true });
  if (copied.missing.length) throw new Error(`validated evidence disappeared: ${copied.missing.join(', ')}`);
  const copiedBySource = new Map(sourcePaths.map((source, index) =>
    [source, path.relative(runRoot, copied.copied[index]).replace(/\\/g, '/')]));
  for (const defect of defects) defect.evidence = (defect.evidence || []).map((item) =>
    copiedBySource.get(evidencePath(runRoot, sessionRoot, item).absolute));

  const report = [`# ${title}`, '', `**Outcome:** ${result.status.toUpperCase()} — ${counts.passed} passed, ${counts.failed} failed, ${counts.blocked} blocked.`, '',
    `- Environment: ${md(environment || 'legacy')}`, `- Target: ${md(targetUrl || 'not recorded')}`,
    `- Session: ${md(result.session)} (${result.cleanup.closed ? 'closed' : 'cleanup failed'})`, ''];
  for (const scenario of scenarios) {
    report.push(`## Scenario: ${md(scenario.name)} — ${scenario.status.toUpperCase()}`, '');
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
  if (result.failures.length) {
    report.push('## Execution failures', '');
    for (const failure of result.failures) report.push(`- ${failure.kind}: ${md(failure.detail)}`);
    report.push('');
  }
  report.push('**Interactive report:** [extent-report.html](./extent-report.html)',
    '**Run summary (JSON):** [run-summary.json](./run-summary.json)', '');
  const bugList = ['# Bug list', ''];
  if (!defects.length) bugList.push('No product defects recorded.', '');
  else for (const defect of defects) {
    bugList.push(`## ${md(defect.title)}`, '', `Severity: ${defect.severity}`);
    if (defect.scenario) bugList.push(`Scenario: ${md(defect.scenario)}`);
    if (defect.steps) defect.steps.forEach((step, index) => bugList.push(`${index + 1}. ${md(step)}`));
    if (defect.expected !== undefined) bugList.push(`Expected: ${md(defect.expected)}`);
    if (defect.actual !== undefined) bugList.push(`Actual: ${md(defect.actual)}`);
    for (const item of defect.evidence || []) bugList.push(`Evidence: ${link('../' + item, path.basename(item))}`);
    bugList.push('');
  }

  fs.writeFileSync(path.join(runRoot, 'run-summary.json'), JSON.stringify(summary, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(path.join(runRoot, 'report.md'), report.join('\n'), { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(path.join(runRoot, 'bugs', 'bug-list.md'), bugList.join('\n'), { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, resultSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    summary: 'run-summary.json', report: 'report.md' }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return { ok: true, status: result.status, runDir: result.runDir, session: result.session,
    scenarios: scenarios.length, defects: defects.length, summary: path.join(result.runDir, 'run-summary.json'),
    report: path.join(result.runDir, 'report.md'), bugs: path.join(result.runDir, 'bugs', 'bug-list.md') };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(project(args['--result'], { targetUrl: args['--target-url'], environment: args['--environment'],
      loginMode: args['--login-mode'], toolsFile: args['--tools-file'] })));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 2;
  }
}

module.exports = { project, parseArgs };
