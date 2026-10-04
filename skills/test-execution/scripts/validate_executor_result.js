'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATUSES = new Set(['passed', 'failed', 'blocked', 'warning', 'viewMismatch', 'flaky']);
const SCENARIO_STATUSES = new Set([...STATUSES, 'na', 'notrun']);
const FAILURE_KINDS = new Set(['product', 'infrastructure', 'automation']);

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function evidencePath(runRoot, sessionRoot, value) {
  if (typeof value !== 'string' || !value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  const normalized = value.replace(/\\/g, '/');
  const absolute = path.resolve(runRoot, ...normalized.split('/'));
  if (!inside(sessionRoot, absolute) || !fs.existsSync(absolute)) return null;
  try {
    if (!inside(fs.realpathSync(sessionRoot), fs.realpathSync(absolute))) return null;
  } catch { return null; }
  return { relative: normalized, absolute };
}

function validate(result, cwd = process.cwd()) {
  const errors = [];
  const need = (condition, message) => { if (!condition) errors.push(message); };
  need(result && result.schemaVersion === 1, 'schemaVersion must be 1');
  if (!result || typeof result !== 'object') return errors;
  need(typeof result.runDir === 'string' && /^executions[\\/]execu_[^\\/]+$/.test(result.runDir), 'invalid runDir');
  need(typeof result.session === 'string' && result.session !== 'default' && /^[a-z0-9._-]+$/.test(result.session), 'invalid session');
  need(typeof result.spec === 'string' && result.spec.length > 0, 'spec is required');
  need(STATUSES.has(result.status), 'invalid status');
  need(typeof result.startedAt === 'string' && typeof result.endedAt === 'string'
    && !Number.isNaN(Date.parse(result.startedAt)) && !Number.isNaN(Date.parse(result.endedAt)), 'timestamps are required');
  need(Number.isInteger(result.durationMs) && result.durationMs >= 0, 'durationMs must be nonnegative integer');
  need(Array.isArray(result.scenarios), 'scenarios must be an array');
  need(Array.isArray(result.defects), 'defects must be an array');
  need(Array.isArray(result.failures), 'failures must be an array');
  need(result.cleanup && result.cleanup.attempted === true && typeof result.cleanup.closed === 'boolean', 'cleanup outcome is required');
  if (errors.length) return errors;
  const runRoot = path.resolve(cwd, result.runDir);
  const sessionRoot = path.join(runRoot, 'browser-sessions', result.session);
  const evidence = [];
  for (const [index, scenario] of result.scenarios.entries()) {
    need(scenario && typeof scenario === 'object' && typeof scenario.name === 'string' && SCENARIO_STATUSES.has(scenario.status), `scenario ${index} name/status invalid`);
    need(scenario && scenario.session === result.session, `scenario ${index} session mismatch`);
    need(scenario && Array.isArray(scenario.steps), `scenario ${index} steps missing`);
    if (!scenario || !Array.isArray(scenario.steps)) continue;
    need(scenario.screenshots === undefined || Array.isArray(scenario.screenshots), `scenario ${index} screenshots invalid`);
    for (const shot of Array.isArray(scenario.screenshots) ? scenario.screenshots : []) {
      need(shot && typeof shot.path === 'string', `scenario ${index} screenshot invalid`);
      if (shot) evidence.push(shot.path);
    }
    for (const [stepIndex, step] of scenario.steps.entries()) {
      need(step && typeof step.desc === 'string' && SCENARIO_STATUSES.has(step.status), `scenario ${index} step ${stepIndex} invalid`);
      need(step && (step.evidence === undefined || Array.isArray(step.evidence)), `scenario ${index} step ${stepIndex} evidence invalid`);
      for (const item of step && Array.isArray(step.evidence) ? step.evidence : []) {
        need(item && typeof item.path === 'string', `scenario ${index} step ${stepIndex} evidence item invalid`);
        if (item) evidence.push(item.path);
      }
    }
  }
  for (const [index, defect] of result.defects.entries()) {
    need(defect && typeof defect.title === 'string' && ['Critical', 'High', 'Medium', 'Low'].includes(defect.severity), `defect ${index} invalid`);
    need(defect && (defect.evidence === undefined || Array.isArray(defect.evidence)), `defect ${index} evidence invalid`);
    for (const item of defect && Array.isArray(defect.evidence) ? defect.evidence : []) evidence.push(item);
  }
  for (const [index, failure] of result.failures.entries()) {
    need(failure && FAILURE_KINDS.has(failure.kind) && typeof failure.detail === 'string', `failure ${index} invalid`);
  }
  for (const item of evidence) {
    const p = typeof item === 'string' ? item : null;
    const normalized = p && p.replace(/\\/g, '/');
    const absolute = normalized && !path.posix.isAbsolute(normalized) && !path.win32.isAbsolute(p)
      ? path.resolve(runRoot, ...normalized.split('/')) : null;
    need(Boolean(absolute && inside(sessionRoot, absolute)), `evidence outside assigned session: ${String(p)}`);
    if (absolute && inside(sessionRoot, absolute)) {
      need(Boolean(evidencePath(runRoot, sessionRoot, p)), `evidence missing or escapes assigned session: ${p}`);
    }
  }
  if (result.cleanup.closed === false) need(result.cleanup.error && typeof result.cleanup.error === 'string', 'cleanup error is required when close failed');
  if (result.cleanup.closed === false) need(result.status !== 'passed', 'passed result cannot have failed cleanup');
  if (result.status === 'passed') {
    need(result.scenarios.length > 0 && result.scenarios.every((s) => s && s.status === 'passed'), 'passed result requires passing scenarios');
    need(result.defects.length === 0 && result.failures.length === 0, 'passed result cannot contain defects or failures');
  }
  return errors;
}

if (require.main === module) {
  const file = process.argv[2];
  try {
    if (!file) throw new Error('usage: node validate_executor_result.js <sessionDir/executor-result.json>');
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expected = path.resolve(process.cwd(), result.runDir || '', 'browser-sessions', result.session || '', 'executor-result.json');
    const errors = path.resolve(file) === expected ? validate(result) : ['result path does not match assigned session'];
    console.log(JSON.stringify({ ok: errors.length === 0, errors }));
    process.exitCode = errors.length ? 2 : 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, errors: [error.message] }));
    process.exitCode = 2;
  }
}

module.exports = { validate, evidencePath };
