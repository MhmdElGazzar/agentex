'use strict';

// Provider-neutral bridge from one exact coordinator handoff to the offline
// release gate. This module never starts execution or finalizes a run.
const fs = require('node:fs');
const path = require('node:path');
const { runGate } = require('../../test-execution/scripts/evaluate_release_gate.js');

const RUN_DIR = /^executions\/execu_[A-Za-z0-9._-]+$/;
const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const samePath = (a, b) => process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase() : a === b;

class HandoffError extends Error {
  constructor(code, category = 'infrastructure') {
    super(code);
    this.code = code;
    this.category = category;
  }
}

function review(code, category = 'infrastructure') {
  return { schemaVersion: 1, decision: 'REVIEW', exitCode: 2,
    reasons: [{ code, category }],
    approval: { requiresHumanReview: true, releaseBlocked: true } };
}

function readJsonFile(file, missingCode, invalidCode) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { throw new HandoffError(missingCode); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new HandoffError(invalidCode, 'integrity');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new HandoffError(invalidCode, 'integrity'); }
}

function resolveHandoffFile(cwd, supplied) {
  if (typeof supplied !== 'string' || !supplied.trim()) throw new HandoffError('handoff-path-invalid', 'integrity');
  const file = path.resolve(cwd, supplied);
  if (!path.isAbsolute(supplied) && !inside(cwd, file)) throw new HandoffError('handoff-path-escape', 'integrity');
  if (!fs.existsSync(file)) throw new HandoffError('handoff-missing');
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new HandoffError('handoff-symlink', 'integrity');
    if (!stat.isFile()) throw new HandoffError('handoff-path-invalid', 'integrity');
    if (!samePath(fs.realpathSync(file), file)) throw new HandoffError('handoff-symlink', 'integrity');
  } catch (error) {
    if (error instanceof HandoffError) throw error;
    throw new HandoffError('handoff-path-invalid', 'integrity');
  }
  return file;
}

function resolveOwnedRun(cwd, handoff, expectedInvocationId) {
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff) || handoff.schemaVersion !== 1) {
    throw new HandoffError('handoff-schema-unsupported', 'integrity');
  }
  if (typeof handoff.runId !== 'string' || typeof handoff.runDir !== 'string' ||
    typeof handoff.invocationId !== 'string') throw new HandoffError('handoff-identity-invalid', 'integrity');
  if (handoff.invocationId !== expectedInvocationId) throw new HandoffError('invocation-mismatch', 'integrity');
  const runDir = handoff.runDir.replace(/\\/g, '/');
  if (path.posix.isAbsolute(runDir) || path.win32.isAbsolute(handoff.runDir) || !RUN_DIR.test(runDir)) {
    throw new HandoffError('run-path-invalid', 'integrity');
  }
  if (path.posix.basename(runDir) !== handoff.runId) throw new HandoffError('run-id-mismatch', 'integrity');
  const executions = path.join(cwd, 'executions');
  const runRoot = path.resolve(cwd, ...runDir.split('/'));
  let realExecutions, realRun;
  try {
    if (fs.lstatSync(executions).isSymbolicLink() || fs.lstatSync(runRoot).isSymbolicLink()) {
      throw new HandoffError('run-path-escape', 'integrity');
    }
    realExecutions = fs.realpathSync(executions);
    realRun = fs.realpathSync(runRoot);
  } catch (error) {
    if (error instanceof HandoffError) throw error;
    throw new HandoffError('run-missing');
  }
  if (!inside(cwd, realExecutions) || !samePath(path.dirname(realRun), realExecutions) ||
    !samePath(realRun, runRoot) || !fs.statSync(realRun).isDirectory()) {
    throw new HandoffError('run-path-escape', 'integrity');
  }
  const owner = readJsonFile(path.join(realRun, 'coordinator-owner.json'), 'owner-missing', 'owner-invalid');
  if (!owner || owner.schemaVersion !== 1 || owner.runId !== handoff.runId ||
    owner.invocationId !== expectedInvocationId || !Number.isInteger(owner.pid) ||
    typeof owner.startedAt !== 'string' || Number.isNaN(Date.parse(owner.startedAt))) {
    throw new HandoffError('owner-mismatch', 'integrity');
  }
  return { runDir, runRoot: realRun };
}

function verifyFinalized(runDir, runRoot) {
  for (const relative of ['run-summary.json', 'report.md', 'extent-report.html',
    'bugs/bug-list.md', 'parallel-manifest.json', 'parallel-timing.json']) {
    const file = path.join(runRoot, relative);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    } catch { throw new HandoffError('run-not-finalized'); }
  }
  const manifest = readJsonFile(path.join(runRoot, 'parallel-manifest.json'), 'run-not-finalized', 'run-not-finalized');
  const timing = readJsonFile(path.join(runRoot, 'parallel-timing.json'), 'run-not-finalized', 'run-not-finalized');
  const assigned = Array.isArray(manifest?.assignments) ? manifest.assignments.map(item => item?.workerId) : [];
  const terminal = Array.isArray(manifest?.workerStates) ? manifest.workerStates.map(item => item?.workerId) : [];
  const timed = Array.isArray(timing?.workerStates) ? timing.workerStates.map(item => item?.workerId) : [];
  if (typeof manifest?.runDir !== 'string' || manifest.runDir.replace(/\\/g, '/') !== runDir || !assigned.length ||
    assigned.some(id => typeof id !== 'string') || new Set(assigned).size !== assigned.length ||
    terminal.length !== assigned.length || timed.length !== assigned.length ||
    terminal.some(id => !assigned.includes(id)) || timed.some(id => !assigned.includes(id))) {
    throw new HandoffError('run-not-finalized');
  }
  return path.join(runRoot, 'run-summary.json');
}

function evaluateHandoffRun({ cwd = process.cwd(), handoff, invocationId, flakyPolicy = 'review' } = {}) {
  try {
    if (typeof invocationId !== 'string' || !INVOCATION_ID.test(invocationId)) {
      throw new HandoffError('invocation-id-required', 'integrity');
    }
    if (!['review', 'fail', 'allow'].includes(flakyPolicy)) throw new HandoffError('flaky-policy-invalid', 'integrity');
    const root = fs.realpathSync(cwd);
    const handoffFile = resolveHandoffFile(root, handoff);
    const identity = readJsonFile(handoffFile, 'handoff-missing', 'handoff-malformed');
    const { runDir, runRoot } = resolveOwnedRun(root, identity, invocationId);
    return runGate(verifyFinalized(runDir, runRoot), flakyPolicy);
  } catch (error) {
    if (error instanceof HandoffError) return review(error.code, error.category);
    return review(error.code === 'EEXIST' ? 'gate-result-exists' : 'gate-invocation-invalid', 'integrity');
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--handoff', '--invocation-id', '--flaky-policy'].includes(key) || !value || out[key]) {
      throw new HandoffError('handoff-invocation-invalid', 'integrity');
    }
    out[key] = value;
  }
  if (!out['--handoff'] || !out['--invocation-id']) throw new HandoffError('handoff-invocation-invalid', 'integrity');
  return { handoff: out['--handoff'], invocationId: out['--invocation-id'],
    flakyPolicy: out['--flaky-policy'] || 'review' };
}

if (require.main === module) {
  let result;
  try { result = evaluateHandoffRun(parseArgs(process.argv.slice(2))); }
  catch { result = review('handoff-invocation-invalid', 'integrity'); }
  console.log(JSON.stringify(result));
  process.exitCode = result.exitCode;
}

module.exports = { parseArgs, resolveHandoffFile, resolveOwnedRun, verifyFinalized, evaluateHandoffRun };
