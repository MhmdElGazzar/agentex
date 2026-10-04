'use strict';

// Provider-neutral, offline policy over an already-finalized run-summary v2.
// The older ci_gate.js launches Claude; this module deliberately never does.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STATUS_KEYS = Object.freeze({ passed: 'passed', failed: 'failed', blocked: 'blocked',
  warning: 'warnings', viewMismatch: 'viewMismatch', flaky: 'flaky', na: 'naDescoped', notrun: 'notRun' });
const COUNT_KEYS = Object.freeze([...new Set(Object.values(STATUS_KEYS))]);
const FLAKY_POLICIES = new Set(['fail', 'review', 'allow']);
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const count = value => Number.isSafeInteger(value) && value >= 0;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--summary', '--flaky-policy'].includes(key) || !value || out[key]) throw new Error('usage: --summary <run-summary.json> [--flaky-policy fail|review|allow]');
    out[key] = value;
  }
  if (!out['--summary']) throw new Error('--summary is required');
  if (out['--flaky-policy'] && !FLAKY_POLICIES.has(out['--flaky-policy'])) throw new Error('flaky policy must be fail, review, or allow');
  return { summary: out['--summary'], flakyPolicy: out['--flaky-policy'] || 'review' };
}

function checkReference(runRoot, reference) {
  if (typeof reference !== 'string' || !reference || path.posix.isAbsolute(reference) || path.win32.isAbsolute(reference)) return false;
  const normalized = reference.replace(/\\/g, '/');
  const target = path.resolve(runRoot, ...normalized.split('/'));
  if (!inside(runRoot, target)) return false;
  try { return fs.statSync(target).isFile() && inside(fs.realpathSync(runRoot), fs.realpathSync(target)); }
  catch { return false; }
}

function validateSummary(data, runRoot) {
  const errors = [];
  const add = code => { if (!errors.includes(code)) errors.push(code); };
  if (!data || data.schemaVersion !== 2 || !data.run || !data.summary ||
    !Array.isArray(data.testCases) || !Array.isArray(data.defects)) return ['invalid-summary'];
  if (!Array.isArray(data.run.sessions) || !data.run.sessions.length || !data.testCases.length) add('incomplete-run');
  const sessions = new Set();
  for (const item of Array.isArray(data.run.sessions) ? data.run.sessions : []) {
    if (!item || typeof item.session !== 'string' || !item.session || item.session === 'default') add('invalid-session');
    else if (sessions.has(item.session)) add('duplicate-session');
    else sessions.add(item.session);
  }
  const actual = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
  const covered = new Set();
  for (const item of data.testCases) {
    if (!item || typeof item.name !== 'string' || !STATUS_KEYS[item.status] || !Array.isArray(item.steps)) {
      add('invalid-test-case'); continue;
    }
    if (!sessions.has(item.session)) add('unowned-result');
    else covered.add(item.session);
    actual[STATUS_KEYS[item.status]]++;
    if (item.screenshots !== undefined && !Array.isArray(item.screenshots)) add('invalid-artifact-reference');
    for (const shot of Array.isArray(item.screenshots) ? item.screenshots : []) {
      if (!checkReference(runRoot, shot && shot.path)) add('invalid-artifact-reference');
    }
    for (const step of item.steps) {
      if (!step || typeof step.desc !== 'string' || !STATUS_KEYS[step.status]) add('invalid-test-case');
      if (step && step.evidence !== undefined && !Array.isArray(step.evidence)) add('invalid-artifact-reference');
      for (const evidence of step && Array.isArray(step.evidence) ? step.evidence : []) {
        if (!checkReference(runRoot, evidence && evidence.path)) add('invalid-artifact-reference');
      }
    }
  }
  if ([...sessions].some(session => !covered.has(session))) add('missing-result');
  if (!count(data.summary.total) || data.summary.total !== data.testCases.length) add('count-mismatch');
  for (const key of COUNT_KEYS) {
    const stated = data.summary[key] === undefined ? 0 : data.summary[key];
    if (!count(stated) || stated !== actual[key]) add('count-mismatch');
  }
  for (const defect of data.defects) {
    if (!defect || typeof defect.title !== 'string' || !['Critical', 'High', 'Medium', 'Low'].includes(defect.severity)) add('invalid-defect');
    if (defect && defect.evidence !== undefined && !Array.isArray(defect.evidence)) add('invalid-artifact-reference');
    for (const reference of defect && Array.isArray(defect.evidence) ? defect.evidence : []) {
      if (!checkReference(runRoot, reference)) add('invalid-artifact-reference');
    }
  }
  return errors;
}

function evaluate(data, { flakyPolicy = 'review', runId, sourceSha256, runRoot } = {}) {
  if (!FLAKY_POLICIES.has(flakyPolicy)) throw new Error('invalid flaky policy');
  const errors = validateSummary(data, runRoot);
  const counts = { ...Object.fromEntries(COUNT_KEYS.map(key => [key, 0])), total: 0 };
  const reasons = [];
  let decision = 'REVIEW';
  if (errors.length) {
    for (const code of errors) reasons.push({ code, category: 'integrity' });
  } else {
    for (const key of COUNT_KEYS) counts[key] = data.summary[key] || 0;
    counts.total = data.summary.total;
    if (counts.failed) reasons.push({ code: 'product-failure', category: 'product', count: counts.failed });
    if (counts.warnings) reasons.push({ code: 'product-warning', category: 'product', count: counts.warnings });
    if (counts.blocked) reasons.push({ code: 'blocked-result', category: 'infrastructure', count: counts.blocked });
    if (counts.notRun) reasons.push({ code: 'not-run', category: 'infrastructure', count: counts.notRun });
    if (counts.viewMismatch) reasons.push({ code: 'view-mismatch', category: 'review', count: counts.viewMismatch });
    if (counts.flaky) reasons.push({ code: flakyPolicy === 'allow' ? 'flaky-allowed' : 'flaky-disallowed',
      category: 'instability', count: counts.flaky });
    decision = counts.failed || counts.warnings || (counts.flaky && flakyPolicy === 'fail') ? 'FAIL'
      : counts.blocked || counts.notRun || counts.viewMismatch || (counts.flaky && flakyPolicy === 'review') ? 'REVIEW' : 'PASS';
  }
  const exitCode = decision === 'PASS' ? 0 : decision === 'FAIL' ? 1 : 2;
  return { schemaVersion: 1, runId, decision, exitCode, counts, reasons,
    policy: { flakyPolicy, warningsFail: true }, sourceSummary: 'run-summary.json', sourceSha256,
    approval: { requiresHumanReview: decision === 'REVIEW' || (decision === 'FAIL' && reasons.some(r => r.category === 'infrastructure')),
      releaseBlocked: decision !== 'PASS' } };
}

function atomicCreate(file, body) {
  const temporary = path.join(path.dirname(file), `.gate-result-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, body);
    fs.fsyncSync(handle);
    fs.closeSync(handle); handle = undefined;
    fs.linkSync(temporary, file); // atomic, exclusive publication; never replace an earlier decision
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function runGate(summaryPath, flakyPolicy = 'review') {
  const file = path.resolve(summaryPath);
  if (path.basename(file) !== 'run-summary.json' || !/^execu_[a-zA-Z0-9._-]+$/.test(path.basename(path.dirname(file)))) {
    throw new Error('summary must be run-summary.json inside an execu_* run directory');
  }
  const runRoot = path.dirname(file);
  let raw, data;
  try { raw = fs.readFileSync(file); data = JSON.parse(raw.toString('utf8')); }
  catch { data = null; }
  const result = evaluate(data, { flakyPolicy, runId: path.basename(runRoot),
    sourceSha256: raw ? crypto.createHash('sha256').update(raw).digest('hex') : null, runRoot });
  atomicCreate(path.join(runRoot, 'gate-result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (require.main === module) {
  try {
    const { summary, flakyPolicy } = parseArgs(process.argv.slice(2));
    const result = runGate(summary, flakyPolicy);
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    // No source text, paths, or configuration values are copied into diagnostics.
    console.log(JSON.stringify({ schemaVersion: 1, decision: 'REVIEW', exitCode: 2,
      reasons: [{ code: error.code === 'EEXIST' ? 'gate-result-exists' : 'gate-invocation-invalid', category: 'integrity' }],
      approval: { requiresHumanReview: true, releaseBlocked: true } }));
    process.exitCode = 2;
  }
}

module.exports = { parseArgs, validateSummary, evaluate, atomicCreate, runGate };
