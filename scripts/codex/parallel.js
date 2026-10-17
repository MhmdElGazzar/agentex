'use strict';
// Coordinator-owned lifecycle ledger. Native delegation itself is performed by
// the Codex host's spawn_agent tool, never by a Node or CLI subprocess.
const fs = require('node:fs');
const path = require('node:path');
const browserMode = require('./browser_mode');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeNew = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const statuses = new Set(['completed', 'failed', 'cancelled', 'timed-out', 'launch-failed']);
function context(runRoot, assignmentId) {
  const root = path.resolve(runRoot);
  const custody = read(path.join(root, 'custody.json'));
  if (custody.runRoot !== root || custody.mode !== 'parallel') throw Error('parallel custody required');
  const record = custody.assignments.find(x => x.assignmentId === assignmentId);
  if (!record) throw Error('unknown assignment');
  return { root, custody, record, dir: path.join(root, 'worker-events') };
}
function gateFile(dir, assignmentId) { return path.join(dir, assignmentId + '.gate.json'); }
function requiresBrowserGate(record) { return record.browserEvidenceVersion === 2 && record.drivers.includes('browser'); }
function gate(runRoot, assignmentId, verifyBrowser = browserMode.current) {
  const { root, custody, record, dir } = context(runRoot, assignmentId);
  if (!requiresBrowserGate(record)) throw Error('browser dispatch gate requires a native browser assignment');
  if (fs.existsSync(path.join(dir, assignmentId + '.end.json'))) throw Error('assignment already terminal');
  verifyBrowser({ projectRoot: path.dirname(path.dirname(root)), sessionDir: record.sessionDir,
    sessionId: record.sessionId, requestedMode: record.browserMode });
  const event = { runId: custody.runId, assignmentId, attemptId: record.attemptId,
    sessionId: record.sessionId, browserMode: record.browserMode, verifiedAt: new Date().toISOString() };
  writeNew(gateFile(dir, assignmentId), event);
  return event;
}
function assertGate(runRoot, assignmentId) {
  const { custody, record, dir } = context(runRoot, assignmentId);
  if (!requiresBrowserGate(record)) return null;
  let event;
  try { event = read(gateFile(dir, assignmentId)); } catch { throw Error('browser dispatch gate missing'); }
  if (event.runId !== custody.runId || event.assignmentId !== assignmentId ||
      event.attemptId !== record.attemptId || event.sessionId !== record.sessionId ||
      event.browserMode !== record.browserMode || !Number.isFinite(Date.parse(event.verifiedAt)))
    throw Error('browser dispatch gate stale');
  return event;
}
function launch(runRoot, assignmentId, workerId, at = new Date().toISOString(), verifyBrowser = browserMode.current) {
  const { root, custody, record, dir } = context(runRoot, assignmentId);
  if (fs.existsSync(path.join(dir, assignmentId + '.end.json'))) throw Error('assignment already terminal');
  if (typeof workerId !== 'string' || !/^\/[\w/-]+$/.test(workerId)) throw Error('native worker identity required');
  if (!Number.isFinite(Date.parse(at))) throw Error('launch timestamp required');
  const gateEvent = assertGate(runRoot, assignmentId);
  if (gateEvent && Date.parse(at) < Date.parse(gateEvent.verifiedAt))
    throw Error('worker launch predates browser dispatch gate');
  if (requiresBrowserGate(record))
    verifyBrowser({ projectRoot: path.dirname(path.dirname(root)), sessionDir: record.sessionDir,
      sessionId: record.sessionId, requestedMode: record.browserMode });
  for (const other of custody.assignments) {
    const file = path.join(dir, other.assignmentId + '.launch.json');
    if (fs.existsSync(file) && read(file).workerId === workerId) throw Error('worker identity reused');
  }
  const active = custody.assignments.filter(x => fs.existsSync(path.join(dir, x.assignmentId + '.launch.json')) &&
    !fs.existsSync(path.join(dir, x.assignmentId + '.end.json'))).length;
  if (active >= custody.concurrency) throw Error('native concurrency ceiling reached');
  const event = { assignmentId, attemptId: record.attemptId, workerId, at };
  writeNew(path.join(dir, assignmentId + '.launch.json'), event);
  return event;
}
function finish(runRoot, assignmentId, status, at = new Date().toISOString()) {
  const { record, dir } = context(runRoot, assignmentId);
  if (!statuses.has(status) || !Number.isFinite(Date.parse(at))) throw Error('invalid worker completion');
  const launchFile = path.join(dir, assignmentId + '.launch.json');
  if (!fs.existsSync(launchFile)) {
    if (status !== 'launch-failed') throw Error('worker launch record required');
    const event = { assignmentId, attemptId: record.attemptId, workerId: null, status, at };
    writeNew(path.join(dir, assignmentId + '.end.json'), event);
    return event;
  }
  if (status === 'launch-failed') throw Error('launch-failed requires no launch record');
  const start = read(launchFile);
  if (Date.parse(at) < Date.parse(start.at)) throw Error('completion predates launch');
  // A completed worker must have submitted its result before its lifecycle closes.
  if (status === 'completed' && !fs.existsSync(record.resultFile)) throw Error('completed worker missing result');
  const event = { assignmentId, attemptId: record.attemptId, workerId: start.workerId, status, at };
  writeNew(path.join(dir, assignmentId + '.end.json'), event);
  return event;
}
function audit(runRoot, assignmentId) {
  const { record, dir } = context(runRoot, assignmentId);
  let start, end;
  const launchFile = path.join(dir, assignmentId + '.launch.json');
  if (!fs.existsSync(launchFile)) {
    try { end = read(path.join(dir, assignmentId + '.end.json')); }
    catch { return 'worker-not-launched'; }
    return end.assignmentId === assignmentId && end.attemptId === record.attemptId &&
      end.workerId === null && end.status === 'launch-failed' && Number.isFinite(Date.parse(end.at))
      ? 'worker-launch-failed' : 'worker-identity-mismatch';
  }
  try { start = read(launchFile); } catch { return 'worker-identity-mismatch'; }
  if (requiresBrowserGate(record)) {
    let gateEvent;
    try { gateEvent = assertGate(runRoot, assignmentId); }
    catch { return 'browser-dispatch-gate-missing-or-stale'; }
    if (Date.parse(gateEvent.verifiedAt) > Date.parse(start.at))
      return 'browser-dispatch-gate-after-launch';
  }
  try { end = read(path.join(dir, assignmentId + '.end.json')); } catch { return 'worker-incomplete'; }
  if (start.assignmentId !== assignmentId || end.assignmentId !== assignmentId ||
      start.attemptId !== record.attemptId || end.attemptId !== record.attemptId ||
      start.workerId !== end.workerId || !/^\/[\w/-]+$/.test(start.workerId) ||
      !Number.isFinite(Date.parse(start.at)) || !Number.isFinite(Date.parse(end.at)) ||
      Date.parse(end.at) < Date.parse(start.at)) return 'worker-identity-mismatch';
  if (end.status !== 'completed') return 'worker-' + end.status;
  if (!fs.existsSync(record.resultFile)) return 'worker-missing-result';
  return null;
}
function main(args) {
  try {
    if (args[0] === 'gate' && args.length === 3) return { output: gate(args[1], args[2]), exitCode: 0 };
    if (args[0] === 'launch' && args.length === 4) return { output: launch(args[1], args[2], args[3]), exitCode: 0 };
    if (args[0] === 'finish' && args.length === 4) return { output: finish(args[1], args[2], args[3]), exitCode: 0 };
    if (args[0] === 'audit' && args.length === 3) {
      const problem = audit(args[1], args[2]);
      return { output: { ok: !problem, problem }, exitCode: problem ? 2 : 0 };
    }
    throw Error('usage: gate <runRoot> <assignmentId> | launch <runRoot> <assignmentId> <nativeWorkerId> | finish <runRoot> <assignmentId> <status> | audit <runRoot> <assignmentId>');
  } catch (e) { return { output: { ok: false, error: e.message }, exitCode: 2 }; }
}
module.exports = { gate, assertGate, launch, finish, audit, main };
if (require.main === module) {
  const result = main(process.argv.slice(2));
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exitCode;
}
