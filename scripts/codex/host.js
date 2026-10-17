'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { freezeAssignment, validateExecutionResult } = require('../lib/execution_result');
const { driversOfText } = require('../../skills/test-execution/scripts/spec_drivers');
const { isDeepStrictEqual } = require('node:util');
const { pending, validateUiDetails, validateResolution } = require('./ui_outcomes');
const browserMode = require('./browser_mode');
const id = () => crypto.randomUUID();
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeNew = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function inside(root, file) {
  const rel = path.relative(root, file);
  return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function prepare(input) {
  const projectRoot = path.resolve(input.projectRoot);
  if (!path.isAbsolute(input.projectRoot) || !fs.statSync(projectRoot).isDirectory()) throw Error('absolute projectRoot required');
  if (!Array.isArray(input.scenarios) || !input.scenarios.length) throw Error('scenarios required');
  if (input.browserMode !== undefined && !['HEADLESS', 'HEADED'].includes(input.browserMode)) throw Error('invalid browser mode');
  fs.mkdirSync(path.join(projectRoot, 'executions'), { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(projectRoot, 'executions', 'codex-'));
  const sourceRoot = path.join(runRoot, 'sources');
  for (const sub of ['sources', 'assignments', 'results', 'validation', 'browser-sessions']) fs.mkdirSync(path.join(runRoot, sub));
  const runId = path.basename(runRoot);
  const sessionId = 'codex-' + id();
  const sessionDir = path.join(runRoot, 'browser-sessions', sessionId);
  fs.mkdirSync(path.join(sessionDir, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, 'logs'), { recursive: true });
  const assignments = [];
  for (const scenario of input.scenarios) {
    const assignmentId = id();
    let text, sourceKind, sourceIdentity;
    if (typeof scenario.spec === 'string') {
      const spec = path.resolve(projectRoot, scenario.spec);
      if (!inside(projectRoot, spec) || !inside(fs.realpathSync(projectRoot), fs.realpathSync(spec)) ||
          !fs.statSync(spec).isFile()) throw Error('spec must be a project file');
      text = fs.readFileSync(spec, 'utf8');
      sourceKind = 'saved-spec';
      sourceIdentity = path.relative(projectRoot, spec).split(path.sep).join('/');
    } else if (typeof scenario.adHoc === 'string' && scenario.adHoc.trim()) {
      text = scenario.adHoc;
      sourceKind = 'ad-hoc';
      sourceIdentity = 'ad-hoc:' + assignmentId;
    } else throw Error('spec or adHoc required');
    const sourcePath = assignmentId + '.md';
    fs.writeFileSync(path.join(sourceRoot, sourcePath), text, { flag: 'wx' });
    const drivers = driversOfText(text);
    const assignment = freezeAssignment({
      runId, attemptId: id(), assignmentId, sessionId,
      scope: { kind: sourceKind, value: sourceIdentity },
      source: { kind: sourceKind, path: sourcePath },
      requiredSteps: scenario.requiredSteps,
      cleanupRequired: true,
      policy: input.policy || { warningsFailGate: true, flakyFailsGate: false },
      ...(drivers.includes('browser') ? { browserMode: input.browserMode || 'HEADLESS', browserEvidenceVersion: 2 } : {}),
    }, { sourceRoot });
    writeNew(path.join(runRoot, 'assignments', assignmentId + '.json'), assignment);
    assignments.push({ assignmentId, sourceIdentity, sourceDigest: assignment.source.digest,
      assignmentDigest: assignment.assignmentDigest, attemptId: assignment.attemptId,
      sessionId, sessionDir,
      requiredSteps: assignment.requiredSteps, policy: assignment.policy, drivers,
      ...(assignment.browserMode !== undefined ? { browserMode: assignment.browserMode } : {}),
      ...(assignment.browserEvidenceVersion !== undefined ? { browserEvidenceVersion: assignment.browserEvidenceVersion } : {}),
      assignmentFile: path.join(runRoot, 'assignments', assignmentId + '.json'),
      resultFile: path.join(runRoot, 'results', assignmentId + '.json') });
  }
  const custody = { runId, sessionId, sourceRoot, runRoot, assignments };
  writeNew(path.join(runRoot, 'custody.json'), custody);
  return { ...custody, sessionDir };
}
function inspect(runRootInput, assignmentId) {
  const runRoot = path.resolve(runRootInput);
  const custody = json(path.join(runRoot, 'custody.json'));
  if (custody.runRoot !== runRoot) throw Error('run root mismatch');
  const record = custody.assignments.find(a => a.assignmentId === assignmentId);
  if (!record) throw Error('unknown assignment');
  const assignment = json(record.assignmentFile);
  if (assignment.assignmentDigest !== record.assignmentDigest ||
      assignment.source.digest !== record.sourceDigest ||
      assignment.scope.value !== record.sourceIdentity ||
      assignment.sessionId !== custody.sessionId ||
      assignment.runId !== custody.runId || assignment.attemptId !== record.attemptId ||
      !isDeepStrictEqual(assignment.requiredSteps, record.requiredSteps) ||
      !isDeepStrictEqual(assignment.policy, record.policy) ||
      assignment.browserMode !== record.browserMode ||
      assignment.browserEvidenceVersion !== record.browserEvidenceVersion) throw Error('custody mismatch');
  let rawResult;
  try { rawResult = json(record.resultFile); } catch { /* validator rejects missing/malformed results */ }
  let result = rawResult;
  let validation = validateExecutionResult({ assignment, result, sourceRoot: custody.sourceRoot, runRoot });
  const uiProblems = validateUiDetails(result);
  if (uiProblems.length) {
    const otherProductFailure = validation.verdict === 'FAIL' && Array.isArray(result?.steps) &&
      result.steps.some(step => step.outcome === 'FAIL' && !pending(step) && step.uiCheck?.status !== 'VIEW MISMATCH ERROR');
    validation = { ...validation, ok: false,
    verdict: otherProductFailure ? 'FAIL' : 'BLOCKED',
    exitCode: otherProductFailure ? 1 : 2,
    errors: [...validation.errors, ...uiProblems.map(code => ({ code }))] };
  }
  let deferred = [];
  const resolutionFile = path.join(runRoot, 'resolutions', assignmentId + '.json');
  if (fs.existsSync(resolutionFile)) {
    if (!validation.ok) throw Error('untrusted UI result cannot be resolved');
    const resolution = json(resolutionFile);
    if (resolution.assignmentDigest !== assignment.assignmentDigest ||
        resolution.attemptId !== assignment.attemptId ||
        resolution.rawResultSha256 !== crypto.createHash('sha256').update(fs.readFileSync(record.resultFile)).digest('hex'))
      throw Error('stale UI resolution');
    deferred = validateResolution(rawResult, resolution);
    result = resolution.finalResult;
    validation = validateExecutionResult({ assignment, result, sourceRoot: custody.sourceRoot, runRoot });
    if (!validation.ok) throw Error('invalid resolved UI result');
  }
  if (record.drivers.includes('browser') && assignment.browserEvidenceVersion === 2) {
    const owners = custody.assignments.filter(a => a.sessionId === record.sessionId).map(a => a.assignmentId);
    const reason = browserMode.audit(record.sessionDir, record.sessionId, assignment.browserMode,
      record.assignmentId, { runId: custody.runId, closeOwners: owners });
    if (reason) {
      validation = { ...validation, ok: false, verdict: 'BLOCKED', exitCode: 2,
        errors: [...validation.errors, { code: 'browser-mode-unverified', reason }] };
    }
  }
  return { assignment, result, validation, record, custody, deferred };
}
function resolve(runRootInput, assignmentId, input) {
  const runRoot = path.resolve(runRootInput);
  const validationFile = path.join(runRoot, 'validation', assignmentId + '.json');
  const resolutionFile = path.join(runRoot, 'resolutions', assignmentId + '.json');
  if (fs.existsSync(validationFile) || fs.existsSync(resolutionFile)) throw Error('assignment already finalized or resolved');
  const checked = inspect(runRoot, assignmentId);
  if (!checked.validation.ok || !checked.result?.steps?.some(pending)) throw Error('valid pending UI result required');
  const record = { assignmentDigest: checked.assignment.assignmentDigest,
    attemptId: checked.assignment.attemptId,
    rawResultSha256: crypto.createHash('sha256').update(fs.readFileSync(checked.record.resultFile)).digest('hex'),
    answers: input?.answers, finalResult: input?.finalResult };
  validateResolution(checked.result, record);
  const validation = validateExecutionResult({ assignment: checked.assignment, result: record.finalResult,
    sourceRoot: checked.custody.sourceRoot, runRoot });
  if (!validation.ok) throw Error('invalid resolved UI result');
  fs.mkdirSync(path.dirname(resolutionFile), { recursive: true });
  writeNew(resolutionFile, record);
  return validation;
}
function finalize(runRootInput, assignmentId) {
  const runRoot = path.resolve(runRootInput);
  const { validation } = inspect(runRoot, assignmentId);
  writeNew(path.join(runRoot, 'validation', assignmentId + '.json'), validation);
  return validation;
}
function browserContext(runRootInput, assignmentId, forAction = false) {
  const runRoot = path.resolve(runRootInput);
  const custody = json(path.join(runRoot, 'custody.json'));
  if (custody.runRoot !== runRoot) throw Error('run root mismatch');
  const retained = custody.assignments.find(a => a.assignmentId === assignmentId);
  if (!retained || !retained.drivers.includes('browser')) throw Error('browser assignment required');
  const record = retained;
  if (record.sessionDir !== path.join(runRoot, 'browser-sessions', record.sessionId))
    throw Error('custody session directory mismatch');
  const assignment = json(record.assignmentFile);
  if (assignment.assignmentDigest !== record.assignmentDigest || assignment.sessionId !== record.sessionId ||
      assignment.browserMode !== record.browserMode ||
      assignment.browserEvidenceVersion !== record.browserEvidenceVersion) throw Error('custody mismatch');
  return { projectRoot: path.dirname(path.dirname(runRoot)), runId: custody.runId,
    assignmentId: record.assignmentId, sessionDir: record.sessionDir,
    sessionId: record.sessionId, requestedMode: assignment.browserMode || 'HEADLESS' };
}
function main(args) {
  try {
    if (args[0] === 'prepare' && args.length === 2) return { output: prepare(json(args[1])), exitCode: 0 };
    if (args[0] === 'preflight' && args.length === 3) {
      const output = browserMode.preflight(browserContext(args[1], args[2]));
      return { output, exitCode: output.verified ? 0 : 2 };
    }
    if (args[0] === 'browser' && args.length >= 4) return { output: browserMode.command(browserContext(args[1], args[2], true), args.slice(3)), exitCode: 0 };
    if (args[0] === 'browser-close' && args.length === 3) return { output: browserMode.close(browserContext(args[1], args[2], true)), exitCode: 0 };
    if (args[0] === 'finalize' && args.length === 3) {
      const output = finalize(args[1], args[2]); return { output, exitCode: output.exitCode };
    }
    if (args[0] === 'resolve' && args.length === 4) {
      const output = resolve(args[1], args[2], json(args[3]));
      return { output, exitCode: output.exitCode };
    }
    if (args[0] === 'report' && args.length === 3) {
      const output = require('./report').report(args[1], json(args[2]));
      return { output, exitCode: output.exitCode };
    }
    return { output: { error: 'usage: prepare <input.json> | preflight <runRoot> <assignmentId> | browser <runRoot> <assignmentId> <command> [args...] | browser-close <runRoot> <assignmentId> | resolve <runRoot> <assignmentId> <input.json> | finalize <runRoot> <assignmentId> | report <runRoot> <metadata.json>' }, exitCode: 2 };
  } catch (e) { return { output: { verdict: 'BLOCKED', error: e.message }, exitCode: 2 }; }
}
module.exports = { prepare, inspect, resolve, finalize, main };
if (require.main === module) {
  const r = main(process.argv.slice(2));
  console.log(JSON.stringify(r.output));
  process.exitCode = r.exitCode;
}
