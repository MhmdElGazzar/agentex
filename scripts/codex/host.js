'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { freezeAssignment, validateExecutionResult } = require('../lib/execution_result');
const { driversOfText } = require('../../skills/test-execution/scripts/spec_drivers');
const { isDeepStrictEqual } = require('node:util');
const { pending, validateUiDetails, validateResolution } = require('./ui_outcomes');
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
  const mode = input.mode || 'sequential';
  if (!['sequential', 'parallel'].includes(mode)) throw Error('invalid mode');
  if (mode === 'parallel' && (!Number.isInteger(input.hostCapacity) || input.hostCapacity < 1))
    throw Error('verified positive hostCapacity required');
  const concurrency = mode === 'parallel' ? Math.min(6, input.hostCapacity) : 1;
  fs.mkdirSync(path.join(projectRoot, 'executions'), { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(projectRoot, 'executions', 'codex-'));
  const sourceRoot = path.join(runRoot, 'sources');
  for (const sub of ['sources', 'assignments', 'results', 'validation', 'browser-sessions', 'worker-events']) fs.mkdirSync(path.join(runRoot, sub));
  const runId = path.basename(runRoot);
  const sessionId = mode === 'sequential' ? 'codex-' + id() : null;
  const assignments = [];
  for (const scenario of input.scenarios) {
    const assignmentId = id();
    const ownedSessionId = sessionId || 'codex-' + id();
    const sessionDir = path.join(runRoot, 'browser-sessions', ownedSessionId);
    fs.mkdirSync(path.join(sessionDir, 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'logs'), { recursive: true });
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
    const assignment = freezeAssignment({
      runId, attemptId: id(), assignmentId, sessionId: ownedSessionId,
      scope: { kind: sourceKind, value: sourceIdentity },
      source: { kind: sourceKind, path: sourcePath },
      requiredSteps: scenario.requiredSteps,
      cleanupRequired: true,
      policy: input.policy || { warningsFailGate: true, flakyFailsGate: false },
    }, { sourceRoot });
    writeNew(path.join(runRoot, 'assignments', assignmentId + '.json'), assignment);
    assignments.push({ assignmentId, sourceIdentity, sourceDigest: assignment.source.digest,
      assignmentDigest: assignment.assignmentDigest, attemptId: assignment.attemptId,
      sessionId: ownedSessionId, sessionDir,
      requiredSteps: assignment.requiredSteps, policy: assignment.policy, drivers: driversOfText(text),
      assignmentFile: path.join(runRoot, 'assignments', assignmentId + '.json'),
      resultFile: path.join(runRoot, 'results', assignmentId + '.json') });
  }
  const custody = { runId, mode, concurrency, sessionId, sourceRoot, runRoot, assignments };
  writeNew(path.join(runRoot, 'custody.json'), custody);
  return { ...custody, ...(mode === 'sequential' ? { sessionDir: assignments[0].sessionDir } : {}) };
}
function normalizeCustodyRecord(custody, record) {
  const mode = custody.mode === undefined ? 'sequential' : custody.mode;
  if (!['sequential', 'parallel'].includes(mode)) throw Error('invalid custody mode');
  const sessionId = record.sessionId === undefined && mode === 'sequential'
    ? custody.sessionId : record.sessionId;
  if (typeof sessionId !== 'string' || !sessionId ||
      (mode === 'sequential' && sessionId !== custody.sessionId) ||
      (mode === 'parallel' && custody.sessionId !== null)) throw Error('custody session mismatch');
  return { ...record, sessionId };
}
function inspect(runRootInput, assignmentId) {
  const runRoot = path.resolve(runRootInput);
  const custody = json(path.join(runRoot, 'custody.json'));
  if (custody.runRoot !== runRoot) throw Error('run root mismatch');
  const retained = custody.assignments.find(a => a.assignmentId === assignmentId);
  if (!retained) throw Error('unknown assignment');
  const record = normalizeCustodyRecord(custody, retained);
  const assignment = json(record.assignmentFile);
  if (assignment.assignmentDigest !== record.assignmentDigest ||
      assignment.source.digest !== record.sourceDigest ||
      assignment.scope.value !== record.sourceIdentity ||
      assignment.sessionId !== record.sessionId ||
      assignment.runId !== custody.runId || assignment.attemptId !== record.attemptId ||
      !isDeepStrictEqual(assignment.requiredSteps, record.requiredSteps) ||
      !isDeepStrictEqual(assignment.policy, record.policy)) throw Error('custody mismatch');
  let rawResult;
  try { rawResult = json(record.resultFile); } catch { /* validator rejects missing/malformed results */ }
  let result = rawResult;
  let validation = validateExecutionResult({ assignment, result, sourceRoot: custody.sourceRoot, runRoot });
  const uiProblems = validateUiDetails(result);
  if (uiProblems.length) {
    const otherProductFailure = validation.verdict === 'FAIL' && Array.isArray(result?.steps) &&
      result.steps.some(step => step.outcome === 'FAIL' && !pending(step) && step.uiCheck?.status !== 'VIEW MISMATCH ERROR');
    validation = { ...validation, ok: false,
      verdict: otherProductFailure ? 'FAIL' : 'BLOCKED', exitCode: otherProductFailure ? 1 : 2,
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
function main(args) {
  try {
    if (args[0] === 'prepare' && args.length === 2) return { output: prepare(json(args[1])), exitCode: 0 };
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
    return { output: { error: 'usage: prepare <input.json> | resolve <runRoot> <assignmentId> <input.json> | finalize <runRoot> <assignmentId> | report <runRoot> <metadata.json>' }, exitCode: 2 };
  } catch (e) { return { output: { verdict: 'BLOCKED', error: e.message }, exitCode: 2 }; }
}
module.exports = { prepare, inspect, resolve, finalize, main };
if (require.main === module) {
  const r = main(process.argv.slice(2));
  console.log(JSON.stringify(r.output));
  process.exitCode = r.exitCode;
}
