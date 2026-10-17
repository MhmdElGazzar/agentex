'use strict';
// Host-neutral result ingestion. The caller owns the assignment and freezes it before
// dispatch; the executor supplies only `result`. No prose or host-specific parsing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const SCHEMA_VERSION = 1;
const OUTCOMES = new Set(['PASS', 'FAIL', 'BLOCKED', 'NOT_ATTEMPTED', 'WARNING', 'FLAKY']);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const digestOk = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nameOk = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
const segmentOk = value => nameOk(value) && !['.', '..'].includes(value) && !/[\\/:]/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => isDeepStrictEqual(a, b);
const error = code => ({ code }); // Never echo untrusted content or file data.
const ASSIGNMENT_KEYS = ['schemaVersion', 'runId', 'attemptId', 'assignmentId', 'sessionId',
  'scope', 'source', 'requiredSteps', 'cleanupRequired', 'policy', 'browserMode', 'browserEvidenceVersion'];

// Canonical v1 digest: sorted JSON object keys at every depth, array order kept.
// This is drift detection, not authentication; the host must retain the original
// assignment independently of the executor.
function canonical(value) {
  if (Array.isArray(value)) {
    const parts = value.map(canonical);
    return parts.includes(null) ? null : `[${parts.join(',')}]`;
  }
  if (object(value)) {
    const parts = Object.keys(value).sort().map(key => {
      const part = canonical(value[key]);
      return part === null ? null : `${JSON.stringify(key)}:${part}`;
    });
    return parts.includes(null) ? null : `{${parts.join(',')}}`;
  }
  return value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ? JSON.stringify(value) : null;
}

function assignmentHash(assignment) {
  if (!object(assignment)) return null;
  const bare = { ...assignment };
  delete bare.assignmentDigest;
  const encoded = canonical(bare);
  return encoded === null ? null : sha256(encoded);
}

function contained(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) ||
      path.win32.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(x => !x || x === '.' || x === '..')) return null;
  const full = path.resolve(root, ...relative.split('/'));
  const rel = path.relative(root, full);
  return rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel) ? full : null;
}

function existingContained(root, relative) {
  const candidate = contained(root, relative);
  if (!candidate) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(candidate);
    const rel = path.relative(realRoot, realFile);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
    return fs.statSync(realFile).isFile() ? realFile : null;
  } catch { return null; }
}

function readSourceDigest(sourceRoot, source) {
  if (!source || !['saved-spec', 'ad-hoc'].includes(source.kind)) return null;
  const file = existingContained(sourceRoot, source.path);
  if (!file) return null;
  try { return sha256(fs.readFileSync(file)); }
  catch { return null; }
}

function validateAssignment(a, sourceRoot, { requireDigest = true } = {}) {
  const problems = [];
  if (!object(a) || Object.keys(a).some(key => !ASSIGNMENT_KEYS.includes(key) && key !== 'assignmentDigest')) problems.push(error('assignment-shape'));
  if (!a || a.schemaVersion !== SCHEMA_VERSION) problems.push(error('schema-version'));
  if (!a || !['runId', 'attemptId', 'assignmentId', 'sessionId'].every(k => nameOk(a[k]))) problems.push(error('assignment-identity'));
  if (a && !segmentOk(a.sessionId)) problems.push(error('session-identity'));
  if (a && a.browserMode !== undefined && !['HEADLESS', 'HEADED'].includes(a.browserMode)) problems.push(error('browser-mode'));
  if (a && a.browserEvidenceVersion !== undefined && a.browserEvidenceVersion !== 2) problems.push(error('browser-evidence-version'));
  if (!a || !object(a.scope) || !nameOk(a.scope.kind) || !nameOk(a.scope.value)) problems.push(error('execution-scope'));
  if (!a || !object(a.source) || !digestOk(a.source.digest) || !nameOk(a.source.path)) problems.push(error('source-identity'));
  else if (readSourceDigest(sourceRoot, a.source) !== a.source.digest) problems.push(error('source-digest'));
  if (!a || !Array.isArray(a.requiredSteps) || a.requiredSteps.length === 0) problems.push(error('empty-required-steps'));
  else {
    const seen = new Set();
    for (const step of a.requiredSteps) {
      if (!object(step) || !nameOk(step.id) || seen.has(step.id) || !Array.isArray(step.assertionIds) ||
          step.assertionIds.length === 0 || new Set(step.assertionIds).size !== step.assertionIds.length ||
          step.assertionIds.some(id => !nameOk(id)) || typeof step.evidenceRequired !== 'boolean') problems.push(error('required-step-definition'));
      if (object(step) && nameOk(step.id)) seen.add(step.id);
    }
  }
  if (!a || typeof a.cleanupRequired !== 'boolean' || !object(a.policy) ||
      typeof a.policy.warningsFailGate !== 'boolean' || typeof a.policy.flakyFailsGate !== 'boolean') problems.push(error('assignment-policy'));
  if (requireDigest && (!digestOk(a?.assignmentDigest) || assignmentHash(a) !== a.assignmentDigest)) problems.push(error('assignment-digest'));
  return problems;
}

// Use this before dispatch. Persist the returned value outside executor control; a
// later result cannot replace its requiredSteps, source digest, or policy.
function freezeAssignment(input, { sourceRoot }) {
  if (!nameOk(sourceRoot) || !path.isAbsolute(sourceRoot)) throw new Error('absolute sourceRoot is required');
  const sourceDigest = readSourceDigest(sourceRoot, input && input.source);
  if (!sourceDigest) throw new Error('source must be a retained file under sourceRoot');
  const assignment = JSON.parse(JSON.stringify({ ...input, schemaVersion: SCHEMA_VERSION,
    source: { ...input.source, digest: sourceDigest } }));
  delete assignment.assignmentDigest;
  const problems = validateAssignment(assignment, sourceRoot, { requireDigest: false });
  if (problems.length) throw new Error(`invalid assignment: ${problems.map(p => p.code).join(', ')}`);
  assignment.assignmentDigest = assignmentHash(assignment);
  for (const s of assignment.requiredSteps) { Object.freeze(s.assertionIds); Object.freeze(s); }
  Object.freeze(assignment.requiredSteps);
  Object.freeze(assignment.source);
  Object.freeze(assignment.scope);
  Object.freeze(assignment.policy);
  return Object.freeze(assignment);
}

function validateExecutionResult(input) {
  if (!object(input))
    return { ok: false, verdict: 'BLOCKED', exitCode: 2, coverage: { required: 0, recorded: 0 }, errors: [error('roots-required')] };
  const { assignment, result, sourceRoot, runRoot } = input;
  if (!nameOk(sourceRoot) || !nameOk(runRoot) || !path.isAbsolute(sourceRoot) || !path.isAbsolute(runRoot))
    return { ok: false, verdict: 'BLOCKED', exitCode: 2, coverage: { required: 0, recorded: 0 }, errors: [error('roots-required')] };
  const errors = validateAssignment(assignment, sourceRoot);
  if (!object(result)) errors.push(error('result-shape'));
  if (!result || result.schemaVersion !== SCHEMA_VERSION) errors.push(error('result-schema-version'));
  if (!result || !nameOk(result.runId) || result.runId !== assignment?.runId) errors.push(error('run-identity'));
  if (!result || !nameOk(result.attemptId) || result.attemptId !== assignment?.attemptId) errors.push(error('attempt-identity'));
  if (!result || !nameOk(result.assignmentId) || result.assignmentId !== assignment?.assignmentId) errors.push(error('assignment-identity'));
  if (!result || result.assignmentDigest !== assignment?.assignmentDigest) errors.push(error('assignment-digest'));
  if (!result || result.sourceDigest !== assignment?.source?.digest) errors.push(error('source-digest'));
  if (!result || !same(result.scope, assignment?.scope)) errors.push(error('execution-scope'));
  if (!result || result.sessionId !== assignment?.sessionId) errors.push(error('session-identity'));
  const globalTrust = errors.length === 0;
  const expected = new Map(Array.isArray(assignment?.requiredSteps)
    ? assignment.requiredSteps.filter(object).filter(s => nameOk(s.id)).map(s => [s.id, s]) : []);
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  if (!Array.isArray(result?.steps)) errors.push(error('step-results-required'));
  const seen = new Set();
  const duplicates = new Set();
  const validatedFailures = new Set();
  let blocked = false;
  let warning = false;
  let flaky = false;
  let canonicalSession = null;
  if (segmentOk(assignment?.sessionId)) {
    try {
      const realRun = fs.realpathSync(runRoot);
      const expectedSession = path.join(realRun, 'browser-sessions', assignment.sessionId);
      const realSession = fs.realpathSync(path.join(runRoot, 'browser-sessions', assignment.sessionId));
      if (path.relative(expectedSession, realSession) === '') canonicalSession = realSession;
    } catch { /* evidence checks below reject an unavailable session */ }
  }
  for (const step of steps) {
    if (!object(step) || !expected.has(step.stepId)) { errors.push(error('unknown-step')); continue; }
    if (seen.has(step.stepId)) { errors.push(error('duplicate-step')); duplicates.add(step.stepId); }
    seen.add(step.stepId);
    const ownerOk = step.runId === assignment?.runId && step.attemptId === assignment?.attemptId &&
      step.assignmentId === assignment?.assignmentId && step.sessionId === assignment?.sessionId;
    if (!ownerOk) errors.push(error('step-ownership'));
    const outcomeOk = OUTCOMES.has(step.outcome);
    if (!outcomeOk) errors.push(error('step-outcome'));
    if (step.outcome === 'BLOCKED' || step.outcome === 'NOT_ATTEMPTED') blocked = true;
    if (step.outcome === 'WARNING') warning = true;
    if (step.outcome === 'FLAKY') flaky = true;
    const declared = expected.get(step.stepId);
    const assertions = Array.isArray(step.assertions) ? step.assertions : [];
    const actualIds = assertions.map(x => object(x) && x.id);
    const expectedIds = Array.isArray(declared.assertionIds) ? declared.assertionIds : [];
    const recordsValid = Array.isArray(step.assertions) && new Set(actualIds).size === actualIds.length &&
      assertions.every(x => object(x) && expectedIds.includes(x.id) && typeof x.passed === 'boolean');
    const complete = recordsValid && actualIds.length === expectedIds.length;
    if (!recordsValid || (step.outcome === 'NOT_ATTEMPTED' && assertions.length > 0) ||
        (outcomeOk && !['BLOCKED', 'NOT_ATTEMPTED'].includes(step.outcome) && !complete)) errors.push(error('assertion-coverage'));
    const hasFailedAssertion = recordsValid && assertions.some(x => x.passed === false);
    if (step.outcome === 'FAIL' && !hasFailedAssertion) errors.push(error('unsubstantiated-failure'));
    if (['PASS', 'WARNING', 'FLAKY'].includes(step.outcome) && hasFailedAssertion) errors.push(error('outcome-contradiction'));
    let evidenceValid = true;
    if (step.evidence !== undefined && !Array.isArray(step.evidence)) {
      evidenceValid = false; errors.push(error('invalid-evidence'));
    }
    if (declared.evidenceRequired || (Array.isArray(step.evidence) && step.evidence.length)) {
      if (!Array.isArray(step.evidence) || step.evidence.length === 0) {
        evidenceValid = false; errors.push(error('missing-evidence'));
      }
      else for (const ref of step.evidence) {
        const file = ref && existingContained(runRoot, ref.path);
        let inSession = false;
        if (canonicalSession && file) {
          const rel = path.relative(canonicalSession, file);
          inSession = !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
        }
        if (!ref || !digestOk(ref.sha256) || !nameOk(ref.path) ||
            !ref.path.startsWith(`browser-sessions/${assignment.sessionId}/`) || !file || !inSession) {
          evidenceValid = false; errors.push(error('invalid-evidence')); continue;
        }
        try {
          if (sha256(fs.readFileSync(file)) !== ref.sha256) {
            evidenceValid = false; errors.push(error('evidence-digest'));
          }
        } catch { evidenceValid = false; errors.push(error('invalid-evidence')); }
      }
    }
    if (globalTrust && ownerOk && outcomeOk && recordsValid && evidenceValid &&
        step.outcome !== 'NOT_ATTEMPTED' && hasFailedAssertion) validatedFailures.add(step.stepId);
  }
  for (const id of expected.keys()) if (!seen.has(id)) errors.push(error('missing-step'));
  if (!object(assignment) || !object(result?.cleanup) || result.cleanup.runId !== assignment?.runId ||
      result.cleanup.attemptId !== assignment?.attemptId || result.cleanup.assignmentId !== assignment?.assignmentId ||
      result.cleanup.sessionId !== assignment?.sessionId) errors.push(error('cleanup-ownership'));
  else if (assignment.cleanupRequired && result.cleanup.status !== 'completed') errors.push(error('cleanup-failed'));
  else if (!['completed', 'failed', 'not-required'].includes(result.cleanup.status)) errors.push(error('cleanup-status'));

  const trustedFailure = [...validatedFailures].some(id => !duplicates.has(id));
  const derived = trustedFailure ? 'FAIL' : blocked ? 'BLOCKED' : flaky ? 'FLAKY' : warning ? 'WARNING' : 'PASS';
  if (result?.scenarioOutcome !== derived) errors.push(error('scenario-contradiction'));
  const summary = { total: 1, passed: derived === 'PASS' ? 1 : 0, failed: derived === 'FAIL' ? 1 : 0,
    blocked: derived === 'BLOCKED' ? 1 : 0, warnings: derived === 'WARNING' ? 1 : 0,
    flaky: derived === 'FLAKY' ? 1 : 0 };
  if (!same(result?.summary, summary)) errors.push(error('summary-contradiction'));
  const policyVerdict = trustedFailure || (warning && assignment?.policy?.warningsFailGate) ? 'FAIL'
    : blocked || (flaky && assignment?.policy?.flakyFailsGate) ? 'BLOCKED' : 'PASS';
  const policyExit = { PASS: 0, FAIL: 1, BLOCKED: 2 }[policyVerdict];
  if (result?.verdict !== policyVerdict || result?.exitCode !== policyExit) errors.push(error('verdict-exit-pair'));
  const verdict = trustedFailure ? 'FAIL' : errors.length ? 'BLOCKED' : policyVerdict;
  return { ok: errors.length === 0, verdict, exitCode: { PASS: 0, FAIL: 1, BLOCKED: 2 }[verdict],
    coverage: { required: expected.size, recorded: seen.size }, errors };
}

module.exports = { SCHEMA_VERSION, freezeAssignment, validateExecutionResult, sha256 };
