'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const modes = new Set(['HEADLESS', 'HEADED']);
const evidenceFile = sessionDir => path.join(sessionDir, 'logs', 'browser-mode.json');
const actionsFile = sessionDir => path.join(sessionDir, 'logs', 'browser-actions.jsonl');
const closeFile = sessionDir => path.join(sessionDir, 'logs', 'browser-close.jsonl');
const append = (file, value) => fs.appendFileSync(file, JSON.stringify(value) + '\n');
const readLines = file => fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
// Application output can contain secrets. Retain process status and a digest, not raw output.
const diagnostic = result => ({ exitStatus: result?.status ?? null,
  errorCode: result?.error?.code || null,
  stderrSha256: result?.stderr ? crypto.createHash('sha256').update(result.stderr).digest('hex') : null });
const fault = (code, message, result) => Object.assign(new Error(message), { code, safe: true, result });
const safeReason = error => error?.safe ? error.message : 'browser operation threw';
const failure = (error, phase, result) => ({ phase, failureCode: error?.safe ? error.code : 'operation-threw',
  reason: safeReason(error), ...diagnostic(result || error?.result), at: new Date().toISOString() });
const invoke = (args, cwd) => process.platform === 'win32'
  ? spawnSync(process.execPath, [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    '--no-install', 'playwright-cli', ...args], { cwd, encoding: 'utf8', windowsHide: true })
  : spawnSync('npx', ['--no-install', 'playwright-cli', ...args], { cwd, encoding: 'utf8' });

function parseList(output) {
  const start = output.indexOf('{');
  if (start < 0) throw fault('session-metadata-missing', 'CLI session metadata is missing');
  let parsed;
  try { parsed = JSON.parse(output.slice(start)); }
  catch { throw fault('session-metadata-invalid', 'CLI session metadata is invalid'); }
  if (!parsed || !Array.isArray(parsed.browsers)) throw fault('session-list-missing', 'CLI browser list is missing');
  return parsed.browsers;
}
function parseOpen(output, sessionId) {
  const start = output.indexOf('{');
  if (start < 0) throw fault('launch-metadata-missing', 'CLI launch metadata is missing');
  let opened;
  try { opened = JSON.parse(output.slice(start)); }
  catch { throw fault('launch-metadata-invalid', 'CLI launch metadata is invalid'); }
  if (!opened || opened.session !== sessionId || !Number.isSafeInteger(opened.pid) || opened.pid < 1)
    throw fault('launch-identity-mismatch', 'CLI launch identity mismatch');
  return opened.pid;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}
function list(runner, cwd) {
  let result;
  try { result = runner(['list', '--json'], cwd); }
  catch { throw fault('session-list-threw', 'CLI session list threw'); }
  if (result.error || result.status !== 0)
    throw fault('session-list-failed', 'CLI session list failed', result);
  return parseList(result.stdout || '');
}
function verify(browsers, sessionId, requestedMode, launchedPid) {
  const matches = browsers.filter(browser => browser.name === sessionId);
  if (matches.length !== 1) return { verified: false,
    reason: matches.length ? 'duplicate-owned-session-metadata' : 'owned-session-metadata-missing' };
  const browser = matches[0];
  if (browser.status !== 'open') return { verified: false, reason: 'owned-session-not-open' };
  if (browser.attached) return { verified: false, reason: 'attached-session-is-not-owned' };
  // The CLI reports the default Chromium engine as the Chrome channel.
  if (!['chrome', 'chromium'].includes(browser.browserType))
    return { verified: false, reason: 'owned-session-not-chromium' };
  if (typeof browser.headed !== 'boolean')
    return { verified: false, reason: 'browser-mode-metadata-missing' };
  // Some CLI versions expose a process ID in list metadata. Bind it when available.
  const listedPid = browser.pid ?? browser.processId;
  if (listedPid !== undefined && launchedPid !== undefined && listedPid !== launchedPid)
    return { verified: false, reason: 'owned-session-pid-mismatch' };
  const actualMode = browser.headed ? 'HEADED' : 'HEADLESS';
  return { verified: actualMode === requestedMode, actualMode,
    reason: actualMode === requestedMode ? null : `browser-mode-mismatch: requested ${requestedMode}, actual ${actualMode}` };
}

function preflight({ projectRoot, runId, assignmentId, sessionDir, sessionId, requestedMode, runner = invoke, isAlive = alive }) {
  if (!modes.has(requestedMode)) throw Error('invalid requested browser mode');
  if (!/^codex-[0-9a-f-]{36}$/.test(sessionId) || path.basename(sessionDir) !== sessionId)
    throw Error('owned session identity required');
  const file = evidenceFile(sessionDir);
  if (fs.existsSync(file)) throw Error('browser mode preflight already recorded');
  let launched = false, launchAttempted = false, phase = 'initial-list';
  const record = { runId, assignmentId, sessionId, requestedMode, actualMode: null, verified: false,
    reason: null, observedSessions: [], verifiedAt: null };
  try {
    if (list(runner, projectRoot).some(browser => browser.name === sessionId))
      throw fault('session-already-exists', 'allocated session ID already exists');
    const args = [`-s=${sessionId}`, 'open', 'about:blank', ...(requestedMode === 'HEADED' ? ['--headed'] : []), '--json'];
    launchAttempted = true;
    phase = 'launch';
    const opened = runner(args, projectRoot);
    record.launch = diagnostic(opened);
    launched = !opened.error && opened.status === 0;
    if (!launched) throw fault('browser-launch-failed', 'browser launch failed', opened);
    record.launchedPid = parseOpen(opened.stdout || '', sessionId);
    phase = 'mode-verification';
    record.observedSessions = list(runner, projectRoot);
    Object.assign(record, verify(record.observedSessions, sessionId, requestedMode, record.launchedPid));
    if (!record.verified) throw fault(record.reason.split(':')[0], record.reason);
    if (record.verified) record.verifiedAt = new Date().toISOString();
  } catch (e) { record.reason = safeReason(e); record.failure = { operation: 'preflight', ...failure(e, phase) }; }
  finally {
    if (launchAttempted && !launched) {
      // A failed open may still have started something. Without launch identity it is unsafe to close by name.
      record.cleanup = { runId, assignmentId, sessionId, operation: 'close', status: 'unresolved',
        ...failure(fault('launch-identity-unconfirmed', 'launch identity unconfirmed'), 'cleanup-ownership') };
      try { record.observedAfterFailure = list(runner, projectRoot).filter(browser => browser.name === sessionId); }
      catch (e) { record.observationFailure = failure(e, 'post-launch-observation'); }
    }
    if (!record.verified && launched) {
      record.cleanup = { runId, assignmentId, sessionId, operation: 'close', status: 'unresolved' };
      try {
        // A name alone cannot distinguish the launched session from a replacement.
        const matches = list(runner, projectRoot).filter(browser => browser.name === sessionId);
        const owned = matches.length === 1 && matches[0].status === 'open' && !matches[0].attached &&
          (matches[0].pid ?? matches[0].processId) === record.launchedPid &&
          Number.isSafeInteger(record.launchedPid) && isAlive(record.launchedPid);
        if (!owned) throw fault('cleanup-ownership-unconfirmed', 'cleanup ownership unconfirmed');
        record.cleanup.attemptedAt = new Date().toISOString();
        const closed = runner([`-s=${sessionId}`, 'close'], projectRoot);
        record.cleanup = { ...record.cleanup, ...diagnostic(closed) };
        if (closed.error || closed.status !== 0)
          throw fault('preflight-close-failed', 'preflight close command failed', closed);
        if (list(runner, projectRoot).some(browser => browser.name === sessionId))
          throw fault('preflight-close-unverified', 'preflight close verification failed');
        record.cleanup = { ...record.cleanup, status: 'completed', verifiedAt: new Date().toISOString() };
      } catch (e) {
        record.cleanup = { ...record.cleanup, status: record.cleanup.attemptedAt ? 'failed' : 'unresolved',
          ...failure(e, record.cleanup.attemptedAt ? 'cleanup-verification' : 'cleanup-ownership') };
      }
    }
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  }
  return record;
}

function current({ projectRoot, sessionDir, sessionId, requestedMode, runner = invoke, isAlive = alive }) {
  let record;
  try { record = JSON.parse(fs.readFileSync(evidenceFile(sessionDir), 'utf8')); }
  catch { throw fault('preflight-missing', 'browser mode preflight missing'); }
  if (record.sessionId !== sessionId || record.requestedMode !== requestedMode || record.verified !== true ||
      !Number.isSafeInteger(record.launchedPid) || record.launchedPid < 1 ||
      !Number.isFinite(Date.parse(record.verifiedAt)))
    throw fault('preflight-stale', 'browser mode preflight failed or stale');
  if (!isAlive(record.launchedPid)) throw fault('launch-not-running', 'verified browser launch is no longer running');
  const observed = verify(list(runner, projectRoot), sessionId, requestedMode, record.launchedPid);
  if (!observed.verified) throw fault(observed.reason.split(':')[0], observed.reason);
  return record;
}

function command(context, args) {
  if (!Array.isArray(args) || !args.length || !/^[a-z][a-z-]*$/.test(args[0]) ||
      args.some(arg => typeof arg !== 'string' || /^(-s(=|$)|--session(=|$))/.test(arg)) ||
      ['open', 'attach', 'close', 'close-all', 'kill-all', 'delete-data', 'detach'].includes(args[0]))
    throw Error('browser command is not allowed through the verified session');
  const { projectRoot, sessionDir, sessionId, runner = invoke } = context;
  let recordedPid = null;
  try { recordedPid = JSON.parse(fs.readFileSync(evidenceFile(sessionDir), 'utf8')).launchedPid; }
  catch { /* Failed pre-action verification is recorded below. */ }
  const action = { actionId: crypto.randomUUID(), runId: context.runId,
    assignmentId: context.assignmentId, sessionId,
    launchedPid: recordedPid, command: args[0], operation: 'browser-command', at: new Date().toISOString() };
  append(actionsFile(sessionDir), { ...action, status: 'attempted' });
  let result, record, phase = 'pre-action-verification';
  try {
    record = current(context);
    action.launchedPid = record.launchedPid;
    phase = 'cli-execution';
    result = runner([`-s=${sessionId}`, ...args], projectRoot);
    if (result.error || result.status !== 0)
      throw fault('browser-command-failed', 'browser command failed', result);
    phase = 'post-action-verification';
    current(context);
    append(actionsFile(sessionDir), { ...action, status: 'succeeded', completedAt: new Date().toISOString() });
  } catch (e) {
    append(actionsFile(sessionDir), { ...action, status: 'failed', completedAt: new Date().toISOString(),
      ...failure(e, phase, result) });
    throw fault(e?.safe ? e.code : 'browser-command-threw', safeReason(e));
  }
  return { sessionId, launchedPid: record.launchedPid, output: result.stdout };
}
function close(context) {
  const { projectRoot, sessionDir, sessionId, runner = invoke } = context;
  const attempt = { runId: context.runId, assignmentId: context.assignmentId,
    sessionId, operation: 'close', attemptedAt: new Date().toISOString() };
  append(closeFile(sessionDir), { ...attempt, status: 'attempted' });
  let result, launchedPid, phase = 'pre-close-verification';
  try {
    launchedPid = current(context).launchedPid;
    phase = 'close-command';
    result = runner([`-s=${sessionId}`, 'close'], projectRoot);
    if (result.error || result.status !== 0)
      throw fault('browser-close-failed', 'owned browser close failed', result);
    phase = 'close-verification';
    if (list(runner, projectRoot).some(browser => browser.name === sessionId))
      throw fault('browser-remains-open', 'owned browser remains open after close');
    append(closeFile(sessionDir), { ...attempt, launchedPid, ...diagnostic(result),
      verifiedAt: new Date().toISOString(), status: 'completed' });
    return { sessionId, status: 'completed' };
  } catch (e) {
    append(closeFile(sessionDir), { ...attempt, launchedPid: launchedPid || null,
      status: 'failed', ...failure(e, phase, result) });
    throw fault(e?.safe ? e.code : 'browser-close-threw', safeReason(e));
  }
}
function audit(sessionDir, sessionId, requestedMode, assignmentId, ownership = {}) {
  let record, actions, closes;
  try {
    record = JSON.parse(fs.readFileSync(evidenceFile(sessionDir), 'utf8'));
    actions = readLines(actionsFile(sessionDir));
    closes = readLines(closeFile(sessionDir));
  } catch { return 'browser mode, action, or cleanup evidence missing'; }
  if (record.runId !== ownership.runId || record.sessionId !== sessionId ||
      !ownership.closeOwners?.includes(record.assignmentId) ||
      record.requestedMode !== requestedMode || record.actualMode !== requestedMode ||
      record.verified !== true ||
      !Number.isSafeInteger(record.launchedPid) || record.launchedPid < 1 ||
      !Number.isFinite(Date.parse(record.verifiedAt)) ||
      !verify(record.observedSessions || [], sessionId, requestedMode, record.launchedPid).verified)
    return record.reason || 'browser mode preflight failed or stale';
  const verifiedAt = Date.parse(record.verifiedAt);
  if (!actions.some(action => action.assignmentId === assignmentId && action.status === 'succeeded') ||
      actions.some(action => action.runId !== ownership.runId || action.sessionId !== sessionId ||
      !ownership.closeOwners?.includes(action.assignmentId) ||
      action.launchedPid !== record.launchedPid || !['attempted', 'succeeded', 'failed'].includes(action.status) ||
      !Number.isFinite(Date.parse(action.at)) || Date.parse(action.at) < verifiedAt ||
      (action.status !== 'attempted' && (!Number.isFinite(Date.parse(action.completedAt)) ||
        Date.parse(action.completedAt) < Date.parse(action.at)))))
    return 'verified browser action evidence missing or stale';
  const attempts = actions.filter(action => action.status === 'attempted');
  if (new Set(attempts.map(attempt => attempt.actionId)).size !== attempts.length ||
      attempts.some(attempt => actions.filter(action => action.actionId === attempt.actionId &&
        action.status !== 'attempted').length !== 1) ||
      actions.some(action => action.status !== 'attempted' &&
        !attempts.some(attempt => attempt.actionId === action.actionId &&
          attempt.assignmentId === action.assignmentId && attempt.command === action.command)))
    return 'browser action attempt has no outcome';
  if (actions.some(action => action.status === 'failed')) return 'guarded browser action failed';
  const closed = closes.at(-1);
  if (closes.length !== 2 || closes[0].status !== 'attempted' ||
      closes.some(event => event.runId !== ownership.runId || event.sessionId !== sessionId ||
        !ownership.closeOwners?.includes(event.assignmentId)) ||
      !closed || closed.status !== 'completed' || closed.exitStatus !== 0 ||
      closed.assignmentId !== closes[0].assignmentId ||
      !Number.isFinite(Date.parse(closed.attemptedAt)) ||
      closed.attemptedAt !== closes[0].attemptedAt ||
      Date.parse(closed.attemptedAt) < Math.max(...actions.map(action => Date.parse(action.completedAt || action.at))) ||
      closed.runId !== ownership.runId ||
      !ownership.closeOwners?.includes(closed.assignmentId) || closed.sessionId !== sessionId ||
      closed.launchedPid !== record.launchedPid || !Number.isFinite(Date.parse(closed.verifiedAt)) ||
      Date.parse(closed.verifiedAt) < Date.parse(closed.attemptedAt))
    return 'verified browser cleanup evidence missing or failed';
  return null;
}

module.exports = { preflight, current, command, close, audit, verify,
  evidenceFile, actionsFile, closeFile, parseList, parseOpen };
